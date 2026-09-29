import { type HierarchyRectangularNode, treemapBinary } from "d3";
import type { App } from "../app";
import { clock } from "../clock";
import { colorMaps, inkOn } from "../model/colors";
import type { FileTree, TNode } from "../model/filetree";
import { COLOR_BY_LABEL, assignDirColors, cohortUnit, fileColor, growthColor, heat, heatColor, heatSpan } from "../model/slices";
import { SteadyLayout, layoutTree, livePadding } from "../model/steady";
import { GlRects } from "../paint/glrects";
import type { Painter } from "../paint/painter";
import type { ColorBy } from "../state/store";
import { palette } from "../theme";
import { fmt, h, icon } from "../ui/dom";
import { tipRow, tooltip } from "../ui/tooltip";
import { renderColorLegend } from "./colorlegend";
import { View } from "./view";
import { ZoomPan } from "./zoom";

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

type LNode = HierarchyRectangularNode<TNode>;

interface Pane {
  key: string;
  label: string | null;
  tree: FileTree;
  x: number;
  w: number;
  root: LNode | null;
  nodes: LNode[];
}

export class TreemapView extends View {
  private panes: Pane[] = [];
  /** Last rects of files that were just renamed away (so the new path can glide from there). */
  private renameRects = new Map<string, Rect>();
  /** Rects still easing toward the layout (separate from heat-only animation). */
  private geomMoving = false;
  /** Last frame's paint batches (reused while nothing moves). */
  private frame: {
    key: string;
    dirs: number[];
    groups: Map<string, { fill: string; alpha: number; xywh: number[] }>;
    labels: [string, number, number, number, string, boolean][];
  } | null = null;
  /** Folders drawn as a single rect (too small to show their files): folder -> its largest file. */
  private lod = new WeakMap<TNode, TNode>();
  private layoutKey = "";
  private layoutAt = 0;
  private hover: { pane: Pane; node: LNode } | null = null;
  private moving = false;
  private lastFrame = 0;
  private modeSel: HTMLSelectElement;
  private showSel: HTMLSelectElement;
  private extraSel: HTMLSelectElement;
  private measureSel: HTMLSelectElement;
  private layoutSel: HTMLSelectElement;
  /** Steady layout: files keep their end-of-range places while playing. */
  private steady: SteadyLayout;
  /** WebGL layer for the rect fills of large treemaps (null without WebGL2). */
  private gl: GlRects | null = null;
  private glActive = false;
  /** Wheel/pinch zoom and pan. Layouts are in world units (the unzoomed card) but computed at
   *  the zoomed size, so padding, folder headers and level of detail follow on-screen pixels. */
  readonly zoom: ZoomPan;
  private zoomBtn: HTMLButtonElement;
  /** Zoom the current layout was computed at. */
  private layoutK = 1;
  /** Layout + view the visible node lists were culled for. */
  private cullKey = "";

