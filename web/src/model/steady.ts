// The steady treemap: every file keeps the place it has at the end of the range, and playback
// only changes how big it is. The tiling (d3's binary split: which children go left, which way
// each cut runs, how much padding each folder gets) is recorded once from the end commit's
// sizes; each frame replays it with the current sizes, so rects grow and shrink in place,
// nothing ever swaps, and the last frame is the ordinary treemap. Renames follow the file:
// content lives where its path ends up.

import type { Table } from "apache-arrow";
import { type HierarchyRectangularNode, hierarchy, treemap } from "d3";
import { api, boolCol, col, filterParams } from "../api/client";
import type { App } from "../app";
import { type FileRec, FileTree, type TNode, stableChildren } from "./filetree";

type LNode = HierarchyRectangularNode<TNode>;

/** Where a path's content ends up: its path at the end of the range, through later renames. */
export class Lineage {
  /** path -> [(until, terminal)] ascending: content before `until` belongs to `terminal`. */
  private segs = new Map<number, { until: number; term: number }[]>();

  /** Renames (step, new path, old path), in any order. */
  constructor(step: ArrayLike<number>, pathId: ArrayLike<number>, oldPath: ArrayLike<number>) {
    const idx = Array.from({ length: step.length }, (_, i) => i).sort((a, b) => step[b] - step[a]);
    // Newest first, so a destination's own later renames are known when its source is mapped.
    for (const i of idx) {
      const term = this.resolve(pathId[i], step[i]);
      let list = this.segs.get(oldPath[i]);
      if (!list) {
        list = [];
        this.segs.set(oldPath[i], list);
      }
      list.unshift({ until: step[i], term });
    }
  }

  /** The end-of-range path of `pid`'s content at `step`. */
  resolve(pid: number, step: number): number {
    const list = this.segs.get(pid);
    if (list) for (const g of list) if (step < g.until) return g.term;
    return pid;
  }

  /** The last step `pid` was renamed away at (-1: never). */
  lastAway(pid: number): number {
    const list = this.segs.get(pid);
    return list ? list[list.length - 1].until : -1;
  }

  /** Every end-of-range path some renamed content goes to. */
  terminals(): Set<number> {
    const out = new Set<number>();
    for (const list of this.segs.values()) for (const g of list) out.add(g.term);
    return out;
  }
}

/** One cut of d3's binary tiling: children [i, k) on one side, [k, j) on the other. */
export interface Split {
  k: number;
  /** Cut runs vertically (the left part gets x0..xk). */
  across: boolean;
}

/** Per folder id, its cuts by range (i * 2^20 + j). */
export type Splits = Map<string, Map<number, Split>>;

/** d3's `treemapBinary` choice for children [i, j): the balanced cut, along the longer side. */
function balanced(i: number, j: number, sums: number[], value: number, w: number, h: number): Split {
  const valueOffset = sums[i];
  const valueTarget = value / 2 + valueOffset;
  let k = i + 1;
  let hi = j - 1;
  while (k < hi) {
    const mid = (k + hi) >>> 1;
    if (sums[mid] < valueTarget) k = mid + 1;
    else hi = mid;
  }
  if (valueTarget - sums[k - 1] < sums[k] - valueTarget && i + 1 < k) --k;
  return { k, across: w > h };
}

