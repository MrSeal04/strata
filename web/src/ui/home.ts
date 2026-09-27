import { ApiError, type JobStatus, api } from "../api/client";
import { fmt, h } from "./dom";

/** Repo picker: cached repos plus an "add path or URL" box. */
export async function renderHome(root: HTMLElement) {
  const input = h("input", { type: "text", placeholder: "~/Projects/myrepo, https://github.com/org/repo or ssh://…", "aria-label": "Repository path or URL" });
  const add = h("button", { class: "btn primary", text: "Analyze" });
  const err = h("div", { class: "err" });
  const list = h("div", { class: "repos" });
  const submit = async () => {
    const src = input.value.trim();
    if (!src) return;
    err.textContent = "";
    try {
      const job = await api.addRepo(src);
      location.hash = `#/r/${encodeURIComponent(job.repo)}?job=${job.id}`;
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : String(e);
    }
  };
  add.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  root.replaceChildren(
    h("main", { class: "home" },
      h("h1", { text: "strata" }),
      h("div", { class: "muted", text: "How a repository grew: every commit's additions and deletions, played back." }),
      h("div", { class: "add" }, input, add),
      err,
      list,
    ),
  );
  input.focus();
  try {
    const { repos, jobs } = await api.repos();
    const running = jobs.filter((j) => j.state === "running");
    list.replaceChildren(
      ...running.map((j) => h("a", { class: "repo-card", href: `#/r/${encodeURIComponent(j.repo)}?job=${j.id}` },
        h("div", { class: "n", text: j.repo }),
        h("div", { class: "s", text: `extracting… ${j.progress.phase} ${j.progress.total ? `${Math.round((100 * j.progress.done) / j.progress.total)}%` : ""}` }),
      )),
      ...repos.map((r) => h("a", { class: "repo-card", href: `#/r/${encodeURIComponent(r.id)}` },
        h("div", { class: "n", text: r.name }),
        h("div", { class: "s", text: r.source.kind === "path" ? r.source.path : r.source.url }),
        h("div", { class: "s", text: `${fmt.int(r.steps)} commits on ${r.branch} · ${fmt.date(r.first_time)} → ${fmt.date(r.last_time)}` }),
      )),
    );
    if (!repos.length && !running.length) list.append(h("div", { class: "muted", text: "No repositories analyzed yet. Paste a path or URL above." }));
  } catch (e) {
    err.textContent = e instanceof ApiError ? e.message : "Could not reach the strata server.";
  }
}

/** Show extraction progress until the job finishes; resolves true when the repo is ready. */
export function renderLoading(root: HTMLElement, jobId: string, repo: string): Promise<boolean> {
  const phase = h("div", { class: "ink2" });
  const fill = h("div", { class: "bar-fill" });
  const detail = h("div", { class: "muted num" });
  const err = h("div", { class: "err" });
  const cancel = h("button", { class: "btn", text: "Cancel" });
  cancel.addEventListener("click", () => api.cancelJob(jobId).catch(() => {}));
  root.replaceChildren(
    h("main", { class: "loading-box" },
      h("h1", { text: repo, style: "font-size:20px;margin:0 0 4px" }),
      phase,
      h("div", { class: "bar-track" }, fill),
      detail,
      err,
      h("div", { style: "margin-top:16px;display:flex;gap:8px" }, cancel, h("a", { class: "btn", href: "#/", text: "All repositories" })),
    ),
  );
  return new Promise((resolve) => {
    const es = api.jobEvents(jobId);
    const show = (j: JobStatus) => {
      const p = j.progress;
      const pct = p.total ? (100 * p.done) / p.total : 0;
      fill.style.width = `${pct.toFixed(1)}%`;
      const names: Record<string, string> = { queued: "Queued", clone: "Cloning", walk: "Walking history", reindex: "Reindexing", diff: "Diffing commits", finish: "Writing tables" };
      phase.textContent = names[p.phase] ?? p.phase;
      detail.textContent = p.message ?? (p.total ? `${fmt.int(p.done)} / ${fmt.int(p.total)} commits · ${fmt.int(p.steps_per_sec)}/s${p.eta_secs ? ` · about ${Math.ceil(p.eta_secs)}s left` : ""}` : "");
      if (j.state === "done") {
        es.close();
        resolve(true);
      } else if (j.state === "failed" || j.state === "cancelled") {
        es.close();
        err.textContent = j.state === "failed" ? `Extraction failed:\n${j.error ?? ""}` : "Cancelled.";
        cancel.remove();
        resolve(false);
      }
    };
    es.onmessage = (e) => show(JSON.parse(e.data) as JobStatus);
    es.onerror = () => {
      // The stream ends when the job is done; confirm by polling once.
      api.job(jobId).then(show).catch(() => {});
    };
  });
}
