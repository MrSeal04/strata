import { quantileSorted, scaleLinear, scaleSqrt, scaleSymlog } from "d3";
import { type CommitRow, api, col, filterParams } from "../api/client";
import type { App } from "../app";
import type { Painter } from "../paint/painter";
import { palette } from "../theme";
import { clipSelect, settingSelect } from "../ui/controls";
import { fmt, h, icon } from "../ui/dom";
import { tipRow, tooltip } from "../ui/tooltip";
import { TimeStrip } from "./timestrip";
import { View } from "./view";

interface BarData {
  key: string;
  bins: number;
  lo: number;
  hi: number;
  bin: Float64Array;
  adds: Float64Array;
  dels: Float64Array;
  peak: Float64Array;
  peakStep: Float64Array;
  commits: Float64Array;
  first: Float64Array;
  last: Float64Array;
}

/** Per-commit additions (up) and deletions (down), binned to the pixel grid when dense. */
export class BarsView extends View {
  private strip: TimeStrip;
  private data: BarData | null = null;
  private abort: AbortController | null = null;
  private hoverBin = -1;
  private commitCache = new Map<string, CommitRow[]>();
  private tableEl: HTMLElement | null = null;

  constructor(private app: App) {
    super("bars", "Additions and deletions per commit");
    this.strip = new TimeStrip(app, { left: 52, right: 12, top: 16, bottom: 20 });
    const tableBtn = h("button", { class: "btn icon", title: "Table view", "aria-label": "Table view" }, icon("table"));
    tableBtn.addEventListener("click", () => this.toggleTable(tableBtn));
    this.addControl(settingSelect(app.store, "barScale", [["linear", "linear scale"], ["sqrt", "sqrt scale"], ["log", "log scale"]], {
      label: "Bar scale",
      title: "Compress tall bars so small commits stay visible",
    }));
    this.addControl(clipSelect(app.store, "clampPct", "area chart's added / deleted mode"));
    this.addControl(tableBtn);
    const s = app.store;
    s.watch((st) => [st.brush, st.settings.axis, st.filterRev], () => this.refetch());
    s.watch((st) => [st.cursor, st.search?.steps.length, st.compare, st.settings.barScale, st.settings.clampPct, st.settings.diffColors], () => this.invalidate());
    this.legendItems();
  }

  private legendItems() {
    const p = palette();
    const sw = (c: string) => {
      const e = h("span", { class: "sw" });
      e.style.background = c;
      return e;
    };
    this.legend.replaceChildren(
      h("span", { class: "it" }, sw(p.add), h("span", { class: "l", text: "Lines added (up)" })),
      h("span", { class: "it" }, sw(p.del), h("span", { class: "l", text: "Lines deleted (down)" })),
    );
  }

  protected onResize() {
    this.refetch();
  }

  refetch() {
    const s = this.app.store.get();
    if (!s.repo || this.width < 10) return;
    const [a, b] = this.strip.update(this.width);
    const steps = b - a + 1;
    // One bin per pixel, or one per step when zoomed in far enough.
    const bins = s.settings.axis === "index" ? Math.max(1, Math.min(Math.floor(this.strip.plotW), steps)) : Math.max(1, Math.floor(this.strip.plotW));
    const p = filterParams(s);
    p.set("axis", s.settings.axis);
    p.set("lo", String(this.strip.lo));
    p.set("hi", String(this.strip.hi));
    p.set("bins", String(bins));
    const key = p.toString();
    if (this.data?.key === key) return;
    this.abort?.abort();
    const ctl = new AbortController();
    this.abort = ctl;
    this.setLoading(true);
    api
      .bars(s.repo, p, ctl.signal)
      .then((t) => {
        if (ctl.signal.aborted) return;
        this.data = {
          key, bins, lo: this.strip.lo, hi: this.strip.hi,
          bin: col(t, "bin"), adds: col(t, "adds"), dels: col(t, "dels"), peak: col(t, "peak"),
          peakStep: col(t, "peak_step"), commits: col(t, "commits"), first: col(t, "first_step"), last: col(t, "last_step"),
        };
        this.commitCache.clear();
        this.setLoading(false);
        this.invalidate();
        if (this.tableEl) this.fillTable();
      })
      .catch((e) => {
        if (e.name !== "AbortError") {
          console.error(e);
          this.setLoading(false);
        }
      });
  }

