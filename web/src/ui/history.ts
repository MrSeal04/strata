import { type HistoryRow, type SideCommit, api, col, filterParams } from "../api/client";
import type { App } from "../app";
import type { SearchState } from "../state/store";
import { colorMaps } from "../model/colors";
import { fmt, h, icon } from "./dom";

/** Every row has one height, commit or side commit, so the list renders only what's in view. */
const ROW = 46;
/** Commits per /history/rows request; at most two requests in flight. */
const PAGE = 100;
/** Side commits per /side request, and the most a merge lists. */
const SIDE_PAGE = 200;
const SIDE_MAX = 2000;
/** After the reader scrolls, the list stops following the cursor for this long (ms). */
const HOLD_MS = 4000;
/**
 * While playing, the list follows the cursor at most this often (ms): at hundreds of commits a
 * second nobody reads it, and repainting it every frame cost Linux playback a sixth of its fps.
 */
const PLAYING_MS = 100;
/** The graph gutter: the branch's lane and a merge's side lane. */
const GUTTER = 34;
const L0 = 11;
const L1 = 25;
/** `steps.flags`: some file was too large to diff, so the counts are line-count deltas. */
const APPROX = 2;

/** A display row's kind beside its commit: the commit itself, or the "more" row of its side commits. */
const MAIN = -1;
const MORE = -2;

interface Side {
  total: number;
  /** Null while loading. */
  commits: SideCommit[] | null;
}

/**
 * The branch history: its first-parent commits newest first, a dot per commit on the branch's
 * lane, and a merge's side commits on a lane beside it once expanded. The tables keep no
 * parents for side commits, so they list by author date and rejoin the branch below the merge.
 * Clicking a commit moves the cursor there; while the cursor moves, the list follows it.
 */
export class HistoryPanel {
  readonly el: HTMLElement;
  private scroller: HTMLElement;
  private space: HTMLElement;
  private info: HTMLElement;
  /** Steps shown, newest first. */
  private desc = new Uint32Array(0);
  private rows = new Map<number, HistoryRow>();
  private pages = new Set<number>();
  private inflight = 0;
  private expanded = new Map<number, Side>();
  /** Per display row: the commit's index in `desc`, and MAIN, MORE or a side commit's index. */
  private itemMain = new Int32Array(0);
  private itemSide = new Int32Array(0);
  /** Bumped on every reload, so a late answer for old filters is dropped. */
  private gen = 0;
  private loaded = false;
  private stale = true;
  private open = false;
  /** When the reader last scrolled the list themselves. */
  private userAt = 0;
  private frame = 0;
  private cursorFrame = 0;
  private cursorTimer = 0;
  private cursorAt = 0;
  /** Rows in the DOM by display row; while only the scroll moves, rows still in view stay. */
  private shown = new Map<number, HTMLElement>();
  /** The rows in the DOM are out of date (data, filters, expansion or marks changed). */
  private dirty = true;
  /**
   * The scroll position and the viewport's height, kept from scroll and resize events: reading
   * them from the DOM in the cursor's frame forced a layout of the whole page after the views
   * had drawn (6% of Linux playback).
   */
  private top = 0;
  private viewH = 0;
  /** Center the cursor once the list has a size. */
  private pendingFollow = false;
  private ro: ResizeObserver;
  private tags = new Map<number, string[]>();
  /** Search matches, for the search they came from. */
  private matches: { of: SearchState | null; steps: Set<number> } = { of: null, steps: new Set() };
  private unsubs: (() => void)[] = [];

