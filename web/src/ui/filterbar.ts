import { CATEGORY_NAMES, api } from "../api/client";
import type { App } from "../app";
import { colorMaps } from "../model/colors";
import { fmt, h, icon } from "./dom";
import { openCompareSummary } from "./panels";
import { multiSelect } from "./popover";

/** The one filter row above everything it scopes. */
export class FilterBar {
  readonly el: HTMLElement;
  private crumbs: HTMLElement;
  private chips: HTMLElement;
  private langBtn: HTMLButtonElement;
  private authorBtn: HTMLButtonElement;
  private botsBtn: HTMLButtonElement;
  private wsBtn: HTMLButtonElement;
  private searchInput: HTMLInputElement;
  private searchKind: HTMLSelectElement;
  private searchInfo: HTMLElement;
  private compareBtn: HTMLButtonElement;
  private summaryBtn: HTMLButtonElement;
  private brushBtn: HTMLButtonElement;

  constructor(
    private app: App,
    actions: { settings: (anchor: HTMLElement) => void; export: (anchor: HTMLElement) => void; theme: () => void },
  ) {
    const store = app.store;
    const home = h("a", { class: "title", href: "#/", title: "All repositories", style: "text-decoration:none;color:inherit" }, "strata");
    const name = h("span", { class: "title", text: app.meta.name, title: `${app.meta.branch} @ ${app.meta.head.slice(0, 10)}` });
    this.crumbs = h("nav", { class: "crumbs", "aria-label": "Directory" });
    this.chips = h("div", { style: "display:flex;gap:4px;flex-wrap:wrap" });
    this.langBtn = h("button", { class: "btn" });
    this.langBtn.addEventListener("click", () => this.pickLangs());
    this.authorBtn = h("button", { class: "btn" });
    this.authorBtn.addEventListener("click", () => this.pickAuthors());
    this.botsBtn = h("button", { class: "btn", title: "Hide commits by bots (dependabot, renovate, …)" }, "No bots");
    this.botsBtn.addEventListener("click", () => store.setSettings({ hideBots: !store.get().settings.hideBots }));
    this.wsBtn = h("button", { class: "btn", title: "Count lines ignoring whitespace-only changes (git diff -w)" }, "Ignore ws");
    this.wsBtn.addEventListener("click", () => store.setSettings({ ws: !store.get().settings.ws }));
    this.searchKind = h("select", { "aria-label": "Search in" },
      h("option", { value: "message", text: "messages" }),
      h("option", { value: "author", text: "authors" }),
      h("option", { value: "path", text: "paths" }),
    );
    this.searchInput = h("input", { type: "search", placeholder: "Search  /", style: "width:140px", "aria-label": "Search" });
    this.searchInfo = h("span", { class: "muted num" });
    let timer = 0;
    const run = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => this.search(), 250);
    };
    this.searchInput.addEventListener("input", run);
    this.searchKind.addEventListener("change", run);
    this.searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.jumpMatch(e.shiftKey ? -1 : 1);
    });
    this.brushBtn = h("button", { class: "btn", title: "Clear the selected range (double-click a chart)" });
    this.brushBtn.addEventListener("click", () => store.set({ brush: null }));
    this.compareBtn = h("button", { class: "btn", title: "Compare two points: the selected range's ends, or start vs. now" }, icon("compare"), "Compare");
    this.compareBtn.addEventListener("click", () => this.toggleCompare());
    this.summaryBtn = h("button", { class: "btn", title: "What changed between A and B", text: "Summary" });
    this.summaryBtn.addEventListener("click", () => openCompareSummary(app, this.summaryBtn));
    app.compare.onChange(() => this.render());
    const exportBtn = h("button", { class: "btn icon", title: "Export PNG / SVG / video", "aria-label": "Export" }, icon("download"));
    exportBtn.addEventListener("click", () => actions.export(exportBtn));
    const settingsBtn = h("button", { class: "btn icon", title: "Settings", "aria-label": "Settings" }, icon("gear"));
    settingsBtn.addEventListener("click", () => actions.settings(settingsBtn));
    const themeBtn = h("button", { class: "btn icon", title: "Theme", "aria-label": "Toggle theme" }, icon("moon"));
    themeBtn.addEventListener("click", actions.theme);
    this.el = h("header", { class: "filterbar" },
      home, name, this.crumbs, h("span", { class: "sep" }), this.chips, this.langBtn, this.authorBtn, this.botsBtn, this.wsBtn,
      h("span", { class: "sep" }), this.searchKind, this.searchInput, this.searchInfo,
      h("span", { class: "grow" }), this.brushBtn, this.compareBtn, this.summaryBtn, exportBtn, settingsBtn, themeBtn,
    );
    store.watch((s) => [s.root, s.langs, s.authors, s.settings.exclude, s.settings.hideBots, s.settings.ws, s.brush, s.compare, s.search?.steps.length], () => this.render(), true);
  }

  private render() {
    const s = this.app.store.get();
    // breadcrumb
    const parts = s.root ? s.root.split("/") : [];
    const items: (HTMLElement | string)[] = [];
    const rootBtn = h("button", { text: "/", title: "Whole repository" });
    rootBtn.addEventListener("click", () => this.app.store.set({ root: "" }));
    items.push(rootBtn);
    parts.forEach((p, i) => {
      const b = h("button", { text: p });
      const target = parts.slice(0, i + 1).join("/");
      b.addEventListener("click", () => this.app.store.set({ root: target }));
      items.push(h("span", { class: "sl", text: "/" }), b);
    });
    this.crumbs.replaceChildren(...items);
    // categories: one button; the popover lists every category with its path count
    const hidden = CATEGORY_NAMES.filter((_, code) => s.settings.exclude.includes(code) && this.catCounts().get(code));
    const catBtn = h("button", { class: "btn", title: "Which kinds of files count" }, hidden.length ? `Files: ${hidden.length} kinds hidden` : "Files: all kinds");
    catBtn.addEventListener("click", () => this.pickCategories(catBtn));
    this.chips.replaceChildren(catBtn);
    this.langBtn.textContent = s.langs.length ? `Languages: ${s.langs.length === 1 ? s.langs[0] : s.langs.length}` : "Languages";
    this.langBtn.classList.toggle("on", s.langs.length > 0);
    this.authorBtn.textContent = s.authors.length ? `Authors: ${s.authors.length === 1 ? this.app.authorName(s.authors[0]) : s.authors.length}` : "Authors";
    this.authorBtn.classList.toggle("on", s.authors.length > 0);
    this.botsBtn.classList.toggle("on", s.settings.hideBots);
    this.wsBtn.classList.toggle("on", s.settings.ws);
    this.brushBtn.style.display = s.brush ? "" : "none";
    if (s.brush) this.brushBtn.textContent = `Range #${fmt.int(s.brush[0] + 1)}–#${fmt.int(s.brush[1] + 1)} ✕`;
    this.compareBtn.classList.toggle("on", !!s.compare);
    this.summaryBtn.style.display = s.compare && this.app.compare.data ? "" : "none";
    this.searchInfo.textContent = s.search ? `${fmt.int(s.search.steps.length)} commits${s.search.paths.size ? ` · ${fmt.int(s.search.paths.size)} files` : ""}` : "";
  }

  private catCounts(): Map<number, number> {
    return new Map(this.app.summary.categories.map((c) => [c.category, c.paths]));
  }

  private pickCategories(anchor: HTMLElement) {
    const counts = this.catCounts();
    const opts = CATEGORY_NAMES.map((name, code) => ({ value: String(code), label: name, hint: `${fmt.compact(counts.get(code) ?? 0)} paths` })).filter((o) => counts.get(Number(o.value)));
    const shown = opts.filter((o) => !this.app.store.get().settings.exclude.includes(Number(o.value))).map((o) => o.value);
    multiSelect(anchor, "Kinds of files to count", opts, shown, (v) => {
      const keep = new Set(v.map(Number));
      // "Show all" clears the selection: treat empty as everything shown.
      const exclude = v.length ? CATEGORY_NAMES.map((_, i) => i).filter((i) => !keep.has(i)) : [];
      this.app.store.setSettings({ exclude });
    });
  }

  private pickLangs() {
    const s = this.app.store.get();
    const opts = this.app.summary.langs.map((l) => ({ value: l.lang, label: l.lang, hint: fmt.compact(l.lines), swatch: colorMaps.lang.color(l.lang) }));
    multiSelect(this.langBtn, "Languages", opts, s.langs, (v) => this.app.store.set({ langs: v }));
  }

  private pickAuthors() {
    const s = this.app.store.get();
    const opts = this.app.authors.map((a) => ({ value: String(a.id), label: `${a.name}${a.is_bot ? " (bot)" : ""}`, hint: `${fmt.compact(a.commits)} commits` }));
    multiSelect(this.authorBtn, "Authors", opts, s.authors.map(String), (v) => this.app.store.set({ authors: v.map(Number) }));
  }

  private async search() {
    const q = this.searchInput.value.trim();
    const kind = this.searchKind.value as "message" | "author" | "path";
    if (!q) {
      this.app.store.set({ search: null });
      return;
    }
    const r = await api.search(this.app.repo, q, kind);
    if (this.searchInput.value.trim() !== q) return;
    this.app.store.set({ search: { q, kind, steps: r.steps, paths: new Set(r.paths) } });
  }

  /** Enter / Shift+Enter: jump to the next / previous matching commit. */
  private jumpMatch(dir: 1 | -1) {
    const s = this.app.store.get();
    const steps = s.search?.steps;
    if (!steps?.length) return;
    const cur = s.cursor;
    const next = dir > 0 ? steps.find((x) => x > cur) ?? steps[0] : [...steps].reverse().find((x) => x < cur) ?? steps[steps.length - 1];
    this.app.player.seek(next);
  }

  focusSearch() {
    this.searchInput.focus();
  }

  private toggleCompare() {
    const s = this.app.store.get();
    if (s.compare) {
      this.app.store.set({ compare: null });
      return;
    }
    const [a, b] = s.brush ?? [0, s.cursor];
    this.app.store.set({ compare: { a, b: Math.max(b, a + 1), mode: "overlay" } });
  }
}
