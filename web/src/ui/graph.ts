import { type GraphData, api } from "../api/client";
import type { App } from "../app";
import { Categorical, colorMaps } from "../model/colors";
import { onPaletteChange, palette } from "../theme";
import { fmt, h, icon } from "./dom";
import { tooltip } from "./tooltip";

/** Window sizes (first-parent commits) offered; the server answers at most 2,000. */
const SIZES = [250, 500, 1000, 2000];
const DEFAULT_SIZE = 500;
/** When paging, this many commits of the old window stay in view. */
const OVERLAP = 20;
/** Left margin (lane names, the size axis) and right margin (the end label). */
const ML = 70;
const MR = 120;
/** A first-parent commit moves x by at least MIN_DX and at most MAX_DX px. */
const MIN_DX = 7;
const MAX_DX = 44;
/** Px per median gap between first-parent commits, before the clamp. */
const PX_PER_UNIT = 10;
/** A gap over this many median gaps (and an hour) is squeezed and marked. */
const BREAK_UNITS = 8;
/** A branch whose first commit is before the window starts with a dashed stub this long. */
const STUB = 28;
const TAG_ROWS = 3;
const TAG_ROW_H = 15;
const AXIS_GAP = 96;

type Side = GraphData["side"][number];
type ColorBy = "dir" | "author";

interface Branch {
  /** Index in `data.branches`. */
  i: number;
  step: number;
  /** Index of the merge in `data.steps`. */
  at: number;
  name: string;
  key: string;
  color: string;
  x0: number;
  x1: number;
  /** Whether its first commit is before the window. */
  cut: boolean;
  lane: number;
  room: number;
  side: Side[];
}

interface Layout {
  xs: Float64Array;
  X: (t: number) => number;
  breaks: { x0: number; x1: number; t0: number; t1: number }[];
  branches: Branch[];
  lanes: number;
  width: number;
}

/**
 * The commit graph: the branch's first-parent commits left to right in time, each merged
 * branch on a lane above them from its first commit to its merge, and the codebase's size in a
 * band below. The tables keep no parents for side commits, so a branch starts at its first
 * commit's author date, not where it forked. It shows a window of commits around the cursor;
 * quiet stretches are squeezed so a busy hour and an idle month both read.
 */
export class GraphSheet {
  readonly el: HTMLElement;
  private scroller: HTMLElement;
  private host: HTMLElement;
  private info: HTMLElement;
  private legend: HTMLElement;
  private older: HTMLButtonElement;
  private newer: HTMLButtonElement;
  private size = DEFAULT_SIZE;
  private colorBy: ColorBy = "dir";
  private dirs = new Categorical();
  private data: GraphData | null = null;
  private layout: Layout | null = null;
  private gen = 0;
  private shown = false;
  private cursorLine: SVGGElement | null = null;
  private unsubs: (() => void)[] = [];
  /** Told when the sheet opens or closes (the History panel's toggle). */
  onToggle: (open: boolean) => void = () => {};