  private scale(max: number, range: number) {
    const kind = this.app.store.get().settings.barScale;
    const dom: [number, number] = [0, Math.max(1, max)];
    if (kind === "sqrt") return scaleSqrt().domain(dom).range([0, range]);
    if (kind === "log") return scaleSymlog().domain(dom).range([0, range]);
    return scaleLinear().domain(dom).range([0, range]);
  }

  /** Clip level for outliers (percentile of the per-bin max), or +inf when off. */
  private clampLevel(d: BarData): number {
    const pct = this.app.store.get().settings.clampPct;
    if (!pct || pct >= 100) return Infinity;
    const vals = Array.from(d.adds, (v, i) => Math.max(v, d.dels[i])).filter((v) => v > 0).sort((a, b) => a - b);
    if (vals.length < 20) return Infinity;
    return Math.max(1, quantileSorted(vals, pct / 100) ?? Infinity);
  }

  private geometry() {
    const m = this.strip.m;
    const d = this.data!;
    const clamp = this.clampLevel(d);
    let maxA = 0;
    let maxD = 0;
    for (let i = 0; i < d.adds.length; i++) {
      maxA = Math.max(maxA, Math.min(clamp, d.adds[i]));
      maxD = Math.max(maxD, Math.min(clamp, d.dels[i]));
    }
    const plotH = this.height - m.top - m.bottom;
    const max = Math.max(maxA, maxD, 1);
    const sA = this.scale(max, 1)(maxA);
    const sD = this.scale(max, 1)(maxD);
    const upShare = Math.max(0.3, Math.min(0.75, sA / Math.max(1e-9, sA + sD) || 0.5));
    const base = m.top + plotH * upShare;
    const sc = this.scale(max, Math.max(plotH * upShare, plotH * (1 - upShare)) - 2);
    return { clamp, base, sc, plotH, upShare };
  }

  /** px extent of bin i. */
  private binPx(i: number): [number, number] {
    const d = this.data!;
    const w = (d.hi - d.lo) / d.bins;
    const x0 = this.strip.px(d.lo + d.bin[i] * w);
    const x1 = this.strip.px(d.lo + (d.bin[i] + 1) * w);
    return [x0, x1];
  }

  draw(p: Painter) {
    this.drawStatic(p);
    this.drawOverlay(p);
  }

  protected staticKey(): string | null {
    const s = this.app.store.get();
    const st = s.settings;
    return `${this.data?.key}|${st.barScale}|${st.clampPct}|${s.search?.q}|${s.search?.steps.length}|${this.width}x${this.height}`;
  }

  protected drawOverlay(p: Painter) {
    const pal = palette();
    const m = this.strip.m;
    const plotBottom = this.height - m.bottom;
    this.strip.update(this.width);
    const d = this.data;
    if (d && this.hoverBin >= 0 && this.hoverBin < d.bin.length) {
      const { clamp, base, sc } = this.geometry();
      let [x0, x1] = this.binPx(this.hoverBin);
      const slot = x1 - x0;
      if (slot >= 4) {
        const w = Math.min(24, slot - 2);
        x0 = x0 + (slot - w) / 2;
        x1 = x0 + w;
      } else x1 = Math.max(x1, x0 + 1);
      const aH = sc(Math.min(clamp, d.adds[this.hoverBin]));
      const dH = sc(Math.min(clamp, d.dels[this.hoverBin]));
      p.strokeRect(x0 - 1.5, base - aH - 1.5, x1 - x0 + 3, aH + dH + 4, pal.ink, 1, 0.6);
    }
    this.strip.drawSelection(p, m.top, plotBottom);
    this.strip.drawCursor(p, m.top - 4, plotBottom);
  }

