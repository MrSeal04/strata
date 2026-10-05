import { type HierarchyNode, type HierarchyRectangularNode, hierarchy, partition, tree as d3tree } from "d3";
import type { App } from "../app";
import { colorMaps } from "../model/colors";
import { TNode, largestFile as largestFileBelow, stableChildren } from "../model/filetree";
import { assignDirColors, fileColor, heat, heatSpan } from "../model/slices";
import { CanvasPainter } from "../paint/canvas";
import type { Painter } from "../paint/painter";
import type { TreeLayout } from "../state/store";
import { palette } from "../theme";
import { colorControls, settingSelect, settingToggle } from "../ui/controls";
import { fmt, h, icon } from "../ui/dom";
import { tipRow, tooltip } from "../ui/tooltip";
import { clock } from "../clock";
import { renderColorLegend } from "./colorlegend";
import { View } from "./view";
import { ZoomPan } from "./zoom";

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
  /** A grouping of a folder's loose files (not a real directory). */
  synthetic?: boolean;
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

/** The largest file below a visible node (the color of a collapsed folder). A real folder's
 *  visible nodes cover its whole subtree; a synthetic group of loose files covers its files. */
function largestFile(v: VNode): TNode | null {
  if (!v.synthetic) return largestFileBelow(v.t);
  let rep: TNode | null = null;
  for (const c of v.children) {
    const l = largestFileBelow(c.t);
    if (l && (!rep || l.file!.lines > rep.file!.lines)) rep = l;
  }
  return rep;
}