/** d3's binary tiling with a pluggable cut choice (same arithmetic as `treemapBinary`). */
function binary(parent: LNode, x0: number, y0: number, x1: number, y1: number, choose: (i: number, j: number, sums: number[], value: number, w: number, h: number) => Split) {
  const nodes = parent.children as LNode[];
  const n = nodes.length;
  const sums = new Array<number>(n + 1);
  sums[0] = 0;
  for (let i = 0; i < n; i++) sums[i + 1] = sums[i] + (nodes[i].value ?? 0);
  const partition = (i: number, j: number, value: number, x0: number, y0: number, x1: number, y1: number) => {
    if (i >= j - 1) {
      const node = nodes[i];
      node.x0 = x0;
      node.y0 = y0;
      node.x1 = x1;
      node.y1 = y1;
      return;
    }
    const { k, across } = choose(i, j, sums, value, x1 - x0, y1 - y0);
    const valueLeft = sums[k] - sums[i];
    const valueRight = value - valueLeft;
    if (across) {
      const xk = value ? (x0 * valueRight + x1 * valueLeft) / value : x1;
      partition(i, k, valueLeft, x0, y0, xk, y1);
      partition(k, j, valueRight, xk, y0, x1, y1);
    } else {
      const yk = value ? (y0 * valueRight + y1 * valueLeft) / value : y1;
      partition(i, k, valueLeft, x0, y0, x1, yk);
      partition(k, j, valueRight, x0, yk, x1, y1);
    }
  };
  partition(0, n, sums[n], x0, y0, x1, y1);
}

const rangeKey = (i: number, j: number) => i * 1048576 + j;

/** Binary tiling that records every cut. */
export function recordingTile(splits: Splits) {
  return (parent: LNode, x0: number, y0: number, x1: number, y1: number) => {
    const rec = new Map<number, Split>();
    splits.set(parent.data.id, rec);
    binary(parent, x0, y0, x1, y1, (i, j, sums, value, w, h) => {
      const s = balanced(i, j, sums, value, w, h);
      rec.set(rangeKey(i, j), s);
      return s;
    });
  };
}

/** Binary tiling that replays recorded cuts (balanced cuts where none was recorded). */
export function replayTile(splits: Splits) {
  return (parent: LNode, x0: number, y0: number, x1: number, y1: number) => {
    const rec = splits.get(parent.data.id);
    binary(parent, x0, y0, x1, y1, (i, j, sums, value, w, h) => rec?.get(rangeKey(i, j)) ?? balanced(i, j, sums, value, w, h));
  };
}

const area = (n: LNode) => (n.x1 - n.x0) * (n.y1 - n.y0);

/**
 * The treemap's padding, where it's visible: at Linux scale fixed gaps would eat every small file
 * and leave gray folder backgrounds, so small folders pack their files edge to edge.
 */
export interface Padding {
  outer: (n: LNode) => number;
  inner: (n: LNode) => number;
  top: (n: LNode) => number;
}

export const livePadding: Padding = {
  outer: (n: LNode) => (n.depth === 0 ? 2 : area(n) > 2500 ? 2 : area(n) > 400 ? 1 : 0),
  inner: (n: LNode) => (area(n) > 1200 ? 1 : 0),
  top: (n: LNode) => (n.depth > 0 && n.data.isDir && n.x1 - n.x0 > 60 && n.y1 - n.y0 > 36 ? 15 : n.depth === 0 ? 2 : area(n) > 400 ? 1 : 0),
};

/** Per folder id: [outer, inner, top] padding, as recorded. */
export type Pads = Map<string, [number, number, number]>;

/**
 * The live padding, recorded per folder (`record`), or replayed from the recording. Replayed
 * padding is capped at 45% of the folder's extent now, so a folder much smaller than at the end
 * (early in history) keeps room for its files instead of collapsing under its header.
 */
export function frozenPadding(pads: Pads, record: boolean): Padding {
  const get = (n: LNode, which: 0 | 1 | 2, live: (n: LNode) => number) => {
    let p = pads.get(n.data.id);
    if (!p) {
      if (!record) return live(n);
      p = [Number.NaN, Number.NaN, Number.NaN];
      pads.set(n.data.id, p);
    }
    if (record) {
      if (Number.isNaN(p[which])) p[which] = live(n);
      return p[which];
    }
    if (Number.isNaN(p[which])) return live(n);
    const extent = which === 2 ? n.y1 - n.y0 : Math.min(n.x1 - n.x0, n.y1 - n.y0);
    return Math.min(p[which], Math.max(0, 0.45 * extent));
  };
  return {
    outer: (n: LNode) => get(n, 0, livePadding.outer),
    inner: (n: LNode) => get(n, 1, livePadding.inner),
    top: (n: LNode) => get(n, 2, livePadding.top),
  };
}

