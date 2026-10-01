import { ApiError, type CachedRepo, type JobStatus, type RepoSource, api } from "../api/client";
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
  const empty = h("div", { class: "muted", style: "grid-column: 1 / -1", text: "No repositories analyzed yet. Paste a path or URL above." });
  const onRemoved = () => {
    if (!list.querySelector(".repo-card")) list.replaceChildren(empty);
  };
  try {
    const { repos, jobs } = await api.repos();
    const running = jobs.filter((j) => j.state === "running");
    const cached = new Set(repos.map((r) => r.id));
    list.replaceChildren(
      // First extractions; a cached repo shows its own update on its card.
      ...running.filter((j) => !cached.has(j.repo)).map((j) => h("a", { class: "repo-card", href: `#/r/${encodeURIComponent(j.repo)}?job=${j.id}` },
        h("div", { class: "n", text: j.repo }),
        h("div", { class: "s", text: `extracting… ${j.progress.phase} ${j.progress.total ? `${Math.round((100 * j.progress.done) / j.progress.total)}%` : ""}` }),
      )),
      ...repos.map((r) => repoCard(r, running.find((j) => j.repo === r.id), onRemoved)),
    );
    onRemoved();
  } catch (e) {
    err.textContent = e instanceof ApiError ? e.message : "Could not reach the strata server.";
  }
}

/** A cached repo: opens its dashboard, and updates or deletes it in place. `job`: its running
 * update, if any. */
function repoCard(r: CachedRepo, job: JobStatus | undefined, onRemoved: () => void, note = ""): HTMLElement {
  const href = `#/r/${encodeURIComponent(r.id)}`;
  const status = h("div", { class: "s" });
  const actions = h("div", { class: "actions" });
  const card = h("div", { class: "repo-card", "data-repo": r.id },
    h("a", { class: "open", href, "aria-label": `Open ${r.name}` }, h("div", { class: "n", text: r.name })),
    h("div", { class: "s", text: sourceText(r.source) }),
    h("div", { class: "s", text: `${fmt.int(r.steps)} commits on ${r.branch} · ${fmt.date(r.first_time)} → ${fmt.date(r.last_time)}` }),
    h("div", { class: "foot" }, status, actions),
  );
  const btn = (text: string, onclick: () => void, cls = "btn") => h("button", { class: cls, type: "button", text, onclick });
  const showError = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    // git's output can run long: the card shows its first line, the tooltip all of it.
    status.replaceChildren(h("span", { class: "err", text: msg.split("\n")[0], title: msg }));
  };

  const idle = (msg = "") => {
    const ago = fmt.ago(Date.now() / 1000 - r.updated_at);
    status.textContent = msg || `${ago === "today" ? "updated today" : `updated ${ago} ago`} · ${bytes(r.disk_bytes)}`;
    const update = btn("Update", () => {
      update.disabled = true;
      api.updateRepo(r.id).then(follow, (e) => {
        idle();
        showError(e);
      });
    });
    actions.replaceChildren(update, btn("Delete", confirmDelete));
  };

  const confirmDelete = () => {
    const what = r.source.kind === "url" ? "the cached data and the clone" : "the cached data; the repository itself stays";
    status.textContent = `Delete ${what}? Frees ${bytes(r.disk_bytes)}.`;
    const yes = btn("Delete", async () => {
      yes.disabled = true;
      try {
        await api.deleteRepo(r.id);
        card.remove();
        onRemoved();
      } catch (e) {
        idle();
        showError(e);
      }
    }, "btn danger");
    actions.replaceChildren(yes, btn("Cancel", () => idle()));
    yes.focus();
  };

  /** Show the update's progress until it stops, then refresh the card. */
  const follow = (j: JobStatus) => {
    const fill = h("div", { class: "bar-fill" });
    status.replaceChildren(h("div", { class: "bar-track" }, fill), h("span", { class: "num" }));
    const label = status.lastChild as HTMLElement;
    actions.replaceChildren(btn("Cancel", () => api.cancelJob(j.id).catch(() => {})));
    const es = api.jobEvents(j.id);
    const show = (j: JobStatus) => {
      if (!card.isConnected) return es.close();
      const p = j.progress;
      fill.style.width = `${p.total ? ((100 * p.done) / p.total).toFixed(1) : 0}%`;
      // git reports a fetch as the "clone" phase; a cached repo's clone already exists.
      const phase = p.phase === "clone" ? "Fetching" : (PHASES[p.phase] ?? p.phase);
      const left = p.eta_secs ? `about ${p.eta_secs < 90 ? `${Math.ceil(p.eta_secs)}s` : `${Math.ceil(p.eta_secs / 60)} min`} left` : "";
      label.textContent = [phase, p.total ? `${Math.floor((100 * p.done) / p.total)}%` : "", left].filter(Boolean).join(" · ");
      if (j.state === "running") return;
      es.close();
      if (j.state === "credentials" || j.state === "failed") {
        // The loading page asks for the login, or shows the whole error.
        if (j.state === "credentials") location.hash = `${href}?job=${j.id}`;
        else {
          idle();
          showError(j.error ?? "Update failed");
        }
        return;
      }
      api.repos().then(({ repos }) => {
        const next = repos.find((x) => x.id === r.id);
        if (!next) return card.remove(), onRemoved();
        const added = next.steps - r.steps;
        const msg = j.state === "cancelled" ? "Update cancelled" : added > 0 ? `${fmt.int(added)} new commit${added === 1 ? "" : "s"}` : "Already up to date";
        card.replaceWith(repoCard(next, undefined, onRemoved, msg));
      }, showError);
    };
    es.onmessage = (e) => show(JSON.parse(e.data) as JobStatus);
    es.onerror = () => {
      // The stream ends when the job is done; confirm by polling once.
      api.job(j.id).then(show).catch(() => {});
    };
  };

  if (job) follow(job);
  else idle(note);
  return card;
}

function bytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} kB`;
}

const PHASES: Record<string, string> = { queued: "Queued", clone: "Cloning", walk: "Walking history", reindex: "Reindexing", diff: "Diffing commits", finish: "Writing tables" };

/** Show extraction progress until the job finishes; resolves true when the repo is ready. */
export function renderLoading(root: HTMLElement, jobId: string, repo: string): Promise<boolean> {
  const phase = h("div", { class: "ink2" });
  const fill = h("div", { class: "bar-fill" });
  const detail = h("div", { class: "muted num" });
  const err = h("div", { class: "err" });
  const cancel = h("button", { class: "btn", text: "Cancel" });
  cancel.addEventListener("click", () => api.cancelJob(jobId).catch(() => {}));
  const track = h("div", { class: "bar-track" }, fill);
  const actions = h("div", { style: "margin-top:16px;display:flex;gap:8px" }, cancel, h("a", { class: "btn", href: "#/", text: "All repositories" }));
  const box = h("main", { class: "loading-box" }, h("h1", { text: repo, style: "font-size:20px;margin:0 0 4px" }), phase, track, detail, err, actions);
  root.replaceChildren(box);
  return new Promise((resolve) => {
    /** The remote wants a login: ask for it, then start the repo again with it. */
    const askLogin = (j: JobStatus) => {
      phase.textContent = `${j.host} needs a login`;
      err.textContent = j.rejected ? "That login was rejected. Check the username and the password or token." : "";
      track.remove();
      detail.textContent = "";
      cancel.remove();
      const user = h("input", { type: "text", name: "username", autocomplete: "username", placeholder: "Username", "aria-label": "Username", required: true });
      const pass = h("input", { type: "password", name: "password", autocomplete: "current-password", placeholder: "Password or access token", "aria-label": "Password or access token", required: true });
      const send = h("button", { class: "btn primary", type: "submit", text: "Sign in and analyze" });
      const remote = !isLocal(location.hostname) && location.protocol !== "https:";
      const form = h("form", { class: "login" },
        user,
        pass,
        remote && h("div", { class: "err", text: "This page is on another computer and uses plain HTTP, so the password would cross the network unencrypted." }),
        h("div", { class: "muted", text: "strata keeps the login in memory until the server stops. It is never written to disk." }),
        h("div", { class: "row" }, send, h("a", { class: "btn", href: "#/", text: "All repositories" })),
      );
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        send.disabled = true;
        err.textContent = "";
        try {
          const next = await api.addRepo(sourceText(j.source), false, { username: user.value.trim(), password: pass.value });
          pass.value = "";
          history.replaceState(null, "", `#/r/${encodeURIComponent(repo)}?job=${next.id}`);
          resolve(await renderLoading(root, next.id, repo));
        } catch (ex) {
          err.textContent = ex instanceof Error ? ex.message : String(ex);
          send.disabled = false;
        }
      });
      actions.replaceWith(form);
      user.focus();
    };
    const es = api.jobEvents(jobId);
    const show = (j: JobStatus) => {
      const p = j.progress;
      const pct = p.total ? (100 * p.done) / p.total : 0;
      fill.style.width = `${pct.toFixed(1)}%`;
      phase.textContent = PHASES[p.phase] ?? p.phase;
      detail.textContent = p.message ?? (p.total ? `${fmt.int(p.done)} / ${fmt.int(p.total)} commits · ${fmt.int(p.steps_per_sec)}/s${p.eta_secs ? ` · about ${Math.ceil(p.eta_secs)}s left` : ""}` : "");
      if (j.state === "done") {
        es.close();
        resolve(true);
      } else if (j.state === "credentials") {
        es.close();
        askLogin(j);
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

const isLocal = (host: string) => host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);

const sourceText = (s: RepoSource) => (s.kind === "path" ? s.path : s.url);
