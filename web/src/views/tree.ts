import { type HierarchyNode, type HierarchyRectangularNode, hierarchy, partition, tree as d3tree } from "d3";
import type { App } from "../app";
import { colorMaps } from "../model/colors";
import { type TNode, stableChildren } from "../model/filetree";
import { CanvasPainter } from "../paint/canvas";
import type { Painter } from "../paint/painter";
import type { TreeLayout } from "../state/store";
import { palette } from "../theme";
import { fmt, h } from "../ui/dom";
import { tipRow, tooltip } from "../ui/tooltip";
import { fileColor, heat } from "./treemap";
import { clock } from "../clock";
import { renderColorLegend } from "./colorlegend";
import { View } from "./view";

/** A node of the visible (budget-limited) tree. Collapsed directories stand in for their subtree. */
interface VNode {
  id: string;
  t: TNode;
  children: VNode[];
  collapsed: boolean;
  /** For a collapsed folder: its largest file (drives the color). */
  rep: TNode | null;
  leaves: number;
  parent: VNode | null;
}

interface Geo {
  x: number;
  y: number;
  // partition layouts
  a0: number;
  a1: number;
  r0: number;
  r1: number;
}

interface Actor {
  id: number;
  name: string;
  x: number;
  y: number;
  tx: number;
  ty: number;
  last: number;
  img: HTMLImageElement | null;
}

interface Beam {
  actor: number;
  node: string;
  born: number;
  del: boolean;
}

const LAYOUT_LABEL: Record<TreeLayout, string> = {
  radial: "radial tree",
  force: "force-directed",
  sunburst: "sunburst",
  icicle: "icicle",
};

export class TreeView extends View {
  private vroot: VNode | null = null;
  private order: VNode[] = [];
  private parentIdx = new Int32Array(0);
  private target = new Map<string, Geo>();
  private shown = new Map<string, Geo>();
  private builtRev = -1;
  private builtAt = 0;
  private builtKey = "";
  private moving = false;
  private lastFrame = 0;
  private worker: Worker | null = null;
  private workerVersion = 0;
  private forceScale = 1;
  private hover: VNode | null = null;
  private actors = new Map<number, Actor>();
  private beams: Beam[] = [];
  private lastActorStep = -1;
  private layoutSel: HTMLSelectElement;
  exporting = false;

  constructor(private app: App) {
    super("tree", "File tree");
    this.layoutSel = h("select", { "aria-label": "Layout" }, ...(Object.keys(LAYOUT_LABEL) as TreeLayout[]).map((k) => h("option", { value: k, text: LAYOUT_LABEL[k] })));
    this.layoutSel.value = app.store.get().settings.treeLayout;
    this.layoutSel.addEventListener("change", () => app.store.setSettings({ treeLayout: this.layoutSel.value as TreeLayout }));
    this.addControl(this.layoutSel);
    app.store.watch((s) => [s.settings.treeLayout, s.settings.nodeBudget, s.root, s.filterRev], () => {
      this.layoutSel.value = app.store.get().settings.treeLayout;
      this.builtKey = "";
      this.invalidate();
    });
    app.store.watch((s) => [s.cursor, s.settings.colorBy, s.search?.paths.size, s.settings.actors, s.settings.theme], () => this.invalidate());
    app.store.watch((s) => [s.settings.colorBy, s.compare, s.langs, s.settings.theme, s.settings.diffColors, s.settings.colorBy === "age" ? s.cursor : 0], () => renderColorLegend(app, this.legend), true);
  }

  private key(): string {
    const s = this.app.store.get();
    return `${s.settings.treeLayout}|${s.settings.nodeBudget}|${s.root}|${this.width}x${this.height}`;
  }

  /** How many leaves the current layout can show legibly (the node budget caps it). */
  private leafCapacity(): number {
    const s = this.app.store.get().settings;
    const R = Math.max(10, Math.min(this.width, this.height) / 2 - 14);
    const cap = {
      radial: (2 * Math.PI * R) / 3,
      force: (this.width * this.height) / 450,
      sunburst: (2 * Math.PI * R) / 1.5,
      icicle: this.height / 1.5,
    }[s.treeLayout];
    return Math.max(24, Math.min(s.nodeBudget, Math.floor(cap)));
  }