  constructor(private app: App) {
    super("treemap", "Files by size");
    this.gl = GlRects.create();
    if (this.gl) {
      const glCanvas = this.gl.canvas;
      glCanvas.style.display = "none";
      glCanvas.setAttribute("aria-hidden", "true");
      this.body.insertBefore(glCanvas, this.canvas);
      // GPU reset or too many contexts: fall back to Canvas2D for good.
      glCanvas.addEventListener("webglcontextlost", () => {
        glCanvas.remove();
        this.gl = null;
        this.glActive = false;
        this.invalidate();
      });
    }
    this.modeSel = h("select", { "aria-label": "Compare layout" }, h("option", { value: "overlay", text: "B, colored by change" }), h("option", { value: "side", text: "A and B side by side" }));
    this.modeSel.addEventListener("change", () => {
      const c = app.store.get().compare;
      if (c) app.store.set({ compare: { ...c, mode: this.modeSel.value as "overlay" | "side" } });
    });
    // What the squares show: the area chart's slices plus activity, with the slice's granularity.
    this.showSel = h("select", { "aria-label": "Show" }, ...(Object.keys(COLOR_BY_LABEL) as ColorBy[]).map((k) => h("option", { value: k, text: `by ${COLOR_BY_LABEL[k]}` })));
    this.showSel.addEventListener("change", () => app.store.setSettings({ colorBy: this.showSel.value as ColorBy }));
    this.extraSel = h("select", { "aria-label": "Granularity" });
    this.extraSel.addEventListener("change", () => {
      const v = this.extraSel.value;
      if (app.store.get().settings.colorBy === "cohort") app.store.setSettings({ cohortUnit: v as "auto" | "year" | "quarter" | "month" });
      else app.store.setSettings({ areaDepth: Number(v) });
    });
    this.zoomBtn = h("button", { class: "btn icon", title: "Reset zoom", "aria-label": "Reset zoom" }, icon("fit"));
    this.zoomBtn.addEventListener("click", () => this.zoom.reset());
    this.zoomBtn.style.display = "none";
    this.zoom = new ZoomPan(this.canvas);
    this.zoom.onChange = () => {
      tooltip.hide();
      this.zoomBtn.style.display = this.zoom.zoomed ? "" : "none";
      this.invalidate();
    };
    // Size: lines now. Churn: lines added + deleted from the range start to the cursor.
    this.measureSel = h("select", { "aria-label": "Square size" }, h("option", { value: "size", text: "sized by lines" }), h("option", { value: "churn", text: "sized by lines changed" }));
    this.measureSel.addEventListener("change", () => app.store.setSettings({ treemapMeasure: this.measureSel.value as "size" | "churn" }));
    this.layoutSel = h("select", { "aria-label": "Layout" }, h("option", { value: "live", text: "live layout" }), h("option", { value: "steady", text: "steady layout" }));
    this.layoutSel.title = "Steady: every file keeps the place it has at the end of the range, and playback only grows or shrinks it";
    this.layoutSel.addEventListener("change", () => app.store.setSettings({ treemapLayout: this.layoutSel.value as "live" | "steady" }));
    this.steady = new SteadyLayout(app);
    this.steady.onReady = () => {
      this.layoutKey = "";
      this.updateTitle();
      this.invalidate();
    };
    this.addControl(this.showSel);
    this.addControl(this.extraSel);
    this.addControl(this.measureSel);
    this.addControl(this.layoutSel);
    app.store.watch((s) => [s.settings.treemapLayout, !!s.compare, s.brush, s.settings.treemapMeasure, s.filterRev, s.steps], () => {
      this.steady.ensure();
      this.layoutKey = "";
      this.invalidate();
    }, true);
    this.addControl(this.modeSel);
    this.addControl(this.zoomBtn);
    // A new root fills the card; compare lays out its own panes (no zoom there).
    app.store.watch((s) => [s.root, !!s.compare], () => {
      this.zoom.enabled = !app.store.get().compare;
      this.zoom.reset();
    }, true);
    app.store.watch((s) => [s.cursor, s.settings.colorBy, s.search?.paths.size, s.settings.theme, s.settings.diffColors, s.settings.areaDepth, s.settings.cohortUnit], () => this.invalidate());
    const legend = () => renderColorLegend(app, this.legend);
    // (the last-edited scale stretches with the history's age at the cursor)
    const spanKey = (s: { settings: { colorBy: string } }) => (s.settings.colorBy === "edited" ? Math.round(Math.log(heatSpan(app)) * 8) : 0);
    app.store.watch((s) => [s.settings.colorBy, s.compare, s.langs, s.authors, s.root, s.settings.areaDepth, s.settings.cohortUnit, s.settings.theme, s.settings.diffColors, spanKey(s)], legend, true);
    colorMaps.dir.onChange(() => {
      if (app.store.get().settings.colorBy === "dir") legend();
    });
    colorMaps.author.onChange(() => {
      if (app.store.get().settings.colorBy !== "author") return;
      legend();
      this.invalidate();
    });
    app.composition.onChange(() => {
      legend();
      this.invalidate();
    });
    app.store.watch((s) => [s.root, s.compare, s.filterRev, s.settings.colorBy, s.settings.areaDepth, s.settings.cohortUnit, s.settings.treemapMeasure, s.brush, s.settings.treemapLayout], () => {
      this.layoutKey = "";
      this.updateTitle();
      this.invalidate();
    }, true);
    // (the title says when the cursor is outside the steady layout's range)
    app.store.watch((s) => (s.settings.treemapLayout === "steady" ? this.steady.usable() : true), () => this.updateTitle());
    app.compare.onChange(() => {
      this.layoutKey = "";
      this.invalidate();
    });
  }

