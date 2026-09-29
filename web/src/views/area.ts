import { scaleLinear } from "d3";
import { api, col, filterParams, strCol } from "../api/client";
import type { App } from "../app";
import { colorMaps } from "../model/colors";
import { bucketOfLabel, cohortColor, cohortRange, cohortUnit } from "../model/slices";
import type { Painter } from "../paint/painter";
import type { AreaSlice } from "../state/store";
import { palette } from "../theme";
import { fmt, h, icon } from "../ui/dom";
import { tipRow, tooltip } from "../ui/tooltip";
import { TimeStrip } from "./timestrip";
import { View } from "./view";

interface Series {
  key: string;
  /** size: cumulative lines per bin; flow: additions per bin */
  up: Float64Array;
  /** flow only: deletions per bin */
  down: Float64Array;
}

interface AreaData {
  key: string;
  slice: AreaSlice;
  mode: "size" | "flow";
  bins: number;
  lo: number;
  hi: number;
  /** Bins [first, last] that actually contain steps. */
  firstBin: number;
  lastBin: number;
  series: Series[];
}

const SLICE_LABEL: Record<AreaSlice, string> = {
  dir: "directory",
  lang: "language",
  author: "author (surviving lines)",
  cohort: "when lines were written (survival)",
};

/** Stacked area of repo size (or churn) sliced by directory, language, author or cohort. */
export class AreaView extends View {
  private strip: TimeStrip;
  private data: AreaData | null = null;
  private abort: AbortController | null = null;
  private hoverBin = -1;
  private isolated: string | null = null;
  private tableEl: HTMLElement | null = null;
  private sliceSel: HTMLSelectElement;
  private modeSel: HTMLSelectElement;
  private extraSel: HTMLSelectElement;

  constructor(private app: App) {
    super("area", "Repository size");
    this.strip = new TimeStrip(app, { left: 52, right: 12, top: 16, bottom: 20 });
    const st = app.store.get().settings;
    this.sliceSel = h("select", { "aria-label": "Slice by" },
      h("option", { value: "dir", text: "by directory" }),
      h("option", { value: "lang", text: "by language" }),
      h("option", { value: "author", text: "by author" }),
      h("option", { value: "cohort", text: "by when written" }),
    );
    this.sliceSel.value = st.areaSlice;
    this.sliceSel.addEventListener("change", () => app.store.setSettings({ areaSlice: this.sliceSel.value as AreaSlice }));
    this.modeSel = h("select", { "aria-label": "Mode" },
      h("option", { value: "size", text: "size" }),
      h("option", { value: "flow", text: "added / deleted" }),
    );
    this.modeSel.value = st.areaMode;
    this.modeSel.addEventListener("change", () => app.store.setSettings({ areaMode: this.modeSel.value as "size" | "flow" }));
    this.extraSel = h("select", { "aria-label": "Granularity" });
    this.extraSel.addEventListener("change", () => {
      const v = this.extraSel.value;
      if (app.store.get().settings.areaSlice === "cohort") app.store.setSettings({ cohortUnit: v as "auto" | "year" | "quarter" | "month" });
      else app.store.setSettings({ areaDepth: Number(v) });
    });
    const tableBtn = h("button", { class: "btn icon", title: "Table view", "aria-label": "Table view" }, icon("table"));
    tableBtn.addEventListener("click", () => this.toggleTable(tableBtn));
    this.addControl(this.sliceSel);
    this.addControl(this.extraSel);
    this.addControl(this.modeSel);
    this.addControl(tableBtn);
    this.syncControls();
    app.store.watch(
      (s) => [s.brush, s.settings.axis, s.filterRev, s.settings.areaSlice, s.settings.areaMode, s.settings.areaDepth, s.settings.cohortUnit],
      () => {
        this.syncControls();
        this.refetch();
      },
    );
    app.store.watch((s) => [s.cursor, s.compare, s.search?.steps.length, s.settings.theme, s.settings.diffColors], () => this.invalidate());
  }

  private syncControls() {
    const st = this.app.store.get().settings;
    this.sliceSel.value = st.areaSlice;
    this.modeSel.value = st.areaMode;
    const opts: [string, string][] =
      st.areaSlice === "cohort"
        ? [["auto", "auto"], ["year", "per year"], ["quarter", "per quarter"], ["month", "per month"]]
        : st.areaSlice === "dir"
          ? [["1", "depth 1"], ["2", "depth 2"], ["3", "depth 3"]]
          : [];
    this.extraSel.replaceChildren(...opts.map(([v, t]) => h("option", { value: v, text: t })));
    this.extraSel.style.display = opts.length ? "" : "none";
    this.extraSel.value = st.areaSlice === "cohort" ? st.cohortUnit : String(st.areaDepth);
    const title = this.head.querySelector("h2")!;
    title.textContent = st.areaMode === "size" ? `Repository size by ${SLICE_LABEL[st.areaSlice]}` : `Lines added / deleted by ${SLICE_LABEL[st.areaSlice]}`;
  }

