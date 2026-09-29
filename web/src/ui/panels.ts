import { api } from "../api/client";
import type { App } from "../app";
import type { Settings } from "../state/store";
import { fmt, h, icon } from "./dom";
import { popover } from "./popover";

/**
 * Settings panel: only what applies to the whole dashboard. Each card's own options sit in its
 * header, and playback in the transport bar.
 */
export function openSettings(app: App, anchor: HTMLElement) {
  const store = app.store;
  const s = store.get().settings;
  const row = (label: string, control: HTMLElement, hint?: string) =>
    h("label", { class: "row", title: hint ?? "" }, h("span", { text: label }), control);
  const select = <K extends keyof Settings>(key: K, opts: [string, string][]) => {
    const el = h("select", {}, ...opts.map(([v, t]) => h("option", { value: v, text: t })));
    el.value = String(s[key]);
    el.addEventListener("change", () => store.setSettings({ [key]: el.value } as Partial<Settings>));
    return el;
  };
  const check = <K extends keyof Settings>(key: K) => {
    const el = h("input", { type: "checkbox" });
    el.checked = Boolean(s[key]);
    el.addEventListener("change", () => store.setSettings({ [key]: el.checked } as Partial<Settings>));
    return el;
  };
  const body = h("div", {},
    h("h3", { text: "Timeline" }),
    row("Axis", select("axis", [["index", "commit index"], ["time", "calendar time"]]), "Commit index gives every commit equal width; calendar time shows real pace"),
    h("h3", { text: "Cards" }),
    row("Link shared options", check("linkCards"), "On: the tree colors like the treemap, and the added / deleted area clips outliers like the bars. Off: each card keeps its own."),
    h("h3", { text: "Display" }),
    row("Theme", select("theme", [["auto", "match system"], ["light", "light"], ["dark", "dark"]])),
    row("Add / delete colors", select("diffColors", [["bluered", "blue / red (colorblind-safe)"], ["greenred", "green / red (classic)"]])),
  );
  popover(anchor, body, 340);
}

/** Commit details: message, stats, files, merged authors, tags. */
export async function openCommit(app: App, step: number) {
  const close = h("button", { class: "btn icon close", "aria-label": "Close" }, icon("close"));
  const panel = h("aside", { class: "panel commit-panel", role: "dialog", "aria-label": "Commit details" }, close, h("div", { class: "muted", text: "Loading…" }));
  document.querySelectorAll(".commit-panel").forEach((e) => e.remove());
  document.body.append(panel);
  close.addEventListener("click", () => panel.remove());
  const d = await api.step(app.repo, step);
  const c = d.commit;
  if (!c) {
    panel.replaceChildren(close, h("div", { text: "Commit not found" }));
    return;
  }
  const kinds = ["added", "modified", "deleted", "renamed", "moved away"];
  const files = h("table", {}, h("tbody", {}, ...d.files.map((f) =>
    h("tr", {},
      h("td", { class: "p", title: kinds[f.kind] ?? "", text: f.old_path ? `${f.old_path} → ${f.path}` : f.path }),
      h("td", { class: "a num", text: f.binary ? "bin" : `+${fmt.int(f.adds)}` }),
      h("td", { class: "d num", text: f.binary ? "" : `−${fmt.int(f.dels)}` }),
    ),
  )));
  const goto = h("button", { class: "btn", text: "Go to this commit" });
  goto.addEventListener("click", () => app.player.seek(step));
  panel.replaceChildren(
    close,
    h("div", { class: "mono muted", text: `#${fmt.int(step + 1)} · ${c.sha.slice(0, 12)}${d.tags.length ? ` · ${d.tags.map((t) => t.name).join(", ")}` : ""}` }),
    h("h3", { text: c.summary, style: "color:var(--ink);font-size:14px;margin:6px 0" }),
    h("div", { class: "ink2", text: `${c.author}${c.committer && c.committer !== c.author ? ` (committed by ${c.committer})` : ""}` }),
    h("div", { class: "muted", text: `authored ${fmt.datetime(c.author_time)} · landed ${fmt.datetime(c.commit_time)}` }),
    h("div", { class: "num", style: "margin:6px 0" },
      h("span", { style: "color:var(--add)", text: `+${fmt.int(c.adds)} ` }),
      h("span", { style: "color:var(--del)", text: `−${fmt.int(c.dels)} ` }),
      h("span", { class: "muted", text: `in ${fmt.int(c.files_changed)} files${c.adds_ws !== c.adds || c.dels_ws !== c.dels ? ` (ignoring whitespace: +${fmt.int(c.adds_ws)} −${fmt.int(c.dels_ws)})` : ""}` }),
    ),
    c.is_merge && c.side_count
      ? h("div", { class: "ink2", text: `Merge bringing in ${fmt.int(c.side_count)} commits by ${d.side_authors.map((a) => `${a.name} (${a.commits})`).join(", ")}` })
      : "",
    h("pre", { text: c.message.trim() }),
    goto,
    h("h3", { text: `Files (${d.files.length}${d.files.length >= 500 ? "+" : ""})` }),
    files,
  );
}