  private updateTitle() {
    const s = this.app.store.get();
    const st = s.settings;
    const t = this.head.querySelector("h2")!;
    const churn = st.treemapMeasure === "churn";
    const from = this.app.churn.from() + 1;
    t.textContent = s.compare
      ? `Files: #${fmt.int(s.compare.a + 1)} → #${fmt.int(s.compare.b + 1)}`
      : churn
        ? `Lines changed from #${fmt.int(from + 1)}${s.root ? ` · ${s.root}/` : ""}`
        : `Files by size${s.root ? ` · ${s.root}/` : ""}`;
    this.measureSel.style.display = s.compare ? "none" : "";
    this.measureSel.value = st.treemapMeasure;
    this.layoutSel.style.display = s.compare ? "none" : "";
    this.layoutSel.value = st.treemapLayout;
    if (!s.compare && st.treemapLayout === "steady" && !this.steady.usable()) {
      const [a, b] = s.brush ?? [0, s.steps - 1];
      const c = s.cursor;
      t.textContent += c < a || c > b ? ` · steady layout covers #${fmt.int(a + 1)}–#${fmt.int(b + 1)}` : " · preparing steady layout…";
    }
    this.modeSel.style.display = s.compare ? "" : "none";
    if (s.compare) this.modeSel.value = s.compare.mode;
    // Compare colors by growth, so the slice controls step aside.
    this.showSel.style.display = s.compare ? "none" : "";
    this.showSel.value = st.colorBy;
    const opts: [string, string][] =
      st.colorBy === "cohort"
        ? [["auto", `auto (${cohortUnit(this.app)})`], ["year", "per year"], ["quarter", "per quarter"], ["month", "per month"]]
        : st.colorBy === "dir"
          ? Array.from({ length: Math.max(3, st.areaDepth) }, (_, i): [string, string] => [String(i + 1), `depth ${i + 1}`])
          : [];
    this.extraSel.replaceChildren(...opts.map(([v, text]) => h("option", { value: v, text })));
    this.extraSel.style.display = opts.length && !s.compare ? "" : "none";
    this.extraSel.value = st.colorBy === "cohort" ? st.cohortUnit : String(st.areaDepth);
  }

  /** Which trees to lay out, and where. */
  private paneSpecs(): Omit<Pane, "root" | "nodes">[] {
    const s = this.app.store.get();
    const d = this.app.compare.data;
    const W = this.width;
    if (s.compare && d) {
      if (s.compare.mode === "side") {
        const half = (W - 8) / 2;
        return [
          { key: "A", label: `A · #${fmt.int(d.a + 1)} · ${fmt.date(this.app.tl.time(d.a))}`, tree: d.treeA, x: 0, w: half },
          { key: "B", label: `B · #${fmt.int(d.b + 1)} · ${fmt.date(this.app.tl.time(d.b))}`, tree: d.treeB, x: half + 8, w: half },
        ];
      }
      return [{ key: "B", label: null, tree: d.treeB, x: 0, w: W }];
    }
    if (s.settings.treemapMeasure === "churn") return [{ key: "C", label: null, tree: this.app.churn.tree, x: 0, w: W }];
    return [{ key: "L", label: null, tree: this.app.tree, x: 0, w: W }];
  }

  /** Composition revision the painted bands show, and when they were last refreshed. */
  private bandsRev = -1;
  private bandsAt = 0;

  /** How long the last relayout took (ms). */
  private relayoutMs = 0;

  private relayout() {
    const t0 = performance.now();
    this.relayoutInner();
    this.relayoutMs = performance.now() - t0;
  }

