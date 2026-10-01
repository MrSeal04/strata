import "./style.css";
import { api } from "./api/client";
import { type Dashboard, openDashboard } from "./ui/dashboard";
import { h } from "./ui/dom";
import { renderHome, renderLoading } from "./ui/home";

const root = document.getElementById("app")!;
let current: Dashboard | null = null;
let routeGen = 0;

async function route() {
  const gen = ++routeGen;
  current?.destroy();
  current = null;
  const hash = location.hash.replace(/^#/, "") || "/";
  const m = hash.match(/^\/r\/([^?]+)(?:\?job=(\w+))?/);
  const renderToken = new URLSearchParams(location.search).get("render");
  if (!m) {
    await renderHome(root);
    return;
  }
  const repo = decodeURIComponent(m[1]);
  let job: string | undefined = m[2];
  try {
    const meta = await api.meta(repo).catch(() => null);
    if (!job && meta?.job?.state === "running") job = meta.job.id;
    if (!job && !meta) {
      // Not extracted and no job id: show its latest job, which may already have stopped (a
      // remote asking for a login fails before the browser opens).
      const { jobs } = await api.repos();
      const num = (id: string) => Number(id.replace(/\D/g, ""));
      job = jobs.filter((j) => j.repo === repo && j.state !== "done").sort((a, b) => num(b.id) - num(a.id))[0]?.id;
    }
    if (job) {
      const ok = await renderLoading(root, job, repo);
      if (!ok || gen !== routeGen) return;
      history.replaceState(null, "", `#/r/${encodeURIComponent(repo)}`);
    }
    const d = await openDashboard(root, repo);
    if (gen !== routeGen) {
      d.destroy();
      return;
    }
    current = d;
    (window as unknown as { strata: Dashboard }).strata = d;
    if (renderToken) {
      const { runHeadlessRender } = await import("./export/video");
      await runHeadlessRender(d, renderToken);
    }
  } catch (e) {
    root.replaceChildren(h("main", { class: "loading-box" }, h("h1", { text: repo, style: "font-size:20px" }), h("div", { class: "err", text: e instanceof Error ? e.message : String(e) }), h("a", { class: "btn", href: "#/", text: "All repositories" })));
  }
}

window.addEventListener("hashchange", route);
void route();

// Tell the server a page is open: started from the app launcher, it stops once none has been
// for a while. Browsers may run a hidden tab's timers only once a minute.
const ping = () => fetch("/api/ping").catch(() => {});
setInterval(ping, 60_000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void ping();
});
