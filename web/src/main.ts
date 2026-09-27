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
      // Not extracted and no job id: maybe a job is running for it.
      const { jobs } = await api.repos();
      job = jobs.find((j) => j.repo === repo && j.state === "running")?.id;
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
  } catch (e) {
    root.replaceChildren(h("main", { class: "loading-box" }, h("h1", { text: repo, style: "font-size:20px" }), h("div", { class: "err", text: e instanceof Error ? e.message : String(e) }), h("a", { class: "btn", href: "#/", text: "All repositories" })));
  }
}

window.addEventListener("hashchange", route);
void route();