  protected drawStatic(p: Painter) {
    const pal = palette();
    const m = this.strip.m;
    this.strip.update(this.width);
    const plotBottom = this.height - m.bottom;
    const d = this.data;
    if (!d || d.lo !== this.strip.lo || d.hi !== this.strip.hi) {
      if (!d) {
        this.strip.drawXAxis(p, this.height);
        return;
      }
    }
    const { clamp, base, sc } = this.geometry();
    // gridlines + y labels
    // Gridlines with labels at least 16px apart (sqrt/log scales bunch ticks near the top).
    const ticks = sc.ticks(3).filter((t) => t > 0);
    let lastUp = base;
    let lastDown = base;
    for (const t of ticks) {
      const yu = base - sc(t);
      const yd = base + sc(t);
      if (yu > m.top && lastUp - yu >= 16) {
        p.line(m.left, yu + 0.5, m.left + this.strip.plotW, yu + 0.5, pal.grid, 1);
        p.text(fmt.compact(t), m.left - 6, yu, { color: pal.inkMuted, size: 10, align: "right", baseline: "middle" });
        lastUp = yu;
      }
      if (yd < plotBottom && yd - lastDown >= 16) {
        p.line(m.left, yd + 0.5, m.left + this.strip.plotW, yd + 0.5, pal.grid, 1);
        p.text(`−${fmt.compact(t)}`, m.left - 6, yd, { color: pal.inkMuted, size: 10, align: "right", baseline: "middle" });
        lastDown = yd;
      }
    }
    const search = this.app.store.get().search;
    const matchSet = search?.steps.length ? search.steps : null;

    p.save();
    p.clip(m.left, m.top - 2, this.strip.plotW, plotBottom - m.top + 4);
    for (let i = 0; i < d.bin.length; i++) {
      let [x0, x1] = this.binPx(i);
      const slot = x1 - x0;
      // Thin marks: cap thickness at 24px, leave a 2px surface gap when there's room.
      if (slot >= 4) {
        const w = Math.min(24, slot - 2);
        x0 = x0 + (slot - w) / 2;
        x1 = x0 + w;
      } else {
        x1 = Math.max(x1, x0 + 1);
      }
      const w = x1 - x0;
      const r = w >= 6 ? 4 : 0;
      const aH = sc(Math.min(clamp, d.adds[i]));
      const dH = sc(Math.min(clamp, d.dels[i]));
      const alpha = 0.9;
      if (aH > 0) p.roundRect(x0, base - aH, w, aH, [r, r, 0, 0], pal.add, alpha);
      if (dH > 0) p.roundRect(x0, base + 1, w, dH, [0, 0, r, r], pal.del, alpha);
      // Clipped outliers get a marker at the cut, the true value lives in the tooltip.
      if (d.adds[i] > clamp) this.clipMark(p, (x0 + x1) / 2, base - aH - 4, true);
      if (d.dels[i] > clamp) this.clipMark(p, (x0 + x1) / 2, base + dH + 5, false);
    }
    p.restore();
    p.line(m.left, base + 0.5, m.left + this.strip.plotW, base + 0.5, pal.axis, 1);
    if (matchSet) this.strip.drawSearch(p, plotBottom - 5);
    this.strip.drawTags(p, m.top - 4);
    this.strip.drawXAxis(p, this.height);
  }

  private clipMark(p: Painter, x: number, y: number, up: boolean) {
    const pal = palette();
    p.text(up ? "▲" : "▼", x, y, { color: pal.ink, size: 8, align: "center", baseline: "middle" });
  }