  private relayoutInner() {
    const s = this.app.store.get();
    const renamedFrom = new Set(this.app.tree.renames.values());
    this.renameRects.clear();
    if (renamedFrom.size) {
      for (const pane of this.panes) {
        for (const n of pane.nodes) {
          const r = renamedFrom.has(n.data.id) ? n.data.shown : null;
          if (r) this.renameRects.set(n.data.id, r);
        }
      }
    }
    const top = (spec: Omit<Pane, "root" | "nodes">) => (spec.label ? 16 : 0);
    // Lay out at the zoomed size, then scale back to world units.
    const kL = this.zoom.k;
    const steady = this.steady.usable();
    this.panes = this.paneSpecs().map((spec) => {
      const w = spec.w * kL;
      const hgt = (this.height - top(spec)) * kL;
      const lines = (n: TNode) => (n.file && !n.file.binary ? n.file.lines : 0);
      const r =
        (steady && spec.label === null && spec.key !== "B" ? this.steady.layout(spec.tree, s.cursor, s.root, w, hgt) : null) ??
        layoutTree(spec.tree.find(s.root) ?? spec.tree.root, w, hgt, lines, treemapBinary as never, livePadding);
      r.each((n) => {
        n.x0 = n.x0 / kL + spec.x;
        n.x1 = n.x1 / kL + spec.x;
        n.y0 = n.y0 / kL + top(spec);
        n.y1 = n.y1 / kL + top(spec);
      });
      return { ...spec, root: r, nodes: [] };
    });
    // Directory colors go to the largest keys shown (the area chart ranks the same way).
    if (s.settings.colorBy === "dir" && !s.compare && this.panes[0]?.root) assignDirColors(this.app, this.panes[0].root.data);
    this.layoutK = kL;
    this.layoutKey = this.currentKey();
    this.layoutAt = clock.now();
    this.cullKey = "";
  }

  /**
   * The nodes to paint: on screen, and not below the level of detail. A folder smaller than
   * ~30 px² on screen is drawn as one rect in the color of its largest file instead of hundreds
   * of sub-pixel slivers (at Linux scale most files are). Cheap: runs on every pan.
   */
  private cull() {
    const z = this.zoom;
    const k2 = z.k * z.k;
    const W = this.width;
    const H = this.height;
    this.lod = new WeakMap();
    for (const pane of this.panes) {
      const nodes: LNode[] = [];
      const visit = (n: LNode) => {
        const a = (n.x1 - n.x0) * (n.y1 - n.y0) * k2;
        if (a < 0.02 || !(n.value ?? 0)) return;
        if (z.sx(n.x1) < 0 || z.sx(n.x0) > W || z.sy(n.y1) < 0 || z.sy(n.y0) > H) return;
        nodes.push(n);
        if (n.children && n.depth > 0 && a < 30) {
          let best: LNode | null = null;
          for (const l of n.leaves()) if (l.data.file && (!best || (l.value ?? 0) > (best.value ?? 0))) best = l;
          if (best) this.lod.set(n.data, best.data);
          return;
        }
        n.children?.forEach((c) => visit(c as LNode));
      };
      if (pane.root) visit(pane.root);
      pane.nodes = nodes;
    }
    this.cullKey = this.viewKey();
  }

  /** Summed bands of every file under a folder, cached per composition revision. */
  private lodPairs = new WeakMap<TNode, { rev: number; pairs: number[] }>();

  private subtreePairs(n: LNode): number[] | undefined {
    const comp = this.app.composition;
    const hit = this.lodPairs.get(n.data);
    if (hit?.rev === comp.rev) return hit.pairs;
    const sum = new Map<number, number>();
    for (const l of n.leaves()) {
      const a = l.data.file ? comp.of(l.data.file.pathId) : undefined;
      if (a) for (let j = 0; j < a.length; j += 2) sum.set(a[j], (sum.get(a[j]) ?? 0) + a[j + 1]);
    }
    const pairs: number[] = [];
    for (const [k, v] of sum) pairs.push(k, v);
    this.lodPairs.set(n.data, { rev: comp.rev, pairs });
    return pairs.length ? pairs : undefined;
  }

  private viewKey(): string {
    return `${this.layoutKey}|${this.zoom.k}|${this.zoom.x}|${this.zoom.y}`;
  }

  private currentKey(): string {
    const s = this.app.store.get();
    const specs = this.paneSpecs();
    return `${this.width}x${this.height}|${s.root}|${specs.map((p) => `${p.key}:${p.tree.rev}`).join(",")}|${this.app.compare.data?.key ?? ""}|${this.steady.stateKey()}`;
  }

  protected animating() {
    return this.moving;
  }

  /** Large treemaps fill their cells on the WebGL layer underneath. */
  private wantsGl(): boolean {
    return !!this.gl && this.panes.reduce((a, q) => a + q.nodes.length, 0) > 4000;
  }

  protected transparentBackground(): boolean {
    this.clearedForGl = this.wantsGl();
    return this.clearedForGl;
  }

  /** Whether this frame's 2D canvas was cleared to show the GL layer (decided before `draw`). */
  private clearedForGl = false;