const LAYOUT_LABEL: Record<TreeLayout, string> = {
  force: "force-directed",
  radial: "radial tree",
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
  /** Wheel/pinch zoom and pan over the layout (world units = the unzoomed card). */
  readonly zoom: ZoomPan;
  private zoomBtn: HTMLButtonElement;

  constructor(private app: App) {
    super("tree", "File tree");
    this.layoutSel = h("select", { "aria-label": "Layout" }, ...(Object.keys(LAYOUT_LABEL) as TreeLayout[]).map((k) => h("option", { value: k, text: LAYOUT_LABEL[k] })));
    this.layoutSel.value = app.store.get().settings.treeLayout;
    this.layoutSel.addEventListener("change", () => app.store.setSettings({ treeLayout: this.layoutSel.value as TreeLayout }));
    this.zoomBtn = h("button", { class: "btn icon", title: "Reset zoom", "aria-label": "Reset zoom" }, icon("fit"));
    this.zoomBtn.addEventListener("click", () => this.zoom.reset());
    this.zoomBtn.style.display = "none";
    this.zoom = new ZoomPan(this.canvas);
    this.zoom.onChange = () => {
      tooltip.hide();
      this.zoomBtn.style.display = this.zoom.zoomed ? "" : "none";
      this.invalidate();
    };
    const color = colorControls(app, "treeColorBy", "treemap");
    const nodes = settingSelect(app.store, "nodeBudget", [1000, 3000, 6000, 12_000, 25_000, 50_000].map((n) => [n, `${fmt.int(n)} nodes`]), {
      label: "Node budget",
      title: "Most nodes the tree shows; deeper folders collapse above it",
      custom: (n) => `${fmt.int(n)} nodes`,
    });
    const actors = settingToggle(app.store, "actors", "Actors", "Gource-style: authors fly to the files they touch");
    const avatars = settingToggle(app.store, "gravatar", "Avatars", "Show authors' pictures, loaded from gravatar.com using a SHA-256 hash of each email");
    this.addControl(this.layoutSel);
    this.addControl(color.show);
    this.addControl(color.extra);
    this.addControl(color.glow);
    this.addControl(nodes);
    this.addControl(actors);
    this.addControl(avatars);
    this.addControl(this.zoomBtn);
    // Actors fly only over the node layouts; avatars only mean something with actors on.
    app.store.watch((s) => [s.settings.treeLayout, s.settings.actors], () => {
      const st = app.store.get().settings;
      const nodeLayout = st.treeLayout === "radial" || st.treeLayout === "force";
      actors.style.display = nodeLayout ? "" : "none";
      avatars.style.display = nodeLayout && st.actors ? "" : "none";
    }, true);
    // Avatars follow the toggle for authors already on screen too.
    app.store.watch((s) => s.settings.gravatar, (on) => {
      for (const a of this.actors.values()) {
        if (!on) a.img = null;
        else if (!a.img) void this.loadGravatar(a);
      }
      this.invalidate();
    });
    // A new root or layout starts unzoomed.
    app.store.watch((s) => [s.root, s.settings.treeLayout], () => this.zoom.reset());
    app.store.watch((s) => [s.settings.treeLayout, s.settings.nodeBudget, s.root, s.filterRev], () => {
      this.layoutSel.value = app.store.get().settings.treeLayout;
      this.builtKey = "";
      this.invalidate();
    });
    app.store.watch((s) => [s.cursor, s.settings.treeColorBy, s.search?.paths.size, s.settings.actors, s.settings.theme, s.settings.areaDepth, s.settings.cohortUnit], () => this.invalidate());
    const legend = () => renderColorLegend(app, this.legend, app.store.get().settings.treeColorBy);
    // (the last-edited scale stretches with the history's age at the cursor)
    const spanKey = (s: { settings: { treeColorBy: string } }) => (s.settings.treeColorBy === "edited" ? Math.round(Math.log(heatSpan(app)) * 8) : 0);
    app.store.watch((s) => [s.settings.treeColorBy, s.compare, s.langs, s.authors, s.root, s.settings.areaDepth, s.settings.cohortUnit, s.settings.theme, s.settings.diffColors, spanKey(s)], legend, true);
    // Directory colors are handed out by whichever card shows directories (see ensureDirColors).
    colorMaps.dir.onChange(() => {
      if (app.store.get().settings.treeColorBy !== "dir") return;
      legend();
      this.invalidate();
    });
    colorMaps.author.onChange(() => {
      if (app.store.get().settings.treeColorBy !== "author") return;
      legend();
      this.invalidate();
    });
    app.composition.onChange(() => {
      legend();
      this.invalidate();
    });
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
    // Folders with many loose files get them grouped under a synthetic "N files" node, so the
    // collapse below can fold them like a folder (a root with 400 files would otherwise be a ring).
    const LOOSE = 40;
    // Below the depth cap folders are collapsed straight away (no nodes built for their files:
    // at Linux scale that is most of the tree).
    const maxDepth = { radial: 4, force: 6, sunburst: 6, icicle: 6 }[this.app.store.get().settings.treeLayout];
    const mk = (t: TNode, depth: number): VNode => {
      if (t.isDir && depth >= maxDepth && depth > 0) {
        const v: VNode = { id: t.id, t, children: [], collapsed: true, rep: null, leaves: 0, parent: null };
        v.rep = largestFile(v);
        return v;
      }
      const kids = t.children ? stableChildren(t) : [];
      const files = kids.filter((c) => !c.isDir);
      const dirs = kids.filter((c) => c.isDir);
      let children: VNode[];
      if (files.length > LOOSE && dirs.length > 0) {
        const g = new TNode(`${t.id}\u0000files`, `${files.length} files`, t, true, files[0].order);
        g.value = files.reduce((a, f) => a + (f.file?.lines ?? 0), 0);
        g.files = files.length;
        const group: VNode = { id: g.id, t: g, children: files.map((f) => mk(f, depth + 2)), collapsed: false, rep: null, leaves: 0, parent: null, synthetic: true };
        children = [...dirs.map((d) => mk(d, depth + 1)), group];
      } else {
        children = kids.map((c) => mk(c, depth + 1));
      }
      return { id: t.id, t, children, collapsed: false, rep: null, leaves: 0, parent: null };
    };
    const root = mk(display, 0);
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
      total -= v.children.length - 1;
      v.rep = largestFile(v);
      v.children = [];
      v.collapsed = true;
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

  /** Directory color slots handed out for the tree (root|depth|map version). */
  private dirColorsFor = "";

  /**
   * The treemap and the area chart hand out directory colors when they show directories; with
   * neither, the tree must, or its files stay gray. This runs at draw time because the dashboard
   * clears the map on a new root or depth after every view's store watch has run.
   */
  private ensureDirColors() {
    const s = this.app.store.get();
    if (s.settings.treeColorBy !== "dir" || s.compare) return;
    const key = () => `${s.root}|${s.settings.areaDepth}|${colorMaps.dir.version}`;
    if (key() === this.dirColorsFor) return;
    assignDirColors(this.app, this.app.tree.find(s.root) ?? this.app.tree.root);
    this.dirColorsFor = key();
  }

  private rebuild() {
    // (new folders may have appeared: offer them the free slots)
    this.dirColorsFor = "";
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
    if (this.builtKey.split("|").pop() !== `${this.width}x${this.height}`) {
        // Positions from another size or layout mean nothing now.
        this.actors.clear();
        this.beams = [];
    }
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
        // (frozen while zoomed, so the view doesn't drift away from where it was zoomed)
        if (!this.zoom.zoomed) this.forceScale += (fit - this.forceScale) * 0.1;
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
    const throttle = s.playing ? (tree.files.size > 50_000 ? 800 : this.order.length > 3000 ? 200 : 60) : 0;
    if (this.builtKey !== this.key()) this.rebuild();
    else if (tree.rev !== this.builtRev) {
      if (now - this.builtAt >= throttle) this.rebuild();
      else this.invalidate();
    }
    this.ensureDirColors();
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
    const colorBy = s.settings.treeColorBy;
    const pos = s.pos;

    // Geometry is in world units (the unzoomed card); everything is painted through the zoom.
    const Z = this.zoom;
    const zk = Z.k;
    const W = this.width;
    const H = this.height;
    if (kind === "sunburst" || kind === "icicle") {
      const cx = Z.sx(this.width / 2);
      const cy = Z.sy(this.height / 2);
      for (const v of this.order) {
        if (v === this.vroot) continue;
        const g = this.shown.get(v.id);
        if (!g || g.a1 - g.a0 <= 0) continue;
        const fill = v.collapsed && v.rep ? fileColor(this.app, v.rep, colorBy, pos) : v.t.isDir ? pal.surface3 : fileColor(this.app, v.t, colorBy, pos);
        const alpha = searchPaths && v.t.file && !searchPaths.has(v.t.file.pathId) ? 0.2 : 1;
        if (kind === "sunburst") {
          const gap = Math.min(0.004, (g.a1 - g.a0) * 0.2);
          p.arc(cx, cy, g.r0 * zk + 0.5, g.r1 * zk - 0.5, g.a0 + gap, g.a1 - gap, fill, alpha);
        } else {
          const x = Z.sx(g.r0);
          const y = Z.sy(g.a0);
          const w = (g.r1 - g.r0) * zk;
          const hh = (g.a1 - g.a0) * zk;
          if (x > W || y > H || x + w < 0 || y + hh < 0) continue;
          p.rect(x, y, Math.max(0.5, w - 1), Math.max(0.5, hh - 1), fill, alpha);
          if (hh > 13 && w > 40) {
            p.text(v.t.name, Math.max(0, x) + 4, y + hh / 2, { color: pal.ink2, size: 10, baseline: "middle", maxWidth: Math.min(w, x + w) - 8 });
          }
        }
        const ht = v.t.file ? heat(this.app, v.t.file.touched, pos) : 0;
        if (ht > 0.2 && colorBy !== "heat" && colorBy !== "edited") moving ||= s.playing;
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
          let px = Z.sx(P[0]);
          let py = Z.sy(P[1]);
          for (let k = 1; k <= 6; k++) {
            const t = k / 6;
            const u = 1 - t;
            const x = Z.sx(u * u * u * P[0] + 3 * u * u * t * P[2] + 3 * u * t * t * P[4] + t * t * t * P[6]);
            const y = Z.sy(u * u * u * P[1] + 3 * u * u * t * P[3] + 3 * u * t * t * P[5] + t * t * t * P[7]);
            seg.push(px, py, x, y);
            px = x;
            py = y;
          }
        } else {
          seg.push(Z.sx(a.x), Z.sy(a.y), Z.sx(b.x), Z.sy(b.y));
        }
      }
      p.segments(buckets[0], pal.inkMuted, 0.75, 0.55);
      p.segments(buckets[1], pal.inkMuted, 0.75, 0.3);
      p.segments(buckets[2], pal.inkMuted, 0.75, 0.12);
      // Nodes grow with the zoom, but slower than the spacing, so zooming in opens room.
      const rk = Math.sqrt(zk);
      const off = (x: number, y: number, r: number) => x + r < 0 || y + r < 0 || x - r > W || y - r > H;
      for (const v of this.order) {
        const g = this.shown.get(v.id);
        if (!g) continue;
        const r = this.radius(v) * rk;
        const x = Z.sx(g.x);
        const y = Z.sy(g.y);
        if (off(x, y, r + 6)) continue;
        if (v.t.isDir) {
          if (v.collapsed) {
            const fill = v.rep ? fileColor(this.app, v.rep, colorBy, pos) : pal.inkMuted;
            p.circle(x, y, r + 1.5, pal.ink2, 0.9);
            p.circle(x, y, r, fill, 1, pal.surface, 1);
            if (r >= 5) p.text(fmt.compact(v.t.files), x, y + r + 8, { color: pal.inkMuted, size: 9, align: "center", baseline: "middle" });
          } else {
            p.circle(x, y, 2, pal.ink2, 0.8);
          }
          continue;
        }
        const f = v.t.file!;
        const fill = fileColor(this.app, v.t, colorBy, pos);
        const alpha = searchPaths && !searchPaths.has(f.pathId) ? 0.15 : 1;
        const ht = heat(this.app, f.touched, pos);
        if (ht > 0.05 && colorBy !== "heat" && colorBy !== "edited") {
          p.circle(x, y, r + 5 * ht, f.lastDels > f.lastAdds ? pal.del : pal.add, 0.35 * ht);
          moving ||= s.playing;
        }
        p.circle(x, y, r, fill, alpha, pal.surface, 1);
      }
      // Name folders, largest first, skipping labels that would collide: the top level at first,
      // and as zooming opens room, deeper folders and then files too.
      const placed: [number, number, number, number][] = [];
      const named = zk > 1.5 ? this.order.filter((v) => v !== this.vroot && (v.t.isDir || zk > 3) && !v.synthetic) : this.vroot.children.filter((c) => c.t.isDir);
      named.sort((a, b) => Number(b.t.isDir) - Number(a.t.isDir) || b.t.value - a.t.value || (b.t.file?.lines ?? 0) - (a.t.file?.lines ?? 0));
      let budget = 250;
      for (const c of named) {
        const g = this.shown.get(c.id);
        if (!g) continue;
        const x = Z.sx(g.x);
        const y = Z.sy(g.y);
        if (off(x, y, 0)) continue;
        const right = kind !== "radial" || Math.sin(g.a0) >= 0;
        const bold = c.t.isDir;
        const w = Math.min(120, p.measure(c.t.name, 10, bold ? 600 : 400));
        const x0 = right ? x + 6 : x - 6 - w;
        const box: [number, number, number, number] = [x0 - 2, y - 16, x0 + w + 2, y - 2];
        if (placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
        placed.push(box);
        p.text(c.t.name, x + (right ? 6 : -6), y - 6, { color: bold ? pal.ink2 : pal.inkMuted, size: 10, weight: bold ? 600 : 400, align: right ? "left" : "right", maxWidth: 120 });
        if (--budget <= 0) break;
      }
      if (s.settings.actors) moving = this.drawActors(p, now) || moving;
    }
    if (this.hover) {
      const g = this.shown.get(this.hover.id);
      if (g && (kind === "radial" || kind === "force")) p.circle(Z.sx(g.x), Z.sy(g.y), this.radius(this.hover) * Math.sqrt(zk) + 3, pal.ink, 0.25);
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
        // Actors live on screen: they fly to where the files are drawn.
        const tx = pts.length ? pts.reduce((acc, g) => acc + this.zoom.sx(g.x), 0) / pts.length : this.width / 2;
        const ty = pts.length ? pts.reduce((acc, g) => acc + this.zoom.sy(g.y), 0) / pts.length : this.height / 2;
        if (!a) {
          const name = this.app.authorName(aid);
          a = { id: aid, name, x: Math.max(16, Math.min(this.width - 150, tx + 30)), y: Math.max(16, Math.min(this.height - 16, ty - 30)), tx, ty, last: now, img: null };
          this.actors.set(aid, a);
          if (s.settings.gravatar) void this.loadGravatar(a);
        }
        a.tx = Math.max(16, Math.min(this.width - 150, tx + 14));
        a.ty = Math.max(16, Math.min(this.height - 16, ty - 14));
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
      p.line(a.x, a.y, this.zoom.sx(g.x), this.zoom.sy(g.y), b.del ? pal.del : pal.add, 1.5, 0.6 * k);
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

  private hit(sx: number, sy: number): VNode | null {
    const kind = this.app.store.get().settings.treeLayout;
    const x = this.zoom.wx(sx);
    const y = this.zoom.wy(sy);
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
    let bd = (12 / this.zoom.k) ** 2;
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
    const title = v.synthetic ? `${v.t.name} in ${v.t.parent?.id || "/"}` : v.id || "/";
    const box = h("div", {}, h("div", { class: "h", text: title }));
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

  protected onResize() {
    this.zoom.resize(this.width, this.height);
  }

  protected onClick(x: number, y: number) {
    const v = this.hit(x, y);
    if (!v) return;
    const dir = v.synthetic ? v.t.parent : v.t.isDir ? v.t : v.t.parent;
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