/** Compare summary: totals, born/died, top-moving folders and files, editable A/B. */
export function openCompareSummary(app: App, anchor: HTMLElement) {
  const s = app.store.get();
  const d = app.compare.data;
  if (!s.compare || !d) return;
  const root = s.root ? `${s.root}/` : "";
  let sumA = 0;
  let sumB = 0;
  let born = 0;
  let died = 0;
  const dirs = new Map<string, { a: number; b: number }>();
  const files: { path: string; a: number; b: number }[] = [];
  for (const [pid, a] of d.linesA) {
    const b = d.linesB.get(pid) ?? 0;
    sumA += a;
    sumB += b;
    if (a === 0 && b > 0) born++;
    if (b === 0 && a > 0) died++;
    const path = app.paths.path[pid];
    files.push({ path, a, b });
    const rel = path.startsWith(root) ? path.slice(root.length) : path;
    const parts = rel.split("/");
    for (let depth = 1; depth <= Math.min(2, parts.length - 1); depth++) {
      const key = root + parts.slice(0, depth).join("/");
      const e = dirs.get(key) ?? { a: 0, b: 0 };
      e.a += a;
      e.b += b;
      dirs.set(key, e);
    }
  }
  const delta = (x: { a: number; b: number }) => x.b - x.a;
  const topDirs = [...dirs.entries()].sort((x, y) => Math.abs(delta(y[1])) - Math.abs(delta(x[1]))).slice(0, 10);
  const grew = [...files].sort((x, y) => delta(y) - delta(x)).filter((f) => delta(f) > 0).slice(0, 8);
  const shrank = [...files].sort((x, y) => delta(x) - delta(y)).filter((f) => delta(f) < 0).slice(0, 8);
  const row = (label: string, a: number, b: number, onClick?: () => void) => {
    const tr = h("tr", {},
      h("td", { class: "p", text: label }),
      h("td", { class: "num", style: "text-align:right;color:var(--ink-muted)", text: `${fmt.int(a)} → ${fmt.int(b)}` }),
      h("td", { class: b - a >= 0 ? "a num" : "d num", text: fmt.signed(b - a) }),
    );
    if (onClick) {
      tr.style.cursor = "pointer";
      tr.addEventListener("click", onClick);
    }
    return tr;
  };
  const stepInput = (value: number, set: (v: number) => void) => {
    const el = h("input", { type: "number", min: "1", max: String(s.steps), value: String(value + 1), style: "width:90px" });
    el.addEventListener("change", () => set(Math.max(0, Math.min(s.steps - 1, Number(el.value) - 1))));
    return el;
  };
  const cmp = s.compare;
  const body = h("div", { class: "commit-panel" },
    h("h3", { text: "Compare" }),
    h("label", { class: "row" }, h("span", { text: `A (commit #, ${fmt.date(app.tl.time(cmp.a))})` }), stepInput(cmp.a, (a) => app.store.set({ compare: { ...cmp, a } }))),
    h("label", { class: "row" }, h("span", { text: `B (commit #, ${fmt.date(app.tl.time(cmp.b))})` }), stepInput(cmp.b, (b) => app.store.set({ compare: { ...cmp, b } }))),
    h("div", { class: "num", style: "margin:8px 0" },
      h("span", { text: `${fmt.int(sumA)} → ${fmt.int(sumB)} lines ` }),
      h("span", { class: sumB >= sumA ? "a" : "d", style: `color:var(${sumB >= sumA ? "--add" : "--del"})`, text: `(${fmt.signed(sumB - sumA)})` }),
      h("div", { class: "muted", text: `${fmt.int(born)} files added · ${fmt.int(died)} deleted` }),
    ),
    h("h3", { text: "Folders that moved most" }),
    h("table", {}, h("tbody", {}, ...topDirs.map(([dir, v]) => row(`${dir}/`, v.a, v.b, () => app.store.set({ root: dir }))))),
    h("h3", { text: "Files that grew most" }),
    h("table", {}, h("tbody", {}, ...grew.map((f) => row(f.path, f.a, f.b)))),
    h("h3", { text: "Files that shrank most" }),
    h("table", {}, h("tbody", {}, ...shrank.map((f) => row(f.path, f.a, f.b)))),
  );
  popover(anchor, body, 420);
}