  constructor(private app: App) {
    // (where most commits are merges, as in git and Linux, nearly every branch overlaps the next)
    const head = app.summary.head;
    if (head && head.merges > head.steps / 2) this.size = 250;
    const select =(opts: [string, string][], value: string, title: string, on: (v: string) => void) => {
      const el = h("select", { title }, ...opts.map(([v, t]) => h("option", { value: v, text: t })));
      el.value = value;
      el.addEventListener("change", () => on(el.value));
      return el;
    };
    const colorSel = select([["dir", "color: folder"], ["author", "color: author"]], this.colorBy,
      "Color each branch by the top-level folder its merge changed most, or by its most frequent author", (v) => {
        this.colorBy = v as ColorBy;
        this.render();
      });
    const sizeSel = select(SIZES.map((n) => [String(n), `${fmt.int(n)} commits`]), String(this.size),
      "How many commits on the branch the graph shows at once", (v) => {
        this.size = Number(v);
        void this.atCursor();
      });
    this.older = h("button", { class: "btn", title: "Show older commits" }, icon("back"), "Older");
    this.newer = h("button", { class: "btn", title: "Show newer commits" }, "Newer", icon("fwd"));
    this.older.addEventListener("click", () => {
      if (!this.data) return;
      const to = Math.min(this.data.from + OVERLAP - 1, this.data.to - 1);
      void this.load(Math.max(0, to - this.size + 1), to, "end");
    });
    this.newer.addEventListener("click", () => {
      if (!this.data) return;
      const from = Math.max(this.data.to - OVERLAP + 1, this.data.from + 1);
      void this.load(from, Math.min(this.app.tl.n - 1, from + this.size - 1), "start");
    });
    const cursor = h("button", { class: "btn", title: "Show the commits around the cursor" }, icon("target"), "Cursor");
    cursor.addEventListener("click", () => void this.atCursor());
    const close = h("button", { class: "btn icon", title: "Close", "aria-label": "Close the graph" }, icon("close"));
    close.addEventListener("click", () => this.close());
    this.info = h("span", { class: "ginfo num" });
    this.legend = h("div", { class: "legend glegend" });
    this.host = h("div", { class: "ghost" });
    this.scroller = h("div", { class: "gscroll", tabindex: "-1" }, this.host);
    this.el = h("section", { class: "graph-sheet", "aria-label": "Commit graph", hidden: true },
      h("div", { class: "ghead" },
        h("h2", { text: "Commit graph" }), this.info, h("span", { class: "spacer" }),
        colorSel, sizeSel, this.older, this.newer, cursor, close),
      h("p", { class: "gnote", text: "Each merged branch runs on a lane from its first commit (author date; where it forked isn't stored) to its merge. "
        + "Quiet stretches are squeezed (shaded). The band is the codebase's size in lines. Click a commit to move the cursor." }),
      this.legend,
      this.scroller,
    );
    this.host.addEventListener("pointermove", (e) => this.hover(e));
    this.host.addEventListener("pointerleave", () => tooltip.hide());
    this.host.addEventListener("click", (e) => this.click(e));
    this.unsubs.push(
      app.store.watch((s) => s.cursor, () => this.paintCursor()),
      onPaletteChange(() => this.render()),
      colorMaps.author.onChange(() => this.colorBy === "author" && this.render()),
    );
    document.addEventListener("keydown", this.onKey, true);
  }

  get isOpen() {
    return this.shown;
  }

  toggle() {
    if (this.shown) this.close();
    else this.open();
  }

  open() {
    if (this.shown) return;
    this.shown = true;
    this.el.hidden = false;
    this.onToggle(true);
    if (!this.data) void this.atCursor();
  }

  close() {
    if (!this.shown) return;
    this.shown = false;
    this.el.hidden = true;
    tooltip.hide();
    this.onToggle(false);
  }

  destroy() {
    this.unsubs.forEach((u) => u());
    document.removeEventListener("keydown", this.onKey, true);
  }

  private onKey = (e: KeyboardEvent) => {
    if (!this.shown || e.key !== "Escape") return;
    // (the sheet closes first; the dashboard's Escape would clear compare and the brush too)
    e.stopPropagation();
    this.close();
  };

  /** Load the window around the cursor, a quarter of it after the cursor. */
  private atCursor() {
    const n = this.app.tl.n;
    const cur = this.app.store.get().cursor;
    let to = Math.min(n - 1, cur + Math.floor(this.size / 4));
    const from = Math.max(0, to - this.size + 1);
    to = Math.min(n - 1, from + this.size - 1);
    return this.load(from, to, "cursor");
  }