  private binAt(x: number): number {
    const d = this.data;
    if (!d) return -1;
    // bins are sorted; binary search by px
    let lo = 0;
    let hi = d.bin.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const [x0, x1] = this.binPx(mid);
      if (x < x0 - 0.5) hi = mid - 1;
      else if (x > x1 + 0.5) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  protected onPointerMove(x: number, _y: number, e: PointerEvent) {
    if (this.strip.dragging) return;
    const onMarker = this.strip.hoverMarker(x, e, this.canvas);
    const i = onMarker ? -1 : this.binAt(x);
    if (i !== this.hoverBin) {
      this.hoverBin = i;
      this.invalidate();
    }
    if (i < 0 || !this.data) {
      if (!onMarker) tooltip.hide();
      return;
    }
    this.showTip(i, e.clientX, e.clientY);
  }

  private showTip(i: number, cx: number, cy: number) {
    const d = this.data!;
    const pal = palette();
    const first = d.first[i];
    const last = d.last[i];
    const n = d.commits[i];
    const tl = this.app.tl;
    const head = n === 1 ? `Commit #${fmt.int(first + 1)}` : `${fmt.int(n)} commits (#${fmt.int(first + 1)}–#${fmt.int(last + 1)})`;
    const box = h(
      "div",
      {},
      h("div", { class: "h", text: head }),
      h("div", { class: "sub", text: n === 1 ? fmt.datetime(tl.time(first)) : `${fmt.date(tl.time(first))} → ${fmt.date(tl.time(last))}` }),
      tipRow(pal.add, `+${fmt.int(d.adds[i])}`, "lines added"),
      tipRow(pal.del, `−${fmt.int(d.dels[i])}`, "lines deleted"),
    );
    const list = h("div", { class: "sub" });
    box.append(list);
    tooltip.show(cx, cy, box);
    const key = `${first}-${last}`;
    const fill = (rows: CommitRow[]) => {
      list.replaceChildren(
        ...rows.slice(0, 4).map((r) =>
          h("div", { style: "margin-top:4px;color:var(--ink-2)" },
            h("span", { class: "num", text: `+${fmt.compact(r.adds)} −${fmt.compact(r.dels)} ` }),
            h("span", { text: `${r.summary}` }),
            h("span", { class: "muted", text: ` — ${r.author}${r.side_count ? ` (+${r.side_count} merged)` : ""}` }),
          ),
        ),
      );
      if (this.hoverBin === i && this.pointer) tooltip.show(this.pointer.cx, this.pointer.cy, box);
    };
    const cached = this.commitCache.get(key);
    if (cached) fill(cached);
    else {
      const p = filterParams(this.app.store.get());
      p.set("first", String(first));
      p.set("last", String(last));
      p.set("limit", "4");
      api.commits(this.app.repo, p).then((rows) => {
        this.commitCache.set(key, rows);
        if (this.hoverBin === i) fill(rows);
      }).catch(() => {});
    }
  }

  protected onPointerLeave() {
    this.hoverBin = -1;
    this.invalidate();
  }

  protected onPointerDown(x: number, _y: number, e: PointerEvent) {
    tooltip.hide();
    const i = this.binAt(x);
    const before = this.app.store.get().cursor;
    this.strip.pointerDown(x, e, this.canvas, () => this.invalidate());
    // A click on a single-commit bar also opens its details.
    const onUp = () => {
      this.canvas.removeEventListener("pointerup", onUp);
      const d = this.data;
      if (d && i >= 0 && d.commits[i] === 1 && this.app.store.get().cursor !== before) this.app.openCommit(d.first[i]);
    };
    this.canvas.addEventListener("pointerup", onUp);
  }

  protected onDoubleClick() {
    this.app.store.set({ brush: null });
  }

  private toggleTable(btn: HTMLElement) {
    if (this.tableEl) {
      this.tableEl.remove();
      this.tableEl = null;
      btn.classList.remove("on");
      return;
    }
    btn.classList.add("on");
    this.tableEl = h("div", { class: "table-view" });
    this.body.append(this.tableEl);
    this.fillTable();
  }

  /** Table twin of the chart: the visible bins, largest churn first. */
  private fillTable() {
    const d = this.data;
    const el = this.tableEl;
    if (!el || !d) return;
    const tl = this.app.tl;
    const rows = [...d.bin.keys()].sort((a, b) => d.adds[b] + d.dels[b] - (d.adds[a] + d.dels[a])).slice(0, 500);
    const tbody = h("tbody");
    for (const i of rows) {
      tbody.append(
        h("tr", {},
          h("td", { text: d.commits[i] === 1 ? `#${fmt.int(d.first[i] + 1)}` : `#${fmt.int(d.first[i] + 1)}–#${fmt.int(d.last[i] + 1)}` }),
          h("td", { text: fmt.date(tl.time(d.first[i])) }),
          h("td", { class: "num", text: fmt.int(d.commits[i]) }),
          h("td", { class: "num", text: `+${fmt.int(d.adds[i])}` }),
          h("td", { class: "num", text: `−${fmt.int(d.dels[i])}` }),
        ),
      );
    }
    el.replaceChildren(
      h("table", {},
        h("thead", {}, h("tr", {}, h("th", { text: "Commits" }), h("th", { text: "Date" }), h("th", { text: "Count" }), h("th", { text: "Added" }), h("th", { text: "Deleted" }))),
        tbody,
      ),
    );
  }
}