  protected onResize() {
    this.refetch();
  }

  refetch() {
    const s = this.app.store.get();
    if (!s.repo || this.width < 10) return;
    const [a, b] = this.strip.update(this.width);
    const st = s.settings;
    const bins = Math.max(2, Math.min(Math.floor(this.strip.plotW / 2), st.axis === "index" ? b - a + 1 : 100_000));
    const p = filterParams(s);
    p.set("axis", st.axis);
    p.set("lo", String(this.strip.lo));
    p.set("hi", String(this.strip.hi));
    p.set("bins", String(bins));
    p.set("slice", st.areaSlice);
    p.set("mode", st.areaMode);
    p.set("depth", String(st.areaDepth));
    p.set("unit", cohortUnit(this.app));
    p.set("top", "8");
    const key = p.toString();
    if (this.data?.key === key) return;
    this.abort?.abort();
    const ctl = new AbortController();
    this.abort = ctl;
    this.setLoading(true);
    api
      .area(s.repo, p, ctl.signal)
      .then((t) => {
        if (ctl.signal.aborted) return;
        this.data = this.pivot(key, st.areaSlice, st.areaMode, bins, t);
        this.isolated = null;
        this.setLoading(false);
        this.renderLegend();
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

  private pivot(key: string, slice: AreaSlice, mode: "size" | "flow", bins: number, t: import("apache-arrow").Table): AreaData {
    const bin = col(t, "bin");
    const keys = strCol(t, "key");
    const map = new Map<string, Series>();
    const get = (k: string) => {
      let s = map.get(k);
      if (!s) {
        s = { key: k, up: new Float64Array(bins).fill(NaN), down: new Float64Array(bins) };
        map.set(k, s);
      }
      return s;
    };
    const baseline = new Map<string, number>();
    if (mode === "size") {
      const v = col(t, "value");
      for (let i = 0; i < bin.length; i++) {
        if (bin[i] < 0) baseline.set(keys[i], v[i]);
        else get(keys[i]).up[bin[i]] = v[i];
      }
      for (const k of baseline.keys()) get(k);
      for (const s of map.values()) {
        let last = baseline.get(s.key) ?? 0;
        for (let i = 0; i < bins; i++) {
          if (Number.isNaN(s.up[i])) s.up[i] = last;
          else last = s.up[i];
        }
      }
    } else {
      const ad = col(t, "adds");
      const de = col(t, "dels");
      for (let i = 0; i < bin.length; i++) {
        const s = get(keys[i]);
        if (Number.isNaN(s.up[bin[i]])) s.up[bin[i]] = 0;
        s.up[bin[i]] += ad[i];
        s.down[bin[i]] += de[i];
      }
      for (const s of map.values()) for (let i = 0; i < bins; i++) if (Number.isNaN(s.up[i])) s.up[i] = 0;
    }
    // Largest at the bottom; "(other)" always on top. Cohorts stack oldest at the bottom.
    let series = [...map.values()];
    const weight = (s: Series) => (mode === "size" ? Math.max(...s.up) : s.up.reduce((a, b) => a + b, 0) + s.down.reduce((a, b) => a + b, 0));
    if (slice === "cohort") series.sort((a, b) => (a.key === "(other)" ? 1 : b.key === "(other)" ? -1 : a.key < b.key ? -1 : 1));
    else series.sort((a, b) => (a.key === "(other)" ? 1 : b.key === "(other)" ? -1 : weight(b) - weight(a)));
    series = series.filter((s) => weight(s) > 0);
    // Stable colors: rank order assigns fixed slots, which persist across filters.
    const cm = this.colorMap(slice);
    cm?.assign(series.map((s) => s.key));
    // bins that contain any step
    const [a, b] = this.app.store.get().brush ?? [0, this.app.store.get().steps - 1];
    const w = (this.strip.hi - this.strip.lo) / bins;
    const firstBin = Math.max(0, Math.floor((this.app.tl.x(a, this.strip.axis) - this.strip.lo) / w));
    const lastBin = Math.min(bins - 1, Math.floor((this.app.tl.x(b, this.strip.axis) - this.strip.lo) / w));
    return { key, slice, mode, bins, lo: this.strip.lo, hi: this.strip.hi, firstBin, lastBin, series };
  }

  private colorMap(slice: AreaSlice) {
    return slice === "dir" ? colorMaps.dir : slice === "lang" ? colorMaps.lang : slice === "author" ? colorMaps.author : null;
  }

  color(key: string): string {
    const d = this.data;
    if (!d) return palette().other;
    if (key === "(other)") return palette().other;
    if (d.slice === "cohort") {
      // Placed by time, like the treemap's cohort colors.
      const unit = cohortUnit(this.app);
      const [first, last] = cohortRange(this.app, unit);
      return cohortColor(bucketOfLabel(key, unit), first, last);
    }
    return this.colorMap(d.slice)!.color(key);
  }

  private renderLegend() {
    const d = this.data;
    if (!d) return;
    const items = [...d.series].reverse().map((s) => {
      const sw = h("span", { class: "sw" });
      sw.style.background = this.color(s.key);
      const it = h("span", { class: `it${this.isolated && this.isolated !== s.key ? " dim" : ""}`, title: s.key, tabindex: 0, role: "button" }, sw, h("span", { class: "l", text: s.key }));
      it.addEventListener("click", () => this.activate(s.key));
      it.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Enter") this.activate(s.key);
      });
      return it;
    });
    this.legend.replaceChildren(...items);
  }

  /** Legend/layer click: drill into a directory, filter a language/author, or isolate a layer. */
  private activate(key: string) {
    const d = this.data;
    if (!d || key === "(other)") return;
    const s = this.app.store.get();
    if (d.slice === "dir" && key !== "(files)") {
      const root = s.root ? `${s.root}/${key}` : key;
      this.app.store.set({ root });
    } else if (d.slice === "lang") {
      this.app.store.set({ langs: s.langs.length === 1 && s.langs[0] === key ? [] : [key] });
    } else if (d.slice === "author") {
      const a = this.app.authors.find((x) => x.name === key);
      if (a) this.app.store.set({ authors: s.authors.length === 1 && s.authors[0] === a.id ? [] : [a.id] });
    } else {
      this.isolated = this.isolated === key ? null : key;
      this.renderLegend();
      this.invalidate();
    }
  }

  private stack(): { tops: Float64Array[]; bottoms: Float64Array[]; max: number; min: number } {
    const d = this.data!;
    const n = d.bins;
    const tops: Float64Array[] = [];
    const bottoms: Float64Array[] = [];
    const accUp = new Float64Array(n);
    const accDown = new Float64Array(n);
    let max = 1;
    let min = 0;
    for (const s of d.series) {
      const iso = this.isolated && this.isolated !== s.key;
      const b0 = Float64Array.from(accUp);
      for (let i = 0; i < n; i++) accUp[i] += iso ? 0 : s.up[i];
      tops.push(Float64Array.from(accUp));
      bottoms.push(b0);
      if (d.mode === "flow") {
        const d0 = Float64Array.from(accDown);
        for (let i = 0; i < n; i++) accDown[i] -= iso ? 0 : s.down[i];
        tops.push(d0);
        bottoms.push(Float64Array.from(accDown));
      }
    }
    for (let i = d.firstBin; i <= d.lastBin; i++) {
      max = Math.max(max, accUp[i]);
      min = Math.min(min, accDown[i]);
    }
    return { tops, bottoms, max, min };
  }

  draw(p: Painter) {
    this.drawStatic(p);
    this.drawOverlay(p);
  }

  protected staticKey(): string | null {
    const s = this.app.store.get();
    return `${this.data?.key}|${this.isolated}|${s.search?.q}|${s.search?.steps.length}|${this.width}x${this.height}`;
  }

  protected drawOverlay(p: Painter) {
    const pal = palette();
    const m = this.strip.m;
    const bottomY = this.height - m.bottom;
    this.strip.update(this.width);
    const d = this.data;
    if (d && this.hoverBin >= 0 && this.hoverBin >= d.firstBin && this.hoverBin <= d.lastBin) {
      const w = (d.hi - d.lo) / d.bins;
      const x = this.strip.px(d.lo + (this.hoverBin + 0.5) * w);
      p.line(x, m.top, x, bottomY, pal.inkMuted, 1);
    }
    this.strip.drawSelection(p, m.top, bottomY);
    this.strip.drawCursor(p, m.top - 4, bottomY);
  }

  protected drawStatic(p: Painter) {
    const pal = palette();
    const m = this.strip.m;
    this.strip.update(this.width);
    const d = this.data;
    const bottomY = this.height - m.bottom;
    if (!d || !d.series.length) {
      this.strip.drawXAxis(p, this.height);
      if (d) p.text("No lines in this selection", this.width / 2, this.height / 2, { color: pal.inkMuted, size: 12, align: "center" });
      return;
    }
    const { tops, bottoms, max, min } = this.stack();
    const y = scaleLinear().domain([min, max]).nice(4).range([bottomY, m.top]);
    for (const t of y.ticks(4)) {
      const yy = Math.round(y(t)) + 0.5;
      p.line(m.left, yy, m.left + this.strip.plotW, yy, t === 0 ? pal.axis : pal.grid, 1);
      p.text(t < 0 ? `−${fmt.compact(-t)}` : fmt.compact(t), m.left - 6, yy, { color: pal.inkMuted, size: 10, align: "right", baseline: "middle" });
    }
    // x of bin centers, restricted to bins that contain history
    const w = (d.hi - d.lo) / d.bins;
    const idx: number[] = [];
    for (let i = d.firstBin; i <= d.lastBin; i++) idx.push(i);
    const xs = idx.map((i) => this.strip.px(d.lo + (i + 0.5) * w));
    if (xs.length) {
      xs[0] = this.strip.px(Math.max(d.lo, this.app.tl.x((this.app.store.get().brush ?? [0])[0], this.strip.axis)));
    }
    const per = d.mode === "flow" ? 2 : 1;
    p.save();
    p.clip(m.left, m.top - 1, this.strip.plotW, bottomY - m.top + 2);
    d.series.forEach((s, si) => {
      for (let k = 0; k < per; k++) {
        const top = tops[si * per + k];
        const bot = bottoms[si * per + k];
        const ty = idx.map((i) => y(top[i]));
        const by = idx.map((i) => y(bot[i]));
        const c = this.color(s.key);
        const dim = this.isolated && this.isolated !== s.key;
        p.band(xs, ty, by, c, dim ? 0.08 : 0.78);
        // 1.5px surface gap separates stacked layers (no borders around marks)
        const edge: number[] = [];
        const edgeY = k === 0 ? ty : by;
        for (let j = 0; j < xs.length; j++) edge.push(xs[j], edgeY[j]);
        p.polyline(edge, pal.surface, 1.5);
      }
    });
    p.restore();
    this.strip.drawSearch(p, bottomY - 5);
    this.strip.drawTags(p, m.top - 4);
    this.strip.drawXAxis(p, this.height);
  }

  protected onPointerMove(x: number, _y: number, e: PointerEvent) {
    const d = this.data;
    if (!d || this.strip.drag) return;
    const w = (d.hi - d.lo) / d.bins;
    const bin = Math.floor((this.strip.ux(x) - d.lo) / w);
    if (bin < d.firstBin || bin > d.lastBin || x < this.strip.m.left || x > this.strip.m.left + this.strip.plotW) {
      this.hoverBin = -1;
      tooltip.hide();
      this.invalidate();
      return;
    }
    if (bin !== this.hoverBin) {
      this.hoverBin = bin;
      this.invalidate();
    }
    // One tooltip, every series at that x; value leads, name follows.
    const box = h("div");
    const step = this.app.tl.stepAt(d.lo + (bin + 0.5) * w, this.strip.axis);
    box.append(h("div", { class: "h", text: `${fmt.date(this.app.tl.time(step))} · #${fmt.int(step + 1)}` }));
    let total = 0;
    for (const s of [...d.series].reverse()) {
      const v = s.up[bin];
      if (d.mode === "size") {
        total += v;
        box.append(tipRow(this.color(s.key), fmt.int(v), s.key));
      } else if (v || s.down[bin]) {
        box.append(tipRow(this.color(s.key), `+${fmt.compact(v)} −${fmt.compact(s.down[bin])}`, s.key));
      }
    }
    if (d.mode === "size") box.append(tipRow(null, fmt.int(total), "total lines"));
    tooltip.show(e.clientX, e.clientY, box);
  }

  protected onPointerLeave() {
    this.hoverBin = -1;
    this.invalidate();
  }

  protected onPointerDown(x: number, _y: number, e: PointerEvent) {
    tooltip.hide();
    this.strip.pointerDown(x, e, this.canvas, () => this.invalidate());
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

  /** Table twin: each series at ~12 evenly spaced points. */
  private fillTable() {
    const d = this.data;
    const el = this.tableEl;
    if (!el || !d) return;
    const w = (d.hi - d.lo) / d.bins;
    const cols: number[] = [];
    const n = Math.min(12, d.lastBin - d.firstBin + 1);
    for (let k = 0; k < n; k++) cols.push(Math.round(d.firstBin + ((d.lastBin - d.firstBin) * k) / Math.max(1, n - 1)));
    const label = (bin: number) => fmt.date(this.app.tl.time(this.app.tl.stepAt(d.lo + (bin + 0.5) * w, this.strip.axis)));
    const tbody = h("tbody");
    for (const s of d.series) {
      tbody.append(h("tr", {}, h("td", { text: s.key }), ...cols.map((c) => h("td", { class: "num", text: d.mode === "size" ? fmt.int(s.up[c]) : `+${fmt.int(s.up[c])} −${fmt.int(s.down[c])}` }))));
    }
    el.replaceChildren(h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "Series" }), ...cols.map((c) => h("th", { text: label(c) })))), tbody));
  }
}