  private async load(from: number, to: number, scroll: "start" | "end" | "cursor") {
    const gen = ++this.gen;
    this.info.textContent = "Loading…";
    let d: GraphData;
    try {
      d = await api.graph(this.app.repo, from, to);
    } catch (e) {
      if (gen === this.gen) this.info.textContent = `Couldn't load the graph: ${e instanceof Error ? e.message : e}`;
      return;
    }
    if (gen !== this.gen) return;
    this.data = d;
    const n = this.app.tl.n;
    const st = d.steps;
    this.info.textContent = st.length
      ? `#${fmt.int(d.from + 1)}–#${fmt.int(d.to + 1)} of ${fmt.int(n)} · ${fmt.date(st[0].time)} to ${fmt.date(st[st.length - 1].time)} · ${fmt.int(d.branches.length)} merged branches`
      : "No commits";
    this.older.disabled = d.from <= 0;
    this.newer.disabled = d.to >= n - 1;
    // Folder colors rank by how many branches in the window changed each folder most.
    const count = new Map<string, number>();
    for (const b of d.branches) if (b.dir !== null) count.set(b.dir, (count.get(b.dir) ?? 0) + 1);
    this.dirs.reset();
    this.dirs.assign([...count.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k]) => k));
    this.render();
    const L = this.layout;
    if (!L) return;
    const w = this.scroller.clientWidth;
    // the main line and the size band sit at the bottom, under the lanes
    this.scroller.scrollTop = this.scroller.scrollHeight;
    if (scroll === "start") this.scroller.scrollLeft = 0;
    else if (scroll === "end") this.scroller.scrollLeft = L.width;
    else {
      const cur = this.app.store.get().cursor;
      const i = Math.max(0, Math.min(st.length - 1, cur - d.from));
      this.scroller.scrollLeft = Math.max(0, ML + L.xs[i] - w * 0.6);
    }
  }

  private colorOf(b: GraphData["branches"][number]): { key: string; color: string } {
    if (this.colorBy === "author") {
      const k = b.top_author ?? "";
      return { key: k, color: colorMaps.author.color(k) };
    }
    const k = b.dir ?? "\u0000";
    return { key: k, color: this.dirs.color(k) };
  }

  private computeLayout(d: GraphData): Layout {
    const st = d.steps;
    const n = st.length;
    // x per first-parent commit: proportional to the gap up to MAX_DX, measured in median gaps
    const gaps = [];
    for (let i = 1; i < n; i++) if (st[i].time > st[i - 1].time) gaps.push(st[i].time - st[i - 1].time);
    gaps.sort((a, b) => a - b);
    const unit = gaps.length ? gaps[gaps.length >> 1] : 60;
    const xs = new Float64Array(n);
    const breaks: Layout["breaks"] = [];
    for (let i = 1; i < n; i++) {
      const g = st[i].time - st[i - 1].time;
      const dx = Math.min(MAX_DX, MIN_DX + (PX_PER_UNIT * g) / unit);
      xs[i] = xs[i - 1] + dx;
      if (g > BREAK_UNITS * unit && g >= 3600) breaks.push({ x0: xs[i - 1], x1: xs[i], t0: st[i - 1].time, t1: st[i].time });
    }
    const t0 = n ? st[0].time : 0;
    const tn = n ? st[n - 1].time : 0;
    /** x (from the plot's left edge) of time t, by the commits on either side; null before the window. */
    const X = (t: number): number => {
      if (!n || t <= t0) return 0;
      if (t >= tn) return xs[n - 1];
      let lo = 0;
      let hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (st[mid].time <= t) lo = mid;
        else hi = mid;
      }
      const span = st[hi].time - st[lo].time;
      return xs[lo] + (span > 0 ? ((xs[hi] - xs[lo]) * (t - st[lo].time)) / span : 0);
    };
    const sideBy = new Map<number, Side[]>();
    for (const s of d.side) {
      const a = sideBy.get(s.step);
      if (a) a.push(s);
      else sideBy.set(s.step, [s]);
    }
    const branches: Branch[] = d.branches.map((b, i) => {
      const at = b.step - d.from;
      const x1 = xs[at];
      const side = sideBy.get(b.step) ?? [];
      const cut = b.first < t0;
      let x0: number;
      if (cut) {
        // starts with a stub before its first commit inside the window
        const inside = side.find((s) => s.author_time >= t0);
        x0 = Math.max(0, (inside ? X(inside.author_time) : x1) - STUB);
      } else x0 = X(b.first);
      x0 = Math.max(0, Math.min(x0, x1 - 24));
      const { key, color } = this.colorOf(b);
      return { i, step: b.step, at, name: branchName(st[at]?.summary ?? ""), key, color, x0, x1, cut, lane: 0, room: 0, side };
    });
    // lanes: the shortest branches nearest the main line, each in the lowest lane it fits
    const taken: [number, number][][] = [];
    for (const b of [...branches].sort((a, c) => a.x1 - a.x0 - (c.x1 - c.x0) || a.x0 - c.x0)) {
      let l = taken.findIndex((spans) => spans.every(([a, z]) => b.x1 + 14 < a || z + 14 < b.x0));
      if (l < 0) l = taken.push([]) - 1;
      taken[l].push([b.x0, b.x1]);
      b.lane = l;
    }
    const width = (n ? xs[n - 1] : 0);
    const next = new Map<number, number>();
    for (const b of [...branches].sort((a, c) => c.x0 - a.x0)) {
      b.room = (next.get(b.lane) ?? width + MR) - b.x0 - 16;
      next.set(b.lane, b.x0);
    }
    return { xs, X, breaks, branches, lanes: taken.length, width: ML + width + MR };
  }

  private render() {
    if (!this.shown || !this.data) return;
    const d = this.data;
    const st = d.steps;
    if (!st.length) {
      this.host.replaceChildren(h("div", { class: "gempty", text: "No commits" }));
      this.legend.replaceChildren();
      this.layout = null;
      return;
    }
    const L = (this.layout = this.computeLayout(d));
    const { xs, X, breaks, branches, lanes } = L;
    const p = palette();
    const W = L.width;
    const n = st.length;
    const px = (x: number) => (ML + x).toFixed(1);

    // tags: dashed lines, labels in the first row where they fit
    const tags = this.app.summary.tags.filter((t) => t.step >= d.from && t.step <= d.to);
    const rowEnd: number[] = [];
    const tagRows = tags.map((t) => {
      const x = ML + xs[t.step - d.from];
      const w = t.name.length * 6.2 + 10;
      let row = rowEnd.findIndex((e) => e < x);
      if (row < 0 && rowEnd.length < TAG_ROWS) row = rowEnd.push(0) - 1;
      if (row >= 0) rowEnd[row] = x + w;
      return row;
    });
    const LH = lanes > 120 ? 7 : lanes > 40 ? 11 : lanes > 20 ? 16 : 24;
    const TOP = 16 + rowEnd.length * TAG_ROW_H;
    const yLane = (l: number) => TOP + (lanes - 1 - l) * LH + LH / 2;
    const yMain = TOP + lanes * LH + 22;
    const bandT = yMain + 26;
    const bandH = 64;
    const axisY = bandT + bandH + 10;
    const H = axisY + 34;

    let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Commit graph"${LH < 11 ? ` class="dense"` : ""}>`;

    // squeezed gaps, then date ticks outside them
    for (const b of breaks) {
      const days = (b.t1 - b.t0) / 86400;
      const what = days >= 2 ? `${Math.round(days)} days` : `${((b.t1 - b.t0) / 3600).toFixed(1)} h`;
      s += `<rect class="gbreak" x="${px(b.x0 + 3)}" y="${TOP - 6}" width="${Math.max(1, b.x1 - b.x0 - 6)}" height="${axisY - TOP + 6}" data-k="g:${esc(what)}"/>`;
      const xm = ML + (b.x0 + b.x1) / 2;
      s += `<path class="gzig" d="M${xm - 6},${axisY} l3,-4 l3,8 l3,-8 l3,4"/>`;
    }
    const t0 = st[0].time;
    const tn = st[n - 1].time;
    const ticks = axisTicks(t0, tn, breaks, xs[n - 1]);
    let lastX = -Infinity;
    let lastRow2 = "";
    for (const t of ticks.times) {
      const x = ML + X(t);
      if (x - lastX < AXIS_GAP) continue;
      lastX = x;
      const [l1, l2] = ticks.label(t);
      s += `<line class="gtick" x1="${x}" x2="${x}" y1="${TOP - 6}" y2="${axisY}"/>`;
      s += `<text class="gaxis" x="${x}" y="${axisY + 14}" text-anchor="middle">${l1}</text>`;
      if (l2 && l2 !== lastRow2) s += `<text class="gaxis" x="${x}" y="${axisY + 28}" text-anchor="middle">${l2}</text>`;
      lastRow2 = l2;
    }
    s += `<line class="gaxisline" x1="${ML}" x2="${px(xs[n - 1])}" y1="${axisY}" y2="${axisY}"/>`;

    // the codebase's size: from 0 when the window starts at the first commit, else from near its least
    let hi = 0;
    let lo = Infinity;
    for (const c of st) {
      hi = Math.max(hi, c.lines);
      lo = Math.min(lo, c.lines);
    }
    const base = d.from === 0 ? 0 : Math.max(0, lo - (hi - lo) * 0.15);
    const yS = (v: number) => bandT + bandH - (hi > base ? ((v - base) / (hi - base)) * bandH : bandH / 2);
    let area = `M${px(xs[0])},${yS(st[0].lines).toFixed(1)}`;
    for (let i = 1; i < n; i++) area += `H${px(xs[i])}V${yS(st[i].lines).toFixed(1)}`;
    s += `<path class="gband" d="${area}V${bandT + bandH}H${px(xs[0])}Z"/><path class="gbandline" d="${area}"/>`;
    s += `<text class="gaxis" x="${ML - 8}" y="${bandT + 9}" text-anchor="end">${fmt.compact(hi)}</text>`;
    s += `<text class="gaxis" x="${ML - 8}" y="${bandT + bandH}" text-anchor="end">${fmt.compact(base)}</text>`;
    s += `<text class="gaxis" x="${ML - 8}" y="${bandT + bandH / 2 + 4}" text-anchor="end">lines</text>`;
    s += `<text class="gend" x="${px(xs[n - 1] + 8)}" y="${yS(st[n - 1].lines) + 4}">${fmt.int(st[n - 1].lines)}</text>`;

    // tags
    tags.forEach((t, i) => {
      const x = px(xs[t.step - d.from]);
      const row = tagRows[i];
      const ly = 12 + Math.max(0, row) * TAG_ROW_H;
      s += `<g class="gtag" data-k="t:${i}"><line x1="${x}" x2="${x}" y1="${row >= 0 ? ly + 4 : TOP - 6}" y2="${bandT + bandH}"/>`;
      if (row >= 0) s += `<text x="${Number(x) + 3}" y="${ly}">${esc(t.name)}</text>`;
      s += `<rect class="ghit" x="${Number(x) - 4}" y="0" width="8" height="${bandT + bandH}"/></g>`;
    });

    // the branch's own lane
    s += `<line class="gmain" x1="${px(xs[0])}" x2="${px(xs[n - 1])}" y1="${yMain}" y2="${yMain}"/>`;
    s += `<text class="glane" x="${ML - 8}" y="${yMain + 4}" text-anchor="end">${esc(trunc(this.app.meta.branch, 9))}</text>`;

    // merged branches
    const byStep = new Map<number, Branch>();
    // (dots go over every branch's line and hit area, so a later lane doesn't cover them)
    let dots = "";
    for (const b of branches) {
      byStep.set(b.step, b);
      const y = yLane(b.lane);
      const fx = ML + b.x0;
      const mx = ML + b.x1;
      const a = fx + 10;
      const z = Math.max(mx - 10, a + 2);
      const down = `H${z}C${mx},${y} ${mx},${(yMain + y) / 2} ${mx},${yMain}`;
      const path = b.cut ? `M${fx + STUB * 0.6},${y}${down}` : `M${fx},${yMain}C${fx},${(yMain + y) / 2} ${fx},${y} ${a},${y}${down}`;
      s += `<g class="gbr" data-k="b:${b.i}"><path class="gbrline" d="${path}" stroke="${b.color}"/>`;
      if (b.cut) s += `<path class="gbrline gstub" d="M${fx},${y}H${fx + STUB * 0.6}" stroke="${b.color}"/>`;
      s += `<path class="gbrhit" d="${b.cut ? `M${fx},${y}${down}` : path}"/>`;
      const room = Math.min(40, Math.floor(b.room / 6));
      if (LH >= 16 && room >= 4) s += `<text class="glbl" x="${a + 2}" y="${y - 5}">${esc(trunc(b.name, room))}</text>`;
      s += `</g>`;
      const sx = (t: number) => Math.min(Math.max(ML + X(t), a), z);
      const r = LH >= 16 ? 3.2 : LH >= 11 ? 2.6 : 2;
      b.side.forEach((c, j) => {
        if (b.cut && c.author_time < t0) return;
        dots += `<circle class="gc" cx="${sx(c.author_time).toFixed(1)}" cy="${y}" r="${r}" fill="${b.color}" data-k="s:${b.i}:${j}"/>`;
      });
    }
    s += dots;
    // first-parent commits; a merge takes its branch's color
    st.forEach((c, i) => {
      const b = c.is_merge ? byStep.get(c.step) : undefined;
      s += b
        ? `<circle class="gc gmerge" cx="${px(xs[i])}" cy="${yMain}" r="5" fill="${b.color}" data-k="m:${i}"/>`
        : `<circle class="gc${c.is_merge ? " gmerge" : ""}" cx="${px(xs[i])}" cy="${yMain}" r="${c.is_merge ? 4.5 : 3}" fill="${c.is_merge ? "var(--surface)" : "var(--ink)"}" data-k="m:${i}"/>`;
    });
    s += `<g class="gcur"><line y1="${TOP - 10}" y2="${axisY}"/><text y="${TOP - 12}"></text></g>`;
    s += `</svg>`;
    this.host.innerHTML = s;
    this.cursorLine = this.host.querySelector<SVGGElement>("g.gcur");
    this.paintCursor();

    // legend: the colors in use, then main
    const used = new Map<string, string>();
    for (const b of branches) if (!used.has(b.key)) used.set(b.key, b.color);
    const slotted = this.colorBy === "author" ? colorMaps.author : this.dirs;
    const items = [...used.keys()].filter((k) => slotted.slot(k) >= 0).sort((a, b) => slotted.slot(a) - slotted.slot(b));
    const label = (k: string) => this.colorBy === "author" ? k || "unknown" : k === "" ? "(root files)" : `${k}/`;
    const chip = (color: string, text: string) => h("span", { class: "it" }, swatch(color), h("span", { class: "l", text }));
    this.legend.replaceChildren(
      ...items.map((k) => chip(used.get(k) ?? p.other, label(k))),
      items.length < used.size ? chip(p.other, this.colorBy === "author" ? "other authors" : "other folders") : "",
      chip(p.ink, `${this.app.meta.branch} (first parent)`),
    );
  }

  /** Move the cursor's line; hide it when the cursor is outside the window. */
  private paintCursor() {
    const g = this.cursorLine;
    const L = this.layout;
    const d = this.data;
    if (!g || !L || !d || !this.shown) return;
    const cur = this.app.store.get().cursor;
    const inside = cur >= d.from && cur <= d.to;
    g.style.display = inside ? "" : "none";
    if (!inside) return;
    const x = (ML + L.xs[cur - d.from]).toFixed(1);
    const line = g.querySelector("line");
    const text = g.querySelector("text");
    line?.setAttribute("x1", x);
    line?.setAttribute("x2", x);
    if (text) {
      text.setAttribute("x", String(Number(x) + 4));
      text.textContent = `cursor #${fmt.int(cur + 1)}`;
    }
  }

  private target(e: Event): string[] | null {
    const el = (e.target as Element).closest<SVGElement>("[data-k]");
    return el ? (el.dataset.k ?? "").split(":") : null;
  }

  private hover(e: PointerEvent) {
    const k = this.target(e);
    const d = this.data;
    const L = this.layout;
    if (!k || !d || !L) return tooltip.hide();
    const row = (a: string, b: string) => h("div", { class: "row" }, h("span", { class: "n", text: a }), h("span", { class: "v", text: b }));
    let body: HTMLElement | null = null;
    if (k[0] === "m") {
      const c = d.steps[Number(k[1])];
      const b = c.is_merge ? L.branches.find((x) => x.step === c.step) : undefined;
      body = h("div", {},
        h("div", { class: "h", text: c.summary || "(no message)" }),
        h("div", { class: "sub", text: `#${fmt.int(c.step + 1)} · ${c.sha.slice(0, 7)} · ${c.author ?? "unknown"} · ${fmt.datetime(c.time)}` }),
        row("Lines changed", `+${fmt.int(c.adds)} / −${fmt.int(c.dels)}`),
        row("Codebase after", `${fmt.int(c.lines)} lines`),
        c.is_merge ? row("Brought in", `${fmt.int(c.side_count)} commits${b ? ` by ${d.branches[b.i].authors} ${d.branches[b.i].authors === 1 ? "author" : "authors"}` : ""}`) : null,
      );
    } else if (k[0] === "s") {
      const b = L.branches[Number(k[1])];
      const c = b.side[Number(k[2])];
      body = h("div", {},
        h("div", { class: "h", text: c.summary || "(no message)" }),
        h("div", { class: "sub", text: `${c.sha.slice(0, 7)} · ${c.author ?? "unknown"} · authored ${fmt.datetime(c.author_time)}` }),
        h("div", { class: "sub", text: `on ${b.name}, merged in #${fmt.int(b.step + 1)}` }),
      );
    } else if (k[0] === "b") {
      const b = L.branches.find((x) => x.i === Number(k[1]));
      if (!b) return tooltip.hide();
      const r = d.branches[b.i];
      const m = d.steps[b.at];
      body = h("div", {},
        h("div", { class: "h", text: b.name }),
        row("Commits", fmt.int(r.commits)),
        row("Authors", `${fmt.int(r.authors)}${r.top_author ? ` (most by ${r.top_author})` : ""}`),
        row("Changed most", r.dir === null ? "nothing" : r.dir === "" ? "root files" : `${r.dir}/`),
        row("Merge's lines", `+${fmt.int(m.adds)} / −${fmt.int(m.dels)}`),
        row("First commit", `${fmt.datetime(r.first)}${b.cut ? " (before this window)" : ""}`),
        row("Merged", `${fmt.datetime(m.time)} (#${fmt.int(b.step + 1)})`),
        r.commits > b.side.length ? h("div", { class: "sub", text: `Dots show its newest ${fmt.int(b.side.length)} commits.` }) : null,
      );
    } else if (k[0] === "t") {
      const tags = this.app.summary.tags.filter((t) => t.step >= d.from && t.step <= d.to);
      const t = tags[Number(k[1])];
      if (t) body = h("div", {}, h("div", { class: "h", text: `Tag ${t.name}` }), h("div", { class: "sub", text: `#${fmt.int(t.step + 1)} · ${fmt.datetime(t.time)}` }));
    } else if (k[0] === "g") {
      body = h("div", {}, h("div", { class: "h", text: `${k.slice(1).join(":")} without commits` }), h("div", { class: "sub", text: "squeezed" }));
    }
    if (body) tooltip.show(e.clientX, e.clientY, body);
    else tooltip.hide();
  }

  private click(e: MouseEvent) {
    const k = this.target(e);
    const d = this.data;
    const L = this.layout;
    if (!k || !d || !L) return;
    let step = -1;
    if (k[0] === "m") step = d.steps[Number(k[1])].step;
    else if (k[0] === "s") step = L.branches[Number(k[1])].step;
    else if (k[0] === "b") step = d.branches[Number(k[1])].step;
    else if (k[0] === "t") step = this.app.summary.tags.filter((t) => t.step >= d.from && t.step <= d.to)[Number(k[1])]?.step ?? -1;
    if (step >= 0) this.app.player.seek(step);
  }
}