  draw(p: Painter) {
    const pal = palette();
    const s = this.app.store.get();
    const now = clock.now();
    const nodeCount = this.panes.reduce((a, q) => a + q.nodes.length, 0);
    // Relayout is O(files); at Linux scale do it a little over once a second while playing and
    // let the easing carry the motion in between.
    // (and never more than a quarter of the time: the steady layout re-tiles every file there
    // ever was, 3-4x the live cost at Linux scale)
    const throttle = s.playing ? Math.max(nodeCount > 50_000 ? 800 : nodeCount > 20_000 ? 250 : 60, 4 * this.relayoutMs) : 0;
    const key = this.currentKey();
    const sizeChanged = !this.layoutKey.startsWith(`${this.width}x${this.height}|`);
    // Zooming paints the current layout scaled; once the wheel or pinch rests, lay out again at
    // the new zoom so folders open up into their files.
    const zoomSettled = this.zoom.k === this.layoutK || now - this.zoom.changedAt >= 120;
    if (key !== this.layoutKey || (this.zoom.k !== this.layoutK && zoomSettled)) {
      if (sizeChanged || now - this.layoutAt >= throttle || this.zoom.k !== this.layoutK) this.relayout();
      else this.invalidate();
    }
    if (!zoomSettled) this.invalidate();
    if (this.cullKey !== this.viewKey()) this.cull();
    const z = this.zoom;
    const zk = z.k;
    if (!this.panes.some((q) => q.nodes.length)) {
      const churn = !s.compare && s.settings.treemapMeasure === "churn";
      const msg = s.compare && !this.app.compare.data ? "Loading comparison…" : this.app.tree.step < 0 ? "Loading…" : churn ? "No lines changed yet in this range" : "No files at this point";
      p.text(msg, this.width / 2, this.height / 2, { color: pal.inkMuted, size: 12, align: "center" });
      return;
    }
    const dt = this.lastFrame ? Math.min(100, now - this.lastFrame) : 16;
    this.lastFrame = now;
    const k = sizeChanged ? 1 : 1 - Math.exp(-dt / 70);
    let moving = false;
    const pos = s.pos;
    const colorBy = s.settings.colorBy;
    const searchPaths = s.search?.kind === "path" && s.search.paths.size ? s.search.paths : null;
    const comparing = !!(s.compare && this.app.compare.data);
    // Nothing moved and no color input changed: reuse last frame's batches; only the activity
    // rings (a few recently touched files) are recomputed. Most playback frames at scale.
    const sliceKey = colorBy === "dir" ? `${s.settings.areaDepth}:${colorMaps.dir.version}` : colorBy === "cohort" ? cohortUnit(this.app) : colorBy === "heat" ? pos : colorBy === "edited" ? s.cursor : "";
    // Authors and cohorts split each file into bands by its lines per key, once they're loaded.
    const comp = this.app.composition;
    const bandsOn = !comparing && (colorBy === "author" || colorBy === "cohort") && comp.ready(colorBy);
    // Activity rings on just-touched files, except where the colors already say it.
    const ringsOn = colorBy !== "heat" && colorBy !== "edited";
    // While playing, bands change with every chunk of history; repaint them a few times a second
    // and let frames in between reuse the last batches (they cost as much as a relayout).
    if (bandsOn && comp.rev !== this.bandsRev && (!s.playing || now - this.bandsAt >= 250)) {
      this.bandsRev = comp.rev;
      this.bandsAt = now;
    }
    const colorKey = `${this.viewKey()}|${colorBy}|${bandsOn ? this.bandsRev : ""}|${colorBy === "author" ? colorMaps.author.version : ""}|${s.settings.theme}|${s.settings.diffColors}|${comparing}|${this.app.compare.data?.key ?? ""}|${s.search?.q ?? ""}|${sliceKey}`;
    const reuse = !this.geomMoving && k < 1 && this.frame?.key === colorKey;
    let geom = false;
    let dirs: number[];
    let groups: Map<string, { fill: string; alpha: number; xywh: number[] }>;
    let labels: [string, number, number, number, string, boolean][];
    const rings: [number, number, number, number, string, number][] = [];
    if (reuse && this.frame) {
      ({ dirs, groups, labels } = this.frame);
      if (!comparing && ringsOn) {
        const seenRing = new Set<number>();
        for (let i = this.app.tree.recent.length - 1; i >= 0; i--) {
          const pid = this.app.tree.recent[i];
          if (seenRing.has(pid)) continue;
          seenRing.add(pid);
          const node = this.app.tree.leaf(pid);
          const f = node?.file;
          const r = node?.shown;
          if (!f || !r || f.touched < 0 || pos - f.touched > 400) continue;
          const ht = heat(this.app, f.touched, pos);
          const w = (r.x1 - r.x0) * zk;
          const hh = (r.y1 - r.y0) * zk;
          if (ht > 0.15 && w > 2 && hh > 2) rings.push([z.sx(r.x0) + 0.75, z.sy(r.y0) + 0.75, w - 1.5, hh - 1.5, f.lastDels > f.lastAdds ? pal.del : pal.add, ht]);
          if (ht > 0.05) moving ||= s.playing;
        }
      }
    } else {
    dirs = [];
    groups = new Map();
    labels = [];
    for (const pane of this.panes) {
      if (pane.label) labels.push([pane.label, pane.x + 4, 11, pane.w - 8, pal.ink2, true]);
      for (const n of pane.nodes) {
        let r = n.data.shown;
        if (!r) {
          // A renamed file glides from where it used to be.
          const from = pane.key === "L" ? pane.tree.renames.get(n.data.id) : undefined;
          const prev = from ? this.renameRects.get(from) : undefined;
          r = prev ? { ...prev } : { x0: n.x0, y0: n.y0, x1: n.x1, y1: n.y1 };
          n.data.shown = r;
        }
        if (k < 1) {
          r.x0 += (n.x0 - r.x0) * k;
          r.y0 += (n.y0 - r.y0) * k;
          r.x1 += (n.x1 - r.x1) * k;
          r.y1 += (n.y1 - r.y1) * k;
          if (!geom && Math.abs(r.x0 - n.x0) + Math.abs(r.y0 - n.y0) + Math.abs(r.x1 - n.x1) + Math.abs(r.y1 - n.y1) > 0.6) geom = true;
        } else {
          r.x0 = n.x0;
          r.y0 = n.y0;
          r.x1 = n.x1;
          r.y1 = n.y1;
        }
        // world -> screen
        const X = z.sx(r.x0);
        const Y = z.sy(r.y0);
        const w = (r.x1 - r.x0) * zk;
        const hh = (r.y1 - r.y0) * zk;
        const rep = n.data.isDir ? this.lod.get(n.data) : undefined;
        if (n.data.isDir && !rep) {
          if (n.depth === 0) continue;
          dirs.push(X, Y, w, hh);
          const child = n.children?.[0];
          if (child && (child.y0 - n.y0) * zk >= 14.5 && w > 60) labels.push([n.data.name, Math.max(X, 0) + 4, Y + 7.5, Math.min(w, X + w) - 8, pal.ink2, true]);
          continue;
        }
        const leaf = rep ?? n.data;
        const f = leaf.file!;
        const fill = comparing ? growthColor(this.app, f.pathId) : fileColor(this.app, leaf, colorBy, pos);
        const alpha = searchPaths && !searchPaths.has(f.pathId) ? 0.2 : 1;
        const put = (c: string, x: number, y: number, bw: number, bh: number) => {
          const gk = alpha === 1 ? c : `${c}|${alpha}`;
          let g = groups.get(gk);
          if (!g) {
            g = { fill: c, alpha, xywh: [] };
            groups.set(gk, g);
          }
          g.xywh.push(x, y, bw, bh);
        };
        // A folder drawn as one rect takes its whole subtree's bands (not its largest file's),
        // so small files' minority authors still count.
        const pairs = !bandsOn ? undefined : rep ? this.subtreePairs(n) : comp.of(f.pathId);
        if (pairs && pairs.length > 2 && Math.max(w, hh) < 6) {
          // Too small to split: the key with the most lines.
          let best = 0;
          for (let j = 2; j < pairs.length; j += 2) if (pairs[j + 1] > pairs[best + 1]) best = j;
          put(comp.color(pairs[best]), X, Y, w, hh);
        } else if (pairs && pairs.length > 2) {
          // Strips along the longer side, in band order (authors by rank, cohorts oldest first).
          let total = 0;
          for (let j = 1; j < pairs.length; j += 2) total += pairs[j];
          const across = w >= hh;
          const len = across ? w : hh;
          let acc = 0;
          for (const k of comp.order) {
            let v = 0;
            for (let j = 0; j < pairs.length; j += 2) if (pairs[j] === k) v = pairs[j + 1];
            if (!v) continue;
            const a0 = (acc / total) * len;
            acc += v;
            const a1 = (acc / total) * len;
            if (a1 - a0 < 0.3) continue;
            if (across) put(comp.color(k), X + a0, Y, a1 - a0, hh);
            else put(comp.color(k), X, Y + a0, w, a1 - a0);
          }
        } else {
          put(fill, X, Y, w, hh);
        }
        // Activity cue in every mode: a brief ring on files touched right now.
        if (!comparing && !rep && f.touched >= 0 && pos - f.touched < 400) {
          const ht = heat(this.app, f.touched, pos);
          if (ringsOn && ht > 0.15 && w > 2 && hh > 2) rings.push([X + 0.75, Y + 0.75, w - 1.5, hh - 1.5, f.lastDels > f.lastAdds ? pal.del : pal.add, ht]);
          if (ht > 0.05) moving ||= s.playing;
        }
        if (!rep && w > 46 && hh > 16) labels.push([n.data.name, Math.max(X, 0) + 4, Math.max(Y, 0) + 11, Math.min(w, X + w) - 8, inkOn(fill), false]);
      }
    }
    this.frame = { key: colorKey, dirs, groups, labels };
    }
    const useGl = this.onScreen && this.wantsGl();
    // Show the layer before drawing into it: a frame drawn while it is display:none is never
    // presented, and a still page would keep an empty treemap until something redraws it.
    if (this.gl && useGl !== this.glActive) {
      this.glActive = useGl;
      this.gl.canvas.style.display = useGl ? "" : "none";
    }
    // The first frame after a relayout painted the 2D canvas opaque (its node count wasn't known
    // yet), hiding the GL fills underneath: paint once more.
    if (useGl && !this.clearedForGl) this.invalidate();
    if (useGl && this.gl) {
      this.gl.begin();
      this.gl.add(dirs, pal.dir);
      for (const g of groups.values()) this.gl.add(g.xywh, g.fill, g.alpha);
      this.gl.flush(this.width, this.height, this.canvas.width / this.width, pal.surface);
    } else {
      p.rects(dirs, pal.dir);
      for (const g of groups.values()) p.rects(g.xywh, g.fill, g.alpha);
    }
    for (const [x, y, w, hh, c, a] of rings) p.strokeRect(x, y, w, hh, c, 1.5, a);
    for (const [text, x, y, maxWidth, color, bold] of labels) {
      p.text(text, x, y, bold ? { color, size: 10, weight: 600, baseline: "middle", maxWidth } : { color, size: 10, maxWidth });
    }
    if (this.hover) {
      const r = this.hover.node.data.shown;
      if (r) p.strokeRect(z.sx(r.x0) + 0.5, z.sy(r.y0) + 0.5, (r.x1 - r.x0) * zk - 1, (r.y1 - r.y0) * zk - 1, pal.ink, 1.5);
    }
    this.geomMoving = geom;
    this.moving = moving || geom;
  }

