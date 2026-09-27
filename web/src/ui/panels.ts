import { api } from "../api/client";
import type { App } from "../app";
import type { Settings } from "../state/store";
import { fmt, h, icon } from "./dom";
import { popover } from "./popover";

/** Settings panel: every toggle from the plan in one place. */
export function openSettings(app: App, anchor: HTMLElement) {
  const store = app.store;
  const s = store.get().settings;
  const row = (label: string, control: HTMLElement, hint?: string) =>
    h("label", { class: "row", title: hint ?? "" }, h("span", { text: label }), control);
  const select = <K extends keyof Settings>(key: K, opts: [string, string][]) => {
    const el = h("select", {}, ...opts.map(([v, t]) => h("option", { value: v, text: t })));
    el.value = String(s[key]);
    el.addEventListener("change", () => {
      const v = el.value;
      store.setSettings({ [key]: (typeof s[key] === "number" ? Number(v) : v) as Settings[K] } as Partial<Settings>);
    });
    return el;
  };
  const num = <K extends keyof Settings>(key: K, min: number, max: number, step = 1) => {
    const el = h("input", { type: "number", min: String(min), max: String(max), step: String(step), style: "width:84px" });
    el.value = String(s[key]);
    el.addEventListener("change", () => store.setSettings({ [key]: Math.max(min, Math.min(max, Number(el.value) || min)) } as Partial<Settings>));
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
    row("Playback", select("playMode", [["fixed", "fixed total length"], ["commits", "commits per second"], ["calendar", "days per second"]])),
    row("Run length (s)", num("fixedSeconds", 1, 3600)),
    row("Commits / second", num("commitsPerSec", 0.1, 100000, 0.1)),
    row("Days / second", num("daysPerSec", 0.01, 36500, 0.01)),
    row("Loop", check("loop")),
    h("h3", { text: "Bars" }),
    row("Scale", select("barScale", [["linear", "linear"], ["sqrt", "square root"], ["log", "log"]]), "Compress tall bars so small commits stay visible"),
    row("Clip outliers above", select("clampPct", [["0", "off"], ["95", "95th percentile"], ["99", "99th percentile"], ["99.9", "99.9th percentile"]]), "Clipped bars get a ▲ marker; the true value is in the tooltip"),
    row("Ignore whitespace", check("ws")),
    row("Hide bots", check("hideBots")),
    h("h3", { text: "Stacked area" }),
    row("Slice by", select("areaSlice", [["dir", "directory"], ["lang", "language"], ["author", "author"], ["cohort", "year written"]])),
    row("Mode", select("areaMode", [["size", "size"], ["flow", "added / deleted"]])),
    row("Directory depth", num("areaDepth", 1, 6)),
    row("Cohort unit", select("cohortUnit", [["auto", "auto"], ["year", "year"], ["quarter", "quarter"], ["month", "month"]])),
    h("h3", { text: "Tree and treemap" }),
    row("Tree layout", select("treeLayout", [["radial", "radial tree"], ["force", "force-directed"], ["sunburst", "sunburst"], ["icicle", "icicle"]])),
    row("Color by", select("colorBy", [["lang", "language"], ["heat", "recent activity"], ["age", "line age"], ["author", "top author"]])),
    row("Author actors", check("actors"), "Gource-style: authors fly to the files they touch (radial / force layouts)"),
    row("Gravatar images", check("gravatar"), "Loads avatars from gravatar.com using a SHA-256 hash of each email (off by default)"),
    row("Node budget", num("nodeBudget", 200, 50000, 100), "Deeper folders collapse above this many nodes"),
    row("Activity highlight (s)", num("heatSeconds", 0.2, 20, 0.1)),
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
