import { type HierarchyRectangularNode, hierarchy, treemap, treemapBinary } from "d3";
import type { App } from "../app";
import { clock } from "../clock";
import { colorMaps, diverging, inkOn, mix, sequential } from "../model/colors";
import { type FileTree, type TNode, stableChildren } from "../model/filetree";
import { GlRects } from "../paint/glrects";
import type { Painter } from "../paint/painter";
import type { ColorBy } from "../state/store";
import { palette } from "../theme";
import { fmt, h } from "../ui/dom";
import { tipRow, tooltip } from "../ui/tooltip";
import { renderColorLegend } from "./colorlegend";
import { View } from "./view";

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

type LNode = HierarchyRectangularNode<TNode>;

/** Shared per-file coloring for the treemap and the tree. */
/** Language color per path id, rebuilt when the palette changes (a 100k-file frame asks a lot). */
let langCache: { pal: unknown; colors: string[] } = { pal: null, colors: [] };

function langColor(app: App, pathId: number): string {
  const pal = palette();
  if (langCache.pal !== pal || langCache.colors.length !== app.paths.lang.length) {
    const byLang = new Map<string, string>();
    langCache = {
      pal,
      colors: app.paths.lang.map((l) => {
        const key = l || "Other";
        let c = byLang.get(key);
        if (c === undefined) {
          c = colorMaps.lang.color(key);
          byLang.set(key, c);
        }
        return c;
      }),
    };
  }
  return langCache.colors[pathId] ?? pal.other;
}

export function fileColor(app: App, node: TNode, mode: ColorBy, now: number): string {
  const pal = palette();
  const f = node.file;
  if (!f) return pal.dir;
  if (app.store.get().compare && app.compare.data) return growthColor(app, f.pathId);
  switch (mode) {
    case "lang":
      return langColor(app, f.pathId);
    case "author":
      return f.topAuthor < 0 ? pal.other : colorMaps.author.color(app.authorName(f.topAuthor));
    case "age": {
      const t0 = app.tl.time(0);
      const t1 = app.tl.time(app.store.get().cursor);
      return f.mot > 0 ? sequential((f.mot - t0) / Math.max(1, t1 - t0)) : pal.other;
    }
    case "heat": {
      const k = heat(app, f.touched, now);
      if (k <= 0.01) return pal.surface3;
      const hue = f.lastDels > f.lastAdds ? pal.del : pal.add;
      return mix(pal.surface3, hue, k);
    }
  }
}

/** Compare mode: born = additions color, died = deletions color, otherwise diverging on log2(B/A). */
export function growthColor(app: App, pathId: number): string {
  const pal = palette();
  const d = app.compare.data!;
  const a = d.linesA.get(pathId) ?? 0;
  const b = d.linesB.get(pathId) ?? 0;
  if (a === 0 && b > 0) return pal.add;
  if (b === 0 && a > 0) return pal.del;
  return diverging(Math.log2((b + 1) / (a + 1)) / 3);
}

/** 1 when a file was just touched, decaying to 0 over `heatSeconds` of playback. */
let heatSteps = { key: -1, steps: 1 };