/** Lay out `display` at w × h with a tile and padding. */
export function layoutTree(display: TNode, w: number, h: number, weight: (n: TNode) => number, tile: (p: LNode, x0: number, y0: number, x1: number, y1: number) => void, pad: Padding): LNode {
  const root = hierarchy<TNode>(display, (n) => (n.children ? stableChildren(n) : null)).sum(weight);
  treemap<TNode>()
    .tile(tile as never)
    .size([w, h])
    .paddingOuter(pad.outer as never)
    .paddingInner(pad.inner as never)
    .paddingTop(pad.top as never)(root);
  return root as LNode;
}

const rec = (pathId: number, lines: number, binary: boolean): FileRec => ({
  pathId, lines, bytes: 0, mot: 0, topAuthor: -1, topShare: 0, binary, touched: -1, edited: -1, lastAdds: 0, lastDels: 0,
});

/** The reference for the steady treemap, and its per-frame layout. */
export class SteadyLayout {
  private ref: FileTree | null = null;
  private refWeight = new Map<TNode, number>();
  private refLeaves: TNode[] = [];
  private lineage: Lineage | null = null;
  /** Range [a, b] the reference covers. */
  range: [number, number] = [0, 0];
  private dataKey = "";
  private loading = "";
  private recKey = "";
  private splits: Splits = new Map();
  private pads: Pads = new Map();
  onReady: (() => void) | null = null;

  constructor(private app: App) {}

  private wanted(): boolean {
    const s = this.app.store.get();
    return s.settings.treemapLayout === "steady" && !s.compare;
  }

  private wantKey(): string {
    const s = this.app.store.get();
    const [a, b] = s.brush ?? [0, Math.max(0, s.steps - 1)];
    return `${a}|${b}|${s.settings.treemapMeasure}|${s.filterRev}`;
  }

  /** Whether the steady layout can draw the cursor now (otherwise the live one stands in). */
  usable(): boolean {
    const cur = this.app.store.get().cursor;
    return this.wanted() && !!this.ref && this.dataKey === this.wantKey() && cur >= this.range[0] && cur <= this.range[1];
  }

  /** Changes whenever `usable` or the reference does (the treemap's layout key). */
  stateKey(): string {
    return this.usable() ? this.dataKey : "";
  }

  /** Load the reference for the current range, measure and filters, if steady is on. */
  ensure() {
    if (!this.wanted()) return;
    const key = this.wantKey();
    if (key === this.dataKey || key === this.loading) return;
    this.loading = key;
    const s = this.app.store.get();
    const [a, b] = s.brush ?? [0, Math.max(0, s.steps - 1)];
    const churn = s.settings.treemapMeasure === "churn";
    const p = filterParams(s);
    const q = (from: number, to: number) => {
      const x = new URLSearchParams(p);
      x.set("from", String(from));
      x.set("to", String(to));
      return x;
    };
    const renamesFrom = churn ? Math.max(0, a - 1) : a;
    Promise.all([churn ? api.churn(this.app.repo, q(a - 1, b)) : api.span(this.app.repo, q(a, b)), api.renames(this.app.repo, q(renamesFrom, b))])
      .then(([files, renames]) => {
        if (this.loading !== key) return;
        this.build(files, renames, churn);
        this.range = [a, b];
        this.dataKey = key;
        this.loading = "";
        this.recKey = "";
        this.onReady?.();
      })
      .catch((e) => {
        if (this.loading === key) this.loading = "";
        console.error(e);
      });
  }