  constructor(private app: App) {
    for (const t of app.summary.tags) this.tags.set(t.step, [...(this.tags.get(t.step) ?? []), t.name]);
    const current = h("button", { class: "btn", title: "Scroll to the cursor's commit and follow it again" }, icon("target"), "Current");
    current.addEventListener("click", () => {
      this.userAt = 0;
      this.follow(true);
    });
    const close = h("button", { class: "btn icon", title: "Close", "aria-label": "Close history" }, icon("close"));
    close.addEventListener("click", () => app.store.set({ history: false }));
    this.info = h("div", { class: "info num" });
    this.space = h("div", { class: "hspace", role: "list" });
    this.scroller = h("div", { class: "hscroll", tabindex: "-1" }, this.space);
    this.el = h("aside", { class: "history", "aria-label": "Branch history", hidden: true },
      h("div", { class: "hhead" }, h("h2", { text: "History" }), h("span", { class: "branch mono", text: app.meta.branch, title: `${app.meta.branch} @ ${app.meta.head.slice(0, 10)}` }), h("span", { class: "spacer" }), current, close),
      this.info,
      this.scroller,
    );
    this.scroller.addEventListener("scroll", () => {
      this.top = this.scroller.scrollTop;
      this.schedule();
    });
    this.ro = new ResizeObserver(([e]) => {
      this.viewH = e.contentRect.height;
      // (hiding the list loses its scroll position)
      this.top = this.scroller.scrollTop;
      if (this.pendingFollow) this.follow(true);
      this.schedule();
    });
    this.ro.observe(this.scroller);
    const reading = () => (this.userAt = performance.now());
    this.scroller.addEventListener("wheel", reading, { passive: true });
    this.scroller.addEventListener("touchstart", reading, { passive: true });
    this.scroller.addEventListener("keydown", (e) => ["ArrowUp", "ArrowDown", "PageUp", "PageDown"].includes(e.key) && reading());
    // (a press on the scroller itself is its scrollbar)
    this.scroller.addEventListener("pointerdown", (e) => e.target === this.scroller && reading());
    this.space.addEventListener("click", (e) => this.onClick(e));
    this.space.addEventListener("keydown", (e) => {
      const row = e.target as HTMLElement;
      if (e.key !== "Enter" || !row.classList.contains("hrow")) return;
      this.userAt = 0;
      app.player.seek(Number(row.dataset.step));
    });

    const store = app.store;
    this.unsubs.push(
      store.watch((s) => s.history, (on) => this.setOpen(on), true),
      store.watch((s) => s.filterRev, () => {
        this.stale = true;
        if (this.open) void this.reload();
      }),
      // (and once more when playback stops, for where it stopped)
      store.watch((s) => [s.cursor, s.playing], () => this.cursorMoved()),
      store.watch((s) => [s.brush, s.compare?.a, s.compare?.b, s.search?.q, s.search?.steps.length], () => this.invalidate()),
      colorMaps.author.onChange(() => this.invalidate()),
    );
  }