  /**
   * Visible tree: the full tree, then collapse bottom-up — the folder whose files would free
   * the most leaves goes first — until the leaves fit the layout's capacity. A collapsed
   * folder stands in for its subtree (sized by lines, colored like its largest file).
   */
  private buildVisible(display: TNode): VNode {
    const mk = (t: TNode): VNode => ({ id: t.id, t, children: t.children ? stableChildren(t).map(mk) : [], collapsed: false, rep: null, leaves: 0, parent: null });
    const root = mk(display);
    // parent links + leaf counts
    const leafParents: VNode[] = [];
    const count = (v: VNode, parent: VNode | null): number => {
      v.parent = parent;
      if (!v.children.length) return (v.leaves = 1);
      let n = 0;
      let allLeaves = true;
      for (const c of v.children) {
        n += count(c, v);
        if (c.children.length) allLeaves = false;
      }
      if (allLeaves && v !== root) leafParents.push(v);
      return (v.leaves = n);
    };
    let total = count(root, null);
    const cap = this.leafCapacity();
    if (total <= cap) return root;
    // max-heap on (leaves freed, depth)
    const depth = (v: VNode) => v.t.depth();
    const key = (v: VNode) => v.children.length - 1 + depth(v) * 1e-3;
    const heap = leafParents.map((v) => ({ v, k: key(v) }));
    heap.sort((a, b) => a.k - b.k);
    while (total > cap && heap.length) {
      const { v } = heap.pop()!;
      if (v.collapsed || !v.children.length) continue;
      // representative = largest file below
      let rep: TNode | null = null;
      const stack = [...v.children];
      while (stack.length) {
        const c = stack.pop()!;
        if (c.t.file && (!rep || c.t.file.lines > rep.file!.lines)) rep = c.t;
        if (c.rep?.file && (!rep || c.rep.file.lines > rep.file!.lines)) rep = c.rep;
        stack.push(...c.children);
      }
      total -= v.children.length - 1;
      v.children = [];
      v.collapsed = true;
      v.rep = rep;
      const par = v.parent;
      if (par && par !== root && par.children.every((c) => !c.children.length)) {
        const k = key(par);
        // insert keeping the array sorted ascending (pop takes the largest)
        let i = heap.length;
        while (i > 0 && heap[i - 1].k > k) i--;
        heap.splice(i, 0, { v: par, k });
      }
    }
    return root;
  }

  private rebuild() {
    const s = this.app.store.get();
    const tree = this.app.tree;
    const display = tree.find(s.root) ?? tree.root;
    this.vroot = this.buildVisible(display);
    const order: VNode[] = [];
    const parents: number[] = [];
    const walk = (v: VNode, p: number) => {
      const i = order.length;
      order.push(v);
      parents.push(p);
      for (const c of v.children) walk(c, i);
    };
    walk(this.vroot, -1);
    this.order = order;
    this.parentIdx = Int32Array.from(parents);
    this.builtRev = tree.rev;
    this.builtAt = clock.now();
    this.builtKey = this.key();
    this.layout();
  }

  private hier(): HierarchyNode<VNode> {
    return hierarchy<VNode>(this.vroot!, (v) => (v.children.length ? v.children : null)).sum((v) =>
      v.children.length ? 0 : v.collapsed ? v.t.value : (v.t.file && !v.t.file.binary ? v.t.file.lines : 0),
    );
  }