  private build(files: Table, renames: Table, churn: boolean) {
    const lineage = new Lineage(col(renames, "step"), col(renames, "path_id"), col(renames, "old_path_id"));
    const id = col(files, "path_id");
    const weight = new Map<number, number>();
    const binary = new Set<number>();
    /** Files there at the range end (null: all of them, as in the churn view). */
    let aliveEnd: Set<number> | null = null;
    if (churn) {
      // Lines changed over the whole window, credited to where each file's content ends up.
      const adds = col(files, "adds");
      const dels = col(files, "dels");
      const last = col(files, "last_step");
      for (let i = 0; i < id.length; i++) {
        const t = lineage.resolve(id[i], last[i]);
        weight.set(t, (weight.get(t) ?? 0) + adds[i] + dels[i]);
      }
    } else {
      // A path that was only ever renamed away lives on in its terminal; one that came back
      // (added or changed after its last move) is a place of its own.
      const lines = col(files, "lines_end");
      const bin = boolCol(files, "binary");
      const live = col(files, "last_live");
      const alive = boolCol(files, "alive_end");
      aliveEnd = new Set();
      for (let i = 0; i < id.length; i++) {
        if (live[i] < lineage.lastAway(id[i])) continue;
        weight.set(id[i], bin[i] ? 0 : lines[i]);
        if (bin[i]) binary.add(id[i]);
        if (alive[i]) aliveEnd.add(id[i]);
      }
    }
    for (const t of lineage.terminals()) if (!weight.has(t)) weight.set(t, 0);
    // Insert oldest paths first: a folder's place is its first file's.
    const fs = this.app.paths.firstStep;
    const order = [...weight.keys()].sort((x, y) => fs[x] - fs[y] || x - y);
    const ref = new FileTree(this.app.paths);
    for (const pid of order) ref.set(rec(pid, weight.get(pid) ?? 0, binary.has(pid)));
    this.refWeight.clear();
    this.refLeaves = [];
    for (const pid of order) {
      const leaf = ref.leaf(pid);
      if (!leaf) continue;
      this.refWeight.set(leaf, weight.get(pid) ?? 0);
      this.refLeaves.push(leaf);
    }
    // A folder sorts by its oldest file still there at the end, as the live tree at the end
    // does, so the end frame tiles like the live treemap (files gone by then don't pull their
    // folder forward).
    const place = (n: TNode): number => {
      if (!n.children) return !aliveEnd || (n.file && aliveEnd.has(n.file.pathId)) ? n.order : Number.POSITIVE_INFINITY;
      let m = Number.POSITIVE_INFINITY;
      for (const c of n.children.values()) m = Math.min(m, place(c));
      if (m < Number.POSITIVE_INFINITY) n.order = m;
      return m;
    };
    place(ref.root);
    this.ref = ref;
    this.lineage = lineage;
  }

  /**
   * The reference tree laid out for `source` (the live or churn tree) at `step`, at w × h: each
   * reference file shows the current file whose content it holds (sized by its lines now).
   */
  layout(source: FileTree, step: number, rootDir: string, w: number, h: number): LNode | null {
    const ref = this.ref;
    const lineage = this.lineage;
    if (!ref || !lineage) return null;
    const display = ref.find(rootDir) ?? ref.root;
    const recKey = `${w}x${h}|${rootDir}|${this.dataKey}`;
    if (recKey !== this.recKey) {
      this.splits = new Map();
      this.pads = new Map();
      layoutTree(display, w, h, (n) => this.refWeight.get(n) ?? 0, recordingTile(this.splits), frozenPadding(this.pads, true));
      this.recKey = recKey;
    }
    for (const leaf of this.refLeaves) leaf.file = null;
    for (const f of source.files.values()) {
      const leaf = ref.leaf(lineage.resolve(f.pathId, step));
      if (!leaf) continue;
      leaf.file = leaf.file ? { ...leaf.file, lines: leaf.file.lines + (f.binary ? 0 : f.lines) } : f;
    }
    return layoutTree(display, w, h, (n) => (n.file && !n.file.binary ? n.file.lines : 0), replayTile(this.splits), frozenPadding(this.pads, false));
  }
}