  private hit(sx: number, sy: number): { pane: Pane; node: LNode } | null {
    const x = this.zoom.wx(sx);
    const y = this.zoom.wy(sy);
    const pane = this.panes.find((q) => x >= q.x && x <= q.x + q.w);
    let n = pane?.root;
    if (!pane || !n) return null;
    for (;;) {
      const next = n.children?.find((c) => x >= c.x0 && x <= c.x1 && y >= c.y0 && y <= c.y1) as LNode | undefined;
      if (!next) return n.depth === 0 ? null : { pane, node: n };
      n = next;
    }
  }

  protected onPointerMove(x: number, y: number, e: PointerEvent) {
    const hit = this.hit(x, y);
    if (hit?.node !== this.hover?.node) {
      this.hover = hit;
      this.invalidate();
    }
    if (!hit) {
      tooltip.hide();
      return;
    }
    tooltip.show(e.clientX, e.clientY, this.describe(hit.node));
  }

  private describe(n: LNode): HTMLElement {
    const pal = palette();
    // (steady layout: a place is where the content ends up; name the file there now)
    const now = n.data.file ? this.app.paths.path[n.data.file.pathId] : undefined;
    const box = h("div", {}, h("div", { class: "h", text: now ?? (n.data.id || "/") }));
    if (now && now !== n.data.id) box.append(h("div", { class: "sub", text: `moves to ${n.data.id} later` }));
    if (n.data.isDir) {
      box.append(tipRow(null, fmt.int(n.value ?? 0), "lines"), tipRow(null, fmt.int(n.data.files), "files"));
      box.append(h("div", { class: "sub", text: "Click to zoom in" }));
      return box;
    }
    const f = n.data.file!;
    const lang = this.app.paths.lang[f.pathId];
    const d = this.app.compare.data;
    if (this.app.store.get().compare && d) {
      const a = d.linesA.get(f.pathId) ?? 0;
      const b = d.linesB.get(f.pathId) ?? 0;
      box.append(tipRow(growthColor(this.app, f.pathId), fmt.signed(b - a), `lines (${fmt.int(a)} → ${fmt.int(b)})`));
      box.append(h("div", { class: "sub", text: a === 0 ? "new since A" : b === 0 ? "deleted by B" : lang }));
      return box;
    }
    if (f.adds !== undefined) {
      // Churn view: what changed in the window, and whether the file is still there.
      const live = this.app.tree.files.get(f.pathId);
      box.append(tipRow(palette().add, `+${fmt.int(f.adds)}`, "lines added"), tipRow(palette().del, `−${fmt.int(f.dels ?? 0)}`, "lines deleted"));
      box.append(tipRow(null, live ? fmt.int(live.lines) : "deleted", live ? `lines now · ${lang}` : `by #${fmt.int(this.app.store.get().cursor + 1)}`));
    } else box.append(tipRow(colorMaps.lang.color(lang), fmt.int(f.lines), `lines · ${lang}`));
    const colorBy = this.app.store.get().settings.colorBy;
    const comp = this.app.composition;
    const pairs = (colorBy === "author" || colorBy === "cohort") && comp.ready(colorBy) ? comp.of(f.pathId) : undefined;
    if (pairs) {
      // The file's bands, largest first.
      let total = 0;
      for (let j = 1; j < pairs.length; j += 2) total += pairs[j];
      const rows: [number, number][] = [];
      for (let j = 0; j < pairs.length; j += 2) rows.push([pairs[j], pairs[j + 1]]);
      rows.sort((a, b) => b[1] - a[1]);
      for (const [k, v] of rows.slice(0, 6)) box.append(tipRow(comp.color(k), `${Math.round((v / total) * 100)}%`, `${comp.label(k)} (${fmt.int(v)} lines)`));
      if (rows.length > 6) box.append(h("div", { class: "sub", text: `and ${rows.length - 6} more` }));
    } else if (f.topAuthor >= 0) {
      const name = this.app.authorName(f.topAuthor);
      box.append(tipRow(colorMaps.author.color(name), `${Math.round(f.topShare * 100)}%`, `written by ${name}`));
    }
    if (f.mot > 0) box.append(tipRow(null, fmt.date(f.mot), "average line written"));
    if (f.edited >= 0) {
      const cur = this.app.store.get().cursor;
      const age = this.app.tl.time(cur) - this.app.tl.time(Math.min(cur, f.edited));
      box.append(tipRow(heatColor(age, heatSpan(this.app)), fmt.date(this.app.tl.time(f.edited)), `content last edited (${age < 86400 ? "the same day" : `${fmt.ago(age)} earlier`})`));
    }
    if (f.touched >= 0) {
      const act = f.lastAdds || f.lastDels ? ` (+${fmt.int(f.lastAdds)} −${fmt.int(f.lastDels)})` : "";
      box.append(tipRow(f.lastDels > f.lastAdds ? pal.del : pal.add, `#${fmt.int(f.touched + 1)}`, `last changed${act}`));
    }
    return box;
  }

  protected onPointerLeave() {
    this.hover = null;
    this.invalidate();
  }

  protected onResize() {
    this.zoom.resize(this.width, this.height);
  }

  protected onClick(x: number, y: number) {
    const hit = this.hit(x, y);
    if (!hit) return;
    const n = hit.node;
    const dir = n.data.isDir ? n.data : n.data.parent;
    if (dir && dir.id !== this.app.store.get().root) {
      tooltip.hide();
      this.app.store.set({ root: dir.id });
    }
  }

  protected onDoubleClick() {
    const root = this.app.store.get().root;
    if (!root) return;
    const up = root.includes("/") ? root.slice(0, root.lastIndexOf("/")) : "";
    this.app.store.set({ root: up });
  }
}