  private layout() {
    const s = this.app.store.get();
    const W = this.width;
    const H = this.height;
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.max(10, Math.min(W, H) / 2 - 14);
    const kind = s.settings.treeLayout;
    this.target.clear();
    const put = (id: string, g: Partial<Geo>) => this.target.set(id, { x: 0, y: 0, a0: 0, a1: 0, r0: 0, r1: 0, ...g });
    if (kind === "force") {
      this.syncWorker();
      // targets arrive asynchronously from the worker; keep previous ones for known nodes
      for (const v of this.order) {
        const g = this.shown.get(v.id);
        if (g) put(v.id, g);
      }
      return;
    }
    this.stopWorker();
    if (kind === "radial") {
      const root = d3tree<VNode>()
        .size([2 * Math.PI, R])
        .separation((a, b) => (a.parent === b.parent ? 1 : 2) / Math.max(1, a.depth))(hierarchy(this.vroot!, (v) => (v.children.length ? v.children : null)));
      root.each((n) => put(n.data.id, { x: cx + n.y * Math.sin(n.x), y: cy - n.y * Math.cos(n.x), a0: n.x, r0: n.y }));
    } else if (kind === "sunburst") {
      const root = partition<VNode>().size([2 * Math.PI, R])(this.hier()) as HierarchyRectangularNode<VNode>;
      const ringW = R / Math.max(1, root.height + 1);
      root.each((n) => {
        const r0 = n.depth * ringW;
        const r1 = (n.depth + 1) * ringW;
        const am = (n.x0 + n.x1) / 2;
        const rm = (r0 + r1) / 2;
        put(n.data.id, { a0: n.x0, a1: n.x1, r0, r1, x: cx + rm * Math.sin(am), y: cy - rm * Math.cos(am) });
      });
    } else {
      // The root column isn't drawn, so give its width to the other levels.
      const hr = this.hier();
      const cols = Math.max(1, hr.height);
      const colW = (W - 4) / cols;
      const root = partition<VNode>().size([H - 4, colW * (cols + 1)])(hr) as HierarchyRectangularNode<VNode>;
      root.each((n) => put(n.data.id, { a0: n.x0 + 2, a1: n.x1 + 2, r0: n.y0 + 2 - colW, r1: n.y1 + 2 - colW, x: (n.y0 + n.y1) / 2 - colW, y: (n.x0 + n.x1) / 2 }));
    }
  }