export function heat(app: App, touched: number, pos: number): number {
  if (touched < 0) return 0;
  const age = pos - touched;
  if (age < -0.5) return 0;
  // The decay length is the same for every file in a frame; compute it once per ~frame.
  const key = Math.floor(clock.now() / 8);
  if (heatSteps.key !== key) heatSteps = { key, steps: Math.max(0.5, app.store.get().settings.heatSeconds * app.stepsPerSecond()) };
  return Math.exp(-Math.max(0, age) / heatSteps.steps);
}

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
  /** Folders drawn as a single rect (too small to show their files): folder -> its largest file. */
  private lod = new WeakMap<TNode, TNode>();
  private layoutKey = "";
  private layoutAt = 0;
  private hover: { pane: Pane; node: LNode } | null = null;
  private moving = false;
  private lastFrame = 0;
  private modeSel: HTMLSelectElement;
  /** WebGL layer for the rect fills of large treemaps (null without WebGL2). */
  private gl: GlRects | null = null;
  private glActive = false;

  constructor(private app: App) {
    super("treemap", "Files by size");
    this.gl = GlRects.create();
    if (this.gl) {
      this.gl.canvas.style.display = "none";
      this.gl.canvas.setAttribute("aria-hidden", "true");
      this.body.insertBefore(this.gl.canvas, this.canvas);
    }
    this.modeSel = h("select", { "aria-label": "Compare layout" }, h("option", { value: "overlay", text: "B, colored by change" }), h("option", { value: "side", text: "A and B side by side" }));
    this.modeSel.addEventListener("change", () => {
      const c = app.store.get().compare;
      if (c) app.store.set({ compare: { ...c, mode: this.modeSel.value as "overlay" | "side" } });
    });
    this.addControl(this.modeSel);
    app.store.watch((s) => [s.cursor, s.settings.colorBy, s.search?.paths.size, s.settings.theme, s.settings.diffColors], () => this.invalidate());
    app.store.watch((s) => [s.settings.colorBy, s.compare, s.langs, s.settings.theme, s.settings.diffColors, s.settings.colorBy === "age" ? s.cursor : 0], () => renderColorLegend(app, this.legend), true);
    app.store.watch((s) => [s.root, s.compare, s.filterRev], () => {
      this.layoutKey = "";
      this.updateTitle();
      this.invalidate();
    }, true);
    app.compare.onChange(() => {
      this.layoutKey = "";
      this.invalidate();
    });
  }

  private updateTitle() {
    const s = this.app.store.get();
    const t = this.head.querySelector("h2")!;
    t.textContent = s.compare
      ? `Files: #${fmt.int(s.compare.a + 1)} → #${fmt.int(s.compare.b + 1)}`
      : `Files by size${s.root ? ` · ${s.root}/` : ""}`;
    this.modeSel.style.display = s.compare ? "" : "none";
    if (s.compare) this.modeSel.value = s.compare.mode;
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
    return [{ key: "L", label: null, tree: this.app.tree, x: 0, w: W }];
  }

  private relayout() {
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
    this.lod = new WeakMap();
    this.panes = this.paneSpecs().map((spec) => {
      const display = spec.tree.find(s.root) ?? spec.tree.root;
      const root = hierarchy<TNode>(display, (n) => (n.children ? stableChildren(n) : null)).sum((n) => (n.file && !n.file.binary ? n.file.lines : 0));
      // Padding only where it's visible: at Linux scale fixed gaps would eat every small file and
      // leave gray folder backgrounds. Small folders pack their files edge to edge.
      const area = (n: HierarchyRectangularNode<TNode>) => (n.x1 - n.x0) * (n.y1 - n.y0);
      treemap<TNode>()
        .tile(treemapBinary)
        .size([spec.w, this.height - top(spec)])
        .paddingOuter((n) => (n.depth === 0 ? 2 : area(n) > 2500 ? 2 : area(n) > 400 ? 1 : 0))
        .paddingInner((n) => (area(n) > 1200 ? 1 : 0))
        .paddingTop((n) => (n.depth > 0 && n.data.isDir && n.x1 - n.x0 > 60 && n.y1 - n.y0 > 36 ? 15 : n.depth === 0 ? 2 : area(n) > 400 ? 1 : 0))(root);
      const r = root as LNode;
      r.each((n) => {
        n.x0 += spec.x;
        n.x1 += spec.x;
        n.y0 += top(spec);
        n.y1 += top(spec);
      });
      // Level of detail: a folder smaller than ~30 px² is drawn as one rect in the color of its
      // largest file instead of hundreds of sub-pixel slivers (at Linux scale most files are).
      const nodes: LNode[] = [];
      const visit = (n: LNode) => {
        if (area(n) < 0.02 || !(n.value ?? 0)) return;
        nodes.push(n);
        if (n.children && n.depth > 0 && area(n) < 30) {
          let best: LNode | null = null;
          for (const l of n.leaves()) if (l.data.file && (!best || (l.value ?? 0) > (best.value ?? 0))) best = l;
          if (best) this.lod.set(n.data, best.data);
          return;
        }
        n.children?.forEach((c) => visit(c as LNode));
      };
      visit(r);
      return { ...spec, root: r, nodes };
    });
    this.layoutKey = this.currentKey();
    this.layoutAt = clock.now();
  }

  private currentKey(): string {
    const s = this.app.store.get();
    const specs = this.paneSpecs();
    return `${this.width}x${this.height}|${s.root}|${specs.map((p) => `${p.key}:${p.tree.rev}`).join(",")}|${this.app.compare.data?.key ?? ""}`;
  }

  protected animating() {
    return this.moving;
  }

  /** Large treemaps fill their cells on the WebGL layer underneath. */
  private wantsGl(): boolean {
    return !!this.gl && this.panes.reduce((a, q) => a + q.nodes.length, 0) > 4000;
  }

  protected transparentBackground(): boolean {
    return this.wantsGl();
  }

  draw(p: Painter) {
    const pal = palette();
    const s = this.app.store.get();
    const now = clock.now();
    const nodeCount = this.panes.reduce((a, q) => a + q.nodes.length, 0);
    // Relayout is O(files); at Linux scale do it a little over once a second while playing and
    // let the easing carry the motion in between.
    const throttle = s.playing ? (nodeCount > 50_000 ? 800 : nodeCount > 20_000 ? 250 : 60) : 0;
    const key = this.currentKey();
    const sizeChanged = !this.layoutKey.startsWith(`${this.width}x${this.height}|`);
    if (key !== this.layoutKey) {
      if (sizeChanged || now - this.layoutAt >= throttle) this.relayout();
      else this.invalidate();
    }
    if (!this.panes.some((q) => q.nodes.length)) {
      const msg = s.compare && !this.app.compare.data ? "Loading comparison…" : this.app.tree.step < 0 ? "Loading…" : "No files at this point";
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
    // Collect first, then paint in batches: one fill per color instead of 100k fillStyle changes.
    const dirs: number[] = [];
    const groups = new Map<string, { fill: string; alpha: number; xywh: number[] }>();
    const rings: [number, number, number, number, string, number][] = [];
    const labels: [string, number, number, number, string, boolean][] = [];
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
          if (!moving && Math.abs(r.x0 - n.x0) + Math.abs(r.y0 - n.y0) + Math.abs(r.x1 - n.x1) + Math.abs(r.y1 - n.y1) > 0.6) moving = true;
        } else {
          r.x0 = n.x0;
          r.y0 = n.y0;
          r.x1 = n.x1;
          r.y1 = n.y1;
        }
        const w = r.x1 - r.x0;
        const hh = r.y1 - r.y0;
        const rep = n.data.isDir ? this.lod.get(n.data) : undefined;
        if (n.data.isDir && !rep) {
          if (n.depth === 0) continue;
          dirs.push(r.x0, r.y0, w, hh);
          const child = n.children?.[0];
          if (child && child.y0 - n.y0 >= 14.5 && w > 60) labels.push([n.data.name, r.x0 + 4, r.y0 + 7.5, w - 8, pal.ink2, true]);
          continue;
        }
        const leaf = rep ?? n.data;
        const f = leaf.file!;
        const fill = comparing ? growthColor(this.app, f.pathId) : fileColor(this.app, leaf, colorBy, pos);
        const alpha = searchPaths && !searchPaths.has(f.pathId) ? 0.2 : 1;
        const gk = alpha === 1 ? fill : `${fill}|${alpha}`;
        let g = groups.get(gk);
        if (!g) {
          g = { fill, alpha, xywh: [] };
          groups.set(gk, g);
        }
        g.xywh.push(r.x0, r.y0, w, hh);
        // Activity cue in every mode: a brief ring on files touched right now.
        if (!comparing && !rep && f.touched >= 0 && pos - f.touched < 400) {
          const ht = heat(this.app, f.touched, pos);
          if (colorBy !== "heat" && ht > 0.15 && w > 2 && hh > 2) rings.push([r.x0 + 0.75, r.y0 + 0.75, w - 1.5, hh - 1.5, f.lastDels > f.lastAdds ? pal.del : pal.add, ht]);
          if (ht > 0.05) moving ||= s.playing;
        }
        if (!rep && w > 46 && hh > 16) labels.push([n.data.name, r.x0 + 4, r.y0 + 11, w - 8, inkOn(fill), false]);
      }
    }
    const useGl = this.onScreen && this.wantsGl();
    if (useGl && this.gl) {
      this.gl.begin();
      this.gl.add(dirs, pal.dir);
      for (const g of groups.values()) this.gl.add(g.xywh, g.fill, g.alpha);
      this.gl.flush(this.width, this.height, this.canvas.width / this.width, pal.surface);
    } else {
      p.rects(dirs, pal.dir);
      for (const g of groups.values()) p.rects(g.xywh, g.fill, g.alpha);
    }
    if (this.gl && useGl !== this.glActive) {
      this.glActive = useGl;
      this.gl.canvas.style.display = useGl ? "" : "none";
    }
    for (const [x, y, w, hh, c, a] of rings) p.strokeRect(x, y, w, hh, c, 1.5, a);
    for (const [text, x, y, maxWidth, color, bold] of labels) {
      p.text(text, x, y, bold ? { color, size: 10, weight: 600, baseline: "middle", maxWidth } : { color, size: 10, maxWidth });
    }
    if (this.hover) {
      const r = this.hover.node.data.shown;
      if (r) p.strokeRect(r.x0 + 0.5, r.y0 + 0.5, r.x1 - r.x0 - 1, r.y1 - r.y0 - 1, pal.ink, 1.5);
    }
    this.moving = moving;
  }

  private hit(x: number, y: number): { pane: Pane; node: LNode } | null {
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
    const box = h("div", {}, h("div", { class: "h", text: n.data.id || "/" }));
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
    box.append(tipRow(colorMaps.lang.color(lang), fmt.int(f.lines), `lines · ${lang}`));
    if (f.topAuthor >= 0) {
      const name = this.app.authorName(f.topAuthor);
      box.append(tipRow(colorMaps.author.color(name), `${Math.round(f.topShare * 100)}%`, `written by ${name}`));
    }
    if (f.mot > 0) box.append(tipRow(null, fmt.date(f.mot), "average line written"));
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

  protected onPointerDown(x: number, y: number) {
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