  destroy() {
    this.unsubs.forEach((u) => u());
    this.ro.disconnect();
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.cursorFrame);
    clearTimeout(this.cursorTimer);
  }

  private cursorMoved() {
    if (!this.open || this.cursorFrame || this.cursorTimer) return;
    const wait = this.app.store.get().playing ? PLAYING_MS - (performance.now() - this.cursorAt) : 0;
    if (wait > 0) {
      this.cursorTimer = window.setTimeout(() => {
        this.cursorTimer = 0;
        this.cursorMoved();
      }, wait);
      return;
    }
    this.cursorFrame = requestAnimationFrame(() => {
      this.cursorFrame = 0;
      this.cursorAt = performance.now();
      this.follow(false);
      this.paintCursor();
    });
  }

  private setOpen(on: boolean) {
    this.open = on;
    this.el.hidden = !on;
    if (!on) return;
    this.dirty = true;
    if (this.stale) void this.reload();
    else {
      this.render();
      this.follow(true);
    }
  }

  /** Fetch the steps under the current filters, keeping the commit at the top of the view in place. */
  private async reload() {
    const gen = ++this.gen;
    this.stale = false;
    const anchor = this.loaded ? this.topStep() : -1;
    this.info.textContent = "Loading…";
    let steps: Float64Array;
    try {
      steps = col(await api.history(this.app.repo, filterParams(this.app.store.get())), "step");
    } catch (e) {
      if (gen === this.gen) this.info.textContent = `Couldn't load the history: ${e instanceof Error ? e.message : e}`;
      return;
    }
    if (gen !== this.gen) return;
    const n = steps.length;
    this.desc = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.desc[i] = steps[n - 1 - i];
    this.rows.clear();
    this.pages.clear();
    this.inflight = 0;
    const all = this.app.tl.n;
    this.info.textContent = n === all ? `${fmt.int(n)} commits` : `${fmt.int(n)} of ${fmt.int(all)} commits match the filters`;
    this.rebuild();
    const first = !this.loaded;
    this.loaded = true;
    if (first || anchor < 0) this.follow(true);
    else this.scrollTo(this.itemOf(Math.max(0, this.atOrBefore(anchor))) * ROW);
    this.dirty = true;
    this.render();
  }

  /** Lay out the display rows: every commit, and the side commits of expanded merges. */
  private rebuild() {
    const d = this.desc;
    let n = d.length;
    for (const [step, side] of this.expanded) if (this.indexOf(step) >= 0) n += sideRows(side);
    const main = new Int32Array(n);
    const sideIx = new Int32Array(n);
    let k = 0;
    for (let i = 0; i < d.length; i++) {
      main[k] = i;
      sideIx[k++] = MAIN;
      const side = this.expanded.size ? this.expanded.get(d[i]) : undefined;
      if (!side) continue;
      const shown = side.commits?.length ?? 0;
      for (let j = 0, m = sideRows(side); j < m; j++) {
        main[k] = i;
        sideIx[k++] = j < shown ? j : MORE;
      }
    }
    this.itemMain = main;
    this.itemSide = sideIx;
    this.space.style.height = `${n * ROW}px`;
  }

  /** Index in `desc` of `step`, or -1. */
  private indexOf(step: number): number {
    const i = this.atOrBefore(step);
    return i >= 0 && this.desc[i] === step ? i : -1;
  }

  /** Index of the newest shown commit at or before `step` (-1 when every one is later). */
  private atOrBefore(step: number): number {
    const d = this.desc;
    let lo = 0;
    let hi = d.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (d[mid] > step) lo = mid + 1;
      else hi = mid;
    }
    return lo < d.length ? lo : -1;
  }

  /** Display row of commit `i`. */
  private itemOf(i: number): number {
    let k = i;
    for (const [step, side] of this.expanded) {
      const j = this.indexOf(step);
      if (j >= 0 && j < i) k += sideRows(side);
    }
    return k;
  }

  private topStep(): number {
    const k = Math.min(this.itemMain.length - 1, Math.floor(this.top / ROW));
    return k >= 0 ? this.desc[this.itemMain[k]] : -1;
  }

  private invalidate() {
    this.dirty = true;
    this.schedule();
  }

  private schedule() {
    if (!this.open || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private render() {
    if (!this.open || !this.loaded) return;
    const n = this.itemMain.length;
    const first = Math.max(0, Math.floor(this.top / ROW) - 4);
    const last = Math.min(n - 1, Math.ceil((this.top + this.viewH) / ROW) + 4);
    if (this.dirty) {
      this.dirty = false;
      this.shown.clear();
      this.space.replaceChildren();
      if (!n) this.space.append(h("div", { class: "hempty", text: "No commits match the filters" }));
    }
    for (const [k, el] of this.shown) {
      if (k < first || k > last) {
        el.remove();
        this.shown.delete(k);
      }
    }
    const s = this.app.store.get();
    if (this.matches.of !== s.search) this.matches = { of: s.search, steps: new Set(s.search?.steps ?? []) };
    const matches = this.matches.steps;
    const above: HTMLElement[] = [];
    const below: HTMLElement[] = [];
    let kept = Infinity;
    for (const k of this.shown.keys()) kept = Math.min(kept, k);
    for (let k = first; k <= last; k++) {
      if (this.shown.has(k)) continue;
      const el = this.rowEl(k, s.compare, s.brush, matches);
      this.shown.set(k, el);
      // (DOM order follows the list, for keyboard focus)
      (k < kept ? above : below).push(el);
    }
    this.space.prepend(...above);
    this.space.append(...below);
    this.paintCursor();
    if (n) this.request(this.itemMain[first], this.itemMain[last]);
  }

  /** Load the rows of commits i0..=i1 that aren't loaded or loading. */
  private request(i0: number, i1: number) {
    const gen = this.gen;
    for (let page = Math.floor(i0 / PAGE); page <= Math.floor(i1 / PAGE) && this.inflight < 2; page++) {
      if (this.pages.has(page)) continue;
      this.pages.add(page);
      this.inflight++;
      const p = filterParams(this.app.store.get());
      p.set("steps", Array.from(this.desc.subarray(page * PAGE, (page + 1) * PAGE)).join(","));
      api.historyRows(this.app.repo, p).then((rows) => {
        if (gen !== this.gen) return;
        for (const r of rows) this.rows.set(r.step, r);
      }, () => {
        // (shown as placeholders; a later reload asks again)
      }).finally(() => {
        if (gen !== this.gen) return;
        this.inflight--;
        this.invalidate();
      });
    }
  }

  private rowEl(k: number, compare: { a: number; b: number } | null, brush: [number, number] | null, matches: Set<number>): HTMLElement {
    const i = this.itemMain[k];
    const sideIx = this.itemSide[k];
    const step = this.desc[i];
    const el = h("div", { class: "hrow", role: "listitem" });
    el.style.top = `${k * ROW}px`;
    el.dataset.step = String(step);
    if (brush && step >= brush[0] && step <= brush[1]) el.classList.add("inrange");
    if (sideIx !== MAIN) {
      el.classList.add("side");
      el.dataset.kind = sideIx === MORE ? "more" : "side";
      return this.sideRow(el, k, i, sideIx);
    }
    el.dataset.kind = "main";
    el.tabIndex = 0;
    const r = this.rows.get(step);
    if (matches.has(step)) el.classList.add("match");
    el.append(this.lanes(k, i, r?.is_merge ?? false, r ? colorMaps.author.color(r.author ?? "") : null));
    const l1 = h("div", { class: "l1" });
    for (const end of ["a", "b"] as const) if (compare && compare[end] === step) l1.append(h("span", { class: "ab-tag", text: end.toUpperCase(), title: `Compare ${end.toUpperCase()}` }));
    l1.append(h("span", { class: "sum", text: r ? r.summary || "(no message)" : "…" }));
    if (r?.is_merge && r.side_count > 0) {
      const open = this.expanded.has(step);
      const more = h("button", { class: "chip expand", "aria-expanded": String(open), title: open ? "Hide the commits this merge brought in" : "Show the commits this merge brought in" },
        `${open ? "▾" : "▸"} ${fmt.int(r.side_count)} ${r.side_count === 1 ? "commit" : "commits"}`);
      more.dataset.expand = String(step);
      l1.append(more);
    }
    const tags = this.tags.get(step);
    if (tags) {
      for (const t of tags.slice(0, 2)) l1.append(h("span", { class: "tag", text: t, title: `Tag ${t}` }));
      if (tags.length > 2) l1.append(h("span", { class: "tag", text: `+${tags.length - 2}`, title: tags.slice(2).join(", ") }));
    }
    const l2 = h("div", { class: "l2" },
      h("span", { class: "who", text: r ? `${r.author ?? "unknown"} · ${fmt.date(r.author_time)}` : "" }),
      h("span", { class: "id mono", text: `#${fmt.int(step + 1)}${r ? ` · ${r.sha.slice(0, 7)}` : ""}` }),
    );
    const approx = r && r.flags & APPROX ? "≈" : "";
    const counts = h("div", { class: "ct num", title: r ? `${fmt.int(r.adds)} lines added, ${fmt.int(r.dels)} deleted${approx ? " (approximate: a file was too large to diff)" : ""}` : "" },
      r ? h("span", { class: "a", text: `${approx}+${fmt.compact(r.adds)}` }) : null,
      r ? h("span", { class: "d", text: `${approx}−${fmt.compact(r.dels)}` }) : null,
    );
    const details = h("button", { class: "btn icon det", title: "Commit details", "aria-label": "Commit details" }, icon("info"));
    details.dataset.details = String(step);
    el.title = r ? `${r.summary}\n${r.author ?? "unknown"} · authored ${fmt.datetime(r.author_time)}` : "";
    el.append(h("div", { class: "txt" }, l1, l2), counts, details);
    return el;
  }

  private sideRow(el: HTMLElement, k: number, i: number, sideIx: number): HTMLElement {
    const step = this.desc[i];
    const side = this.expanded.get(step);
    const c = sideIx >= 0 ? side?.commits?.[sideIx] : undefined;
    el.append(this.lanes(k, i, false, c ? colorMaps.author.color(c.author ?? "") : null));
    if (c) {
      el.title = `${c.summary}\n${c.author ?? "unknown"} · authored ${fmt.datetime(c.author_time)} · landed with #${fmt.int(step + 1)}`;
      el.append(h("div", { class: "txt" },
        h("div", { class: "l1" }, h("span", { class: "sum", text: c.summary || "(no message)" })),
        h("div", { class: "l2" }, h("span", { class: "who", text: `${c.author ?? "unknown"} · ${fmt.date(c.author_time)}` }), h("span", { class: "id mono", text: c.sha.slice(0, 7) })),
      ));
      return el;
    }
    const shown = side?.commits?.length ?? 0;
    const left = (side?.total ?? 0) - shown;
    const txt = h("div", { class: "txt l2" });
    if (!side?.commits) txt.append("Loading…");
    else if (shown >= SIDE_MAX) txt.append(`${fmt.int(left)} more not listed`);
    else {
      const more = h("button", { class: "chip", text: `Show ${fmt.int(Math.min(SIDE_PAGE, left))} more of ${fmt.int(left)}` });
      more.dataset.more = String(step);
      txt.append(more);
    }
    el.append(txt);
    return el;
  }

  /** The graph for display row `k`: the branch's lane, and a merge's side lane. */
  private lanes(k: number, i: number, merge: boolean, dot: string | null): SVGSVGElement {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "lanes");
    svg.setAttribute("width", String(GUTTER));
    svg.setAttribute("height", String(ROW));
    svg.setAttribute("aria-hidden", "true");
    const path = (d: string, cls: string) => {
      const p = document.createElementNS(ns, "path");
      p.setAttribute("d", d);
      p.setAttribute("class", cls);
      svg.append(p);
    };
    const d = this.desc;
    const step = d[i];
    const cy = ROW / 2;
    // Below a commit: the next one shown, dashed where filtered-out commits sit between.
    const older = i + 1 < d.length ? step - d[i + 1] > 1 : step > 0;
    const sideIx = this.itemSide[k];
    if (sideIx === MAIN) {
      if (i > 0) path(`M${L0} 0V${cy}`, d[i - 1] - step > 1 ? "l0 gap" : "l0");
      if (i + 1 < d.length || step > 0) path(`M${L0} ${cy}V${ROW}`, older ? "l0 gap" : "l0");
      if (merge) {
        if (this.expanded.has(step)) path(`M${L0} ${cy}C${L0} ${cy + 12} ${L1} ${cy + 8} ${L1} ${ROW}`, "l1");
        else path(`M${L0} ${cy}C${L0 + 2} ${cy + 9} ${L1 - 2} ${cy + 6} ${L1 - 2} ${cy + 13}`, "l1 stub");
      }
      const c = document.createElementNS(ns, "circle");
      c.setAttribute("cx", String(L0));
      c.setAttribute("cy", String(cy));
      c.setAttribute("r", merge ? "5" : "4");
      c.setAttribute("class", merge ? "dot merge" : "dot");
      if (dot) c.style.fill = dot;
      svg.append(c);
      return svg;
    }
    path(`M${L0} 0V${ROW}`, older ? "l0 gap" : "l0");
    const lastOfMerge = k + 1 >= this.itemMain.length || this.itemMain[k + 1] !== i;
    // The side lane rejoins the branch below the merge's last listed commit.
    path(lastOfMerge ? `M${L1} 0V${cy}C${L1} ${cy + 10} ${L0} ${ROW - 8} ${L0} ${ROW}` : `M${L1} 0V${ROW}`, "l1");
    if (sideIx >= 0) {
      const c = document.createElementNS(ns, "circle");
      c.setAttribute("cx", String(L1));
      c.setAttribute("cy", String(cy));
      c.setAttribute("r", "3.5");
      c.setAttribute("class", "dot");
      if (dot) c.style.fill = dot;
      svg.append(c);
    }
    return svg;
  }

  /** Mark the cursor's commit, and dim the commits after it. */
  private paintCursor() {
    const cur = this.app.store.get().cursor;
    // When the cursor sits on a filtered-out commit, a line marks where it falls.
    const at = this.atOrBefore(cur);
    const between = at >= 0 && this.desc[at] !== cur ? this.desc[at] : -1;
    for (const el of this.shown.values()) {
      const step = Number(el.dataset.step);
      const main = el.dataset.kind === "main";
      el.classList.toggle("cur", main && step === cur);
      el.classList.toggle("before-cur", main && step === between);
      el.classList.toggle("future", step > cur);
    }
  }

  /** Keep the cursor's commit in view, unless the reader scrolled away lately (`force` resumes). */
  private follow(force: boolean) {
    if (!this.open || !this.loaded || !this.desc.length) return;
    if (!force && performance.now() - this.userAt < HOLD_MS) return;
    this.pendingFollow = !this.viewH;
    if (this.pendingFollow) return;
    const at = this.atOrBefore(this.app.store.get().cursor);
    const k = this.itemOf(at >= 0 ? at : this.desc.length - 1);
    if (!force && k * ROW >= this.top + ROW && (k + 2) * ROW <= this.top + this.viewH) return;
    this.scrollTo(k * ROW - this.viewH / 2 + ROW / 2);
  }

  private scrollTo(y: number) {
    this.top = Math.max(0, Math.min(this.itemMain.length * ROW - this.viewH, y));
    this.scroller.scrollTop = this.top;
    this.schedule();
  }

  private onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const btn = t.closest<HTMLElement>("button");
    if (btn?.dataset.expand) return void this.toggle(Number(btn.dataset.expand));
    if (btn?.dataset.more) return void this.loadSide(Number(btn.dataset.more));
    if (btn?.dataset.details) return this.app.openCommit(Number(btn.dataset.details));
    const row = t.closest<HTMLElement>(".hrow");
    if (!row) return;
    this.userAt = 0;
    this.app.player.seek(Number(row.dataset.step));
  }

  /** Expand a merge to the side commits it brought in, or collapse it. */
  private async toggle(step: number) {
    if (this.expanded.delete(step)) {
      this.rebuild();
      this.invalidate();
      return;
    }
    this.expanded.set(step, { total: this.rows.get(step)?.side_count ?? 0, commits: null });
    this.rebuild();
    this.invalidate();
    await this.loadSide(step);
  }

  private async loadSide(step: number) {
    const side = this.expanded.get(step);
    if (!side) return;
    const limit = Math.min(SIDE_MAX, (side.commits?.length ?? 0) + SIDE_PAGE);
    try {
      const r = await api.side(this.app.repo, step, limit);
      if (this.expanded.get(step) !== side) return;
      side.total = r.total;
      side.commits = r.commits;
    } catch {
      if (this.expanded.get(step) !== side) return;
      this.expanded.delete(step);
    }
    this.rebuild();
    this.invalidate();
  }
}

/** Display rows a merge's side commits take: those listed, plus a loading or "more" row. */
function sideRows(side: Side): number {
  if (!side.commits) return 1;
  return side.commits.length + (side.total > side.commits.length ? 1 : 0);
}