  private syncWorker() {
    if (!this.worker) {
      this.worker = new Worker(new URL("../workers/force.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (e: MessageEvent<{ type: string; version: number; xy: Float32Array }>) => {
        if (e.data.version !== this.workerVersion) return;
        const xy = e.data.xy;
        let maxR = 1;
        for (let i = 0; i < this.order.length; i++) maxR = Math.max(maxR, Math.hypot(xy[i * 2], xy[i * 2 + 1]));
        // Fit the simulation's extent into the card (smoothly).
        const fit = (Math.min(this.width, this.height) / 2 - 16) / maxR;
        this.forceScale += (fit - this.forceScale) * 0.1;
        const cx = this.width / 2;
        const cy = this.height / 2;
        for (let i = 0; i < this.order.length; i++) {
          const id = this.order[i].id;
          const g = this.target.get(id) ?? { x: 0, y: 0, a0: 0, a1: 0, r0: 0, r1: 0 };
          g.x = cx + xy[i * 2] * this.forceScale;
          g.y = cy + xy[i * 2 + 1] * this.forceScale;
          this.target.set(id, g);
        }
        this.invalidate();
      };
    }
    this.workerVersion++;
    const radius = Float32Array.from(this.order, (v) => this.radius(v));
    const dirs = Uint8Array.from(this.order, (v) => (v.t.isDir ? 1 : 0));
    this.worker.postMessage({ type: "sync", version: this.workerVersion, ids: this.order.map((v) => v.id), parents: this.parentIdx, radius, dirs });
  }

  private stopWorker() {
    this.worker?.terminate();
    this.worker = null;
  }

  private radius(v: VNode): number {
    if (v.t.isDir) return v.collapsed ? Math.min(14, 3 + Math.sqrt(v.t.value) * 0.05) : 2;
    const lines = v.t.file?.lines ?? 0;
    return Math.max(1.4, Math.min(7, Math.sqrt(lines) * 0.18));
  }

  protected animating() {
    return this.moving;
  }

  draw(p: Painter) {
    const pal = palette();
    const s = this.app.store.get();
    const tree = this.app.tree;
    const now = clock.now();
    const throttle = s.playing ? (this.order.length > 3000 ? 200 : 60) : 0;
    if (this.builtKey !== this.key()) this.rebuild();
    else if (tree.rev !== this.builtRev) {
      if (now - this.builtAt >= throttle) this.rebuild();
      else this.invalidate();
    }
    if (!this.vroot || this.order.length <= 1) {
      p.text(tree.step < 0 ? "Loading…" : "No files at this point", this.width / 2, this.height / 2, { color: pal.inkMuted, size: 12, align: "center" });
      return;
    }
    const dt = this.lastFrame ? Math.min(100, now - this.lastFrame) : 16;
    this.lastFrame = now;
    const k = 1 - Math.exp(-dt / 90);
    let moving = false;
    const kind = s.settings.treeLayout;
    // ease shown geometry toward targets; new nodes start at their parent
    for (let i = 0; i < this.order.length; i++) {
      const v = this.order[i];
      const t = this.target.get(v.id);
      if (!t) continue;
      let g = this.shown.get(v.id);
      if (!g) {
        const par = this.parentIdx[i] >= 0 ? this.shown.get(this.order[this.parentIdx[i]].id) : undefined;
        g =
          par && kind === "radial"
            ? { ...t, a0: par.a0, r0: par.r0 }
            : par && kind !== "icicle"
              ? { ...t, x: par.x, y: par.y, a0: t.a0, a1: t.a0, r0: t.r0, r1: t.r1 }
              : { ...t };
        this.shown.set(v.id, g);
      }
      for (const f of kind === "radial" ? (["a0", "r0"] as const) : (["x", "y", "a0", "a1", "r0", "r1"] as const)) {
        const d = t[f] - g[f];
        if (Math.abs(d) > 0.05) {
          g[f] += d * k;
          if (Math.abs(d) > 0.3) moving = true;
        } else g[f] = t[f];
      }
    }
    if (kind === "radial") {
      const cx = this.width / 2;
      const cy = this.height / 2;
      for (const g of this.shown.values()) {
        g.x = cx + g.r0 * Math.sin(g.a0);
        g.y = cy - g.r0 * Math.cos(g.a0);
      }
    }
    if (this.shown.size > this.order.length * 2 + 200) {
      const live = new Set(this.order.map((v) => v.id));
      for (const id of this.shown.keys()) if (!live.has(id)) this.shown.delete(id);
    }
    const searchPaths = s.search?.kind === "path" && s.search.paths.size ? s.search.paths : null;
    const colorBy = s.settings.colorBy;
    const pos = s.pos;

    if (kind === "sunburst" || kind === "icicle") {
      const cx = this.width / 2;
      const cy = this.height / 2;
      for (const v of this.order) {
        if (v === this.vroot) continue;
        const g = this.shown.get(v.id);
        if (!g || g.a1 - g.a0 <= 0) continue;
        const fill = v.collapsed && v.rep ? fileColor(this.app, v.rep, colorBy, pos) : v.t.isDir ? pal.surface3 : fileColor(this.app, v.t, colorBy, pos);
        const alpha = searchPaths && v.t.file && !searchPaths.has(v.t.file.pathId) ? 0.2 : 1;
        if (kind === "sunburst") {
          const gap = Math.min(0.004, (g.a1 - g.a0) * 0.2);
          p.arc(cx, cy, g.r0 + 0.5, g.r1 - 0.5, g.a0 + gap, g.a1 - gap, fill, alpha);
        } else {
          p.rect(g.r0, g.a0, Math.max(0.5, g.r1 - g.r0 - 1), Math.max(0.5, g.a1 - g.a0 - 1), fill, alpha);
          if (g.a1 - g.a0 > 13 && g.r1 - g.r0 > 40) {
            p.text(v.t.name, g.r0 + 4, (g.a0 + g.a1) / 2, { color: pal.ink2, size: 10, baseline: "middle", maxWidth: g.r1 - g.r0 - 8 });
          }
        }
        const ht = v.t.file ? heat(this.app, v.t.file.touched, pos) : 0;
        if (ht > 0.2 && colorBy !== "heat") moving ||= s.playing;
      }
    } else {
      // Edges batched by parent fan-out: wide fans get fainter so they don't read as solid wedges.
      const buckets: number[][] = [[], [], []];
      const cx = this.width / 2;
      const cy = this.height / 2;
      for (let i = 1; i < this.order.length; i++) {
        const parent = this.order[this.parentIdx[i]];
        const a = this.shown.get(parent.id);
        const b = this.shown.get(this.order[i].id);
        if (!a || !b) continue;
        const fan = parent.children.length;
        const seg = buckets[fan > 60 ? 2 : fan > 12 ? 1 : 0];
        if (kind === "radial") {
          // d3.linkRadial: cubic through the mid radius, sampled
          const rm = (a.r0 + b.r0) / 2;
          const P = [a.x, a.y, cx + rm * Math.sin(a.a0), cy - rm * Math.cos(a.a0), cx + rm * Math.sin(b.a0), cy - rm * Math.cos(b.a0), b.x, b.y];
          let px = P[0];
          let py = P[1];
          for (let k = 1; k <= 6; k++) {
            const t = k / 6;
            const u = 1 - t;
            const x = u * u * u * P[0] + 3 * u * u * t * P[2] + 3 * u * t * t * P[4] + t * t * t * P[6];
            const y = u * u * u * P[1] + 3 * u * u * t * P[3] + 3 * u * t * t * P[5] + t * t * t * P[7];
            seg.push(px, py, x, y);
            px = x;
            py = y;
          }
        } else {
          seg.push(a.x, a.y, b.x, b.y);
        }
      }
      p.segments(buckets[0], pal.inkMuted, 0.75, 0.55);
      p.segments(buckets[1], pal.inkMuted, 0.75, 0.3);
      p.segments(buckets[2], pal.inkMuted, 0.75, 0.12);
      for (const v of this.order) {
        const g = this.shown.get(v.id);
        if (!g) continue;
        const r = this.radius(v);
        if (v.t.isDir) {
          if (v.collapsed) {
            const fill = v.rep ? fileColor(this.app, v.rep, colorBy, pos) : pal.inkMuted;
            p.circle(g.x, g.y, r + 1.5, pal.ink2, 0.9);
            p.circle(g.x, g.y, r, fill, 1, pal.surface, 1);
            if (r >= 5) p.text(fmt.compact(v.t.files), g.x, g.y + r + 8, { color: pal.inkMuted, size: 9, align: "center", baseline: "middle" });
          } else {
            p.circle(g.x, g.y, 2, pal.ink2, 0.8);
          }
          continue;
        }
        const f = v.t.file!;
        const fill = fileColor(this.app, v.t, colorBy, pos);
        const alpha = searchPaths && !searchPaths.has(f.pathId) ? 0.15 : 1;
        const ht = heat(this.app, f.touched, pos);
        if (ht > 0.05 && colorBy !== "heat") {
          p.circle(g.x, g.y, r + 5 * ht, f.lastDels > f.lastAdds ? pal.del : pal.add, 0.35 * ht);
          moving ||= s.playing;
        }
        p.circle(g.x, g.y, r, fill, alpha, pal.surface, 1);
      }
      // Name the top-level folders (largest first), skipping labels that would collide.
      const placed: [number, number, number, number][] = [];
      const dirs = this.vroot.children.filter((c) => c.t.isDir).sort((a, b) => b.t.value - a.t.value);
      for (const c of dirs) {
        const g = this.shown.get(c.id);
        if (!g) continue;
        const right = kind !== "radial" || Math.sin(g.a0) >= 0;
        const w = Math.min(120, p.measure(c.t.name, 10, 600));
        const x0 = right ? g.x + 6 : g.x - 6 - w;
        const box: [number, number, number, number] = [x0 - 2, g.y - 16, x0 + w + 2, g.y - 2];
        if (placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
        placed.push(box);
        p.text(c.t.name, g.x + (right ? 6 : -6), g.y - 6, { color: pal.ink2, size: 10, weight: 600, align: right ? "left" : "right", maxWidth: 120 });
      }
      if (s.settings.actors) moving = this.drawActors(p, now) || moving;
    }
    if (this.hover) {
      const g = this.shown.get(this.hover.id);
      if (g && (kind === "radial" || kind === "force")) p.circle(g.x, g.y, this.radius(this.hover) + 3, pal.ink, 0.25);
    }
    // caption: what the tree currently shows
    const files = this.order.filter((v) => !v.t.isDir).length;
    const collapsed = this.order.filter((v) => v.collapsed).length;
    p.text(`${fmt.int(files)} files shown${collapsed ? ` · ${collapsed} folders collapsed to fit (hover for details, click to open)` : ""}`, 8, this.height - 8, { color: pal.inkMuted, size: 10 });
    this.moving = moving || (kind === "force" && !!this.worker);
  }

  /** Gource-style author actors: each step's author eases toward the files it touched. */
  private drawActors(p: Painter, now: number): boolean {
    const pal = palette();
    const s = this.app.store.get();
    const tree = this.app.tree;
    const step = tree.lastTouchedStep;
    if (step !== this.lastActorStep && step >= 0 && step <= s.cursor) {
      this.lastActorStep = step;
      const aid = this.app.tl.authors[step] ?? -1;
      if (aid >= 0) {
        const pts: Geo[] = [];
        for (const pid of tree.lastTouched) {
          const node = this.nodeForPath(pid);
          const g = node && this.shown.get(node);
          if (g) {
            pts.push(g);
            this.beams.push({ actor: aid, node: node!, born: now, del: !tree.files.has(pid) });
          }
        }
        if (this.beams.length > 400) this.beams.splice(0, this.beams.length - 400);
        let a = this.actors.get(aid);
        const tx = pts.length ? pts.reduce((acc, g) => acc + g.x, 0) / pts.length : this.width / 2;
        const ty = pts.length ? pts.reduce((acc, g) => acc + g.y, 0) / pts.length : this.height / 2;
        if (!a) {
          const name = this.app.authorName(aid);
          a = { id: aid, name, x: tx + 30, y: ty - 30, tx, ty, last: now, img: null };
          this.actors.set(aid, a);
          if (s.settings.gravatar) void this.loadGravatar(a);
        }
        a.tx = tx + 14;
        a.ty = ty - 14;
        a.last = now;
      }
    }
    let busy = false;
    for (const [id, a] of this.actors) {
      const idle = (now - a.last) / 1000;
      if (idle > 4) {
        this.actors.delete(id);
        continue;
      }
      a.x += (a.tx - a.x) * 0.12;
      a.y += (a.ty - a.y) * 0.12;
      busy = true;
    }
    this.beams = this.beams.filter((b) => now - b.born < 700);
    for (const b of this.beams) {
      const a = this.actors.get(b.actor);
      const g = this.shown.get(b.node);
      if (!a || !g) continue;
      const k = 1 - (now - b.born) / 700;
      p.line(a.x, a.y, g.x, g.y, b.del ? pal.del : pal.add, 1.5, 0.6 * k);
      busy = true;
    }
    for (const a of this.actors.values()) {
      const fade = Math.max(0.2, 1 - Math.max(0, (now - a.last) / 1000 - 1.5) / 2.5);
      const color = colorMaps.author.color(a.name);
      if (a.img?.complete && a.img.naturalWidth && p instanceof CanvasPainter) {
        const c = p.ctx;
        c.save();
        c.globalAlpha = fade;
        c.beginPath();
        c.arc(a.x, a.y, 11, 0, Math.PI * 2);
        c.clip();
        c.drawImage(a.img, a.x - 11, a.y - 11, 22, 22);
        c.restore();
      } else {
        p.circle(a.x, a.y, 11, color === pal.other ? pal.ink2 : color, fade, pal.surface, 2);
        const initials = a.name.split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase();
        p.text(initials, a.x, a.y + 0.5, { color: "#ffffff", size: 9, weight: 700, align: "center", baseline: "middle" });
      }
      p.text(a.name, a.x + 14, a.y, { color: pal.ink2, size: 10, baseline: "middle", maxWidth: 140 });
    }
    return busy;
  }

  private nodeForPath(pid: number): string | null {
    const path = this.app.paths.path[pid];
    if (!path) return null;
    // Walk up until a visible node (collapsed dirs stand in for their files).
    let id = path;
    for (;;) {
      if (this.shown.has(id)) return id;
      const cut = id.lastIndexOf("/");
      if (cut < 0) return this.vroot?.id ?? null;
      id = id.slice(0, cut);
    }
  }

  private async loadGravatar(a: Actor) {
    const author = this.app.authors.find((x) => x.id === a.id);
    if (!author?.email || !crypto.subtle) return;
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(author.email.trim().toLowerCase()));
    const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = `https://gravatar.com/avatar/${hex}?s=44&d=404`;
    a.img = img;
  }

  private hit(x: number, y: number): VNode | null {
    const kind = this.app.store.get().settings.treeLayout;
    if (kind === "sunburst") {
      const dx = x - this.width / 2;
      const dy = y - this.height / 2;
      const r = Math.hypot(dx, dy);
      let a = Math.atan2(dx, -dy);
      if (a < 0) a += 2 * Math.PI;
      for (const v of this.order) {
        const g = this.shown.get(v.id);
        if (g && v !== this.vroot && a >= g.a0 && a < g.a1 && r >= g.r0 && r < g.r1) return v;
      }
      return null;
    }
    if (kind === "icicle") {
      for (const v of this.order) {
        const g = this.shown.get(v.id);
        if (g && v !== this.vroot && y >= g.a0 && y < g.a1 && x >= g.r0 && x < g.r1) return v;
      }
      return null;
    }
    let best: VNode | null = null;
    let bd = 12 * 12;
    for (const v of this.order) {
      const g = this.shown.get(v.id);
      if (!g) continue;
      const d = (g.x - x) ** 2 + (g.y - y) ** 2;
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    return best;
  }

  protected onPointerMove(x: number, y: number, e: PointerEvent) {
    const v = this.hit(x, y);
    if (v !== this.hover) {
      this.hover = v;
      this.invalidate();
    }
    if (!v) {
      tooltip.hide();
      return;
    }
    const box = h("div", {}, h("div", { class: "h", text: v.id || "/" }));
    if (v.t.isDir) {
      box.append(tipRow(null, fmt.int(v.t.value), "lines"), tipRow(null, fmt.int(v.t.files), "files"));
      box.append(h("div", { class: "sub", text: v.collapsed ? "Collapsed (node budget) · click to open" : "Click to zoom in" }));
    } else if (v.t.file) {
      const f = v.t.file;
      const lang = this.app.paths.lang[f.pathId];
      box.append(tipRow(colorMaps.lang.color(lang), fmt.int(f.lines), `lines · ${lang}`));
      if (f.topAuthor >= 0) box.append(tipRow(colorMaps.author.color(this.app.authorName(f.topAuthor)), `${Math.round(f.topShare * 100)}%`, `written by ${this.app.authorName(f.topAuthor)}`));
      if (f.touched >= 0) box.append(tipRow(null, `#${fmt.int(f.touched + 1)}`, "last changed"));
    }
    tooltip.show(e.clientX, e.clientY, box);
  }

  protected onPointerLeave() {
    this.hover = null;
    this.invalidate();
  }

  protected onPointerDown(x: number, y: number) {
    const v = this.hit(x, y);
    if (!v) return;
    const dir = v.t.isDir ? v.t : v.t.parent;
    if (dir && dir.id !== this.app.store.get().root && (v.t.isDir || v.collapsed)) {
      tooltip.hide();
      this.app.store.set({ root: dir.id });
    }
  }

  protected onDoubleClick() {
    const root = this.app.store.get().root;
    if (!root) return;
    this.app.store.set({ root: root.includes("/") ? root.slice(0, root.lastIndexOf("/")) : "" });
  }

  destroy() {
    this.stopWorker();
    super.destroy();
  }
}