const HOUR = 3600;
const DAY = 86400;
/** Tick units, smallest first: fixed spans, then calendar months and years. */
const UNITS: { secs: number; months?: number }[] = [
  { secs: HOUR }, { secs: 3 * HOUR }, { secs: 6 * HOUR }, { secs: 12 * HOUR },
  { secs: DAY }, { secs: 7 * DAY }, { secs: 0, months: 1 }, { secs: 0, months: 3 }, { secs: 0, months: 12 },
];

/**
 * Time ticks for the axis: the smallest unit whose ticks fall about AXIS_GAP px apart on
 * average. A boundary inside a squeezed gap labels the first commit after it instead. Labels
 * are UTC, like the rest of the dashboard.
 */
function axisTicks(t0: number, tn: number, breaks: Layout["breaks"], width: number) {
  const out: number[] = [];
  /** A boundary inside a squeezed gap moves to the first commit after it. */
  const push = (t: number) => {
    const b = breaks.find((g) => t > g.t0 && t < g.t1);
    const at = b ? b.t1 : t;
    if (out[out.length - 1] !== at) out.push(at);
  };
  const gen = (u: (typeof UNITS)[number]): number[] => {
    out.length = 0;
    if (u.months) {
      // months since year 0; the first boundary at or after t0, on a multiple of the unit
      const d = new Date(t0 * 1000);
      let k = d.getUTCFullYear() * 12 + d.getUTCMonth();
      if (Date.UTC(Math.floor(k / 12), k % 12, 1) / 1000 < t0) k++;
      k = Math.ceil(k / u.months) * u.months;
      for (let t; (t = Date.UTC(Math.floor(k / 12), k % 12, 1) / 1000) <= tn; k += u.months) push(t);
      return [...out];
    }
    if ((tn - t0) / u.secs > 20000) return [];
    // (weeks start on Monday: 1970-01-01 was a Thursday)
    const off = u.secs === 7 * DAY ? 4 * DAY : 0;
    for (let t = Math.ceil((t0 - off) / u.secs) * u.secs + off; t <= tn; t += u.secs) push(t);
    return [...out];
  };
  let unit = UNITS[UNITS.length - 1];
  let times: number[] = [];
  for (const u of UNITS) {
    const ts = gen(u);
    if (ts.length && width / ts.length >= AXIS_GAP * 0.8) {
      unit = u;
      times = ts;
      break;
    }
  }
  if (!times.length) times = gen(unit);
  const iso = (t: number) => new Date(t * 1000).toISOString();
  const label = (t: number): [string, string] => {
    const s = iso(t);
    if (unit.months) return unit.months >= 12 ? [s.slice(0, 4), ""] : [s.slice(0, 7), ""];
    if (unit.secs >= DAY) return [s.slice(5, 10), s.slice(0, 4)];
    return [s.slice(11, 16), s.slice(0, 10)];
  };
  return { times, label };
}

/** A short name for a merged branch, from its merge's subject. */
export function branchName(subject: string): string {
  const m = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(subject)
    ?? /^Merge pull request #\d+ from (\S+)/.exec(subject)
    ?? /^Merge tag '([^']+)'/.exec(subject)
    ?? /^Merge branch (\S+)/.exec(subject);
  if (m) return m[1];
  return subject.replace(/^Merge\s+/, "") || "(no message)";
}

function swatch(color: string): HTMLElement {
  const el = h("span", { class: "sw" });
  el.style.background = color;
  return el;
}

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
