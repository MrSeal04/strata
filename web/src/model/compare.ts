import { api, col, filterParams } from "../api/client";
import type { Compare, State, Store } from "../state/store";
import { FileTree, type Paths } from "./filetree";

export interface CompareData {
  key: string;
  a: number;
  b: number;
  linesA: Map<number, number>;
  linesB: Map<number, number>;
  /** File trees at A and at B (for side-by-side layouts and summaries). */
  treeA: FileTree;
  treeB: FileTree;
}

function compareParams(s: State, c: Compare): URLSearchParams {
  const p = filterParams(s);
  p.set("a", String(c.a));
  p.set("b", String(c.b));
  return p;
}

/** Loads /compare once per (A, B, filters) and shares it between views. */
export class CompareCache {
  data: CompareData | null = null;
  private pending = "";
  private listeners = new Set<() => void>();
  /** Main-thread cost of showing the last comparison (ms): building it, then the next frame. */
  private showMs = 0;
  /** A marker is being dragged. */
  private held = false;

  constructor(
    private store: Store,
    private repo: string,
    private paths: Paths,
  ) {
    store.watch((s) => [s.compare?.a, s.compare?.b, s.filterRev], () => this.load(), true);
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
  }

  /**
   * While a marker is dragged, comparisons follow it only if showing one is quick (on Linux it
   * takes most of a second, which would stall the drag); otherwise they wait for the release.
   */
  hold(on: boolean) {
    this.held = on;
    if (!on) this.load();
  }

  /** Move A or B to `step`, keeping A before B. */
  move(end: "a" | "b", step: number) {
    const s = this.store.get();
    const c = s.compare;
    if (!c) return;
    const v = Math.round(end === "a" ? Math.max(0, Math.min(c.b - 1, step)) : Math.max(c.a + 1, Math.min(s.steps - 1, step)));
    if (v !== c[end]) this.store.set({ compare: { ...c, [end]: v } });
  }

  private load() {
    const s = this.store.get();
    if (!s.compare) {
      this.data = null;
      this.pending = "";
      this.listeners.forEach((f) => f());
      return;
    }
    const p = compareParams(s, s.compare);
    const key = p.toString();
    // One request at a time: while A or B is dragged, the landing response shows a recent pair
    // and reloads if the pair has moved on since.
    if (this.data?.key === key || this.pending || (this.held && this.showMs > 50)) return;
    this.pending = key;
    const { a, b } = s.compare;
    api.compare(this.repo, p).then((t) => {
      if (this.pending !== key) return;
      const t0 = performance.now();
      const id = col(t, "path_id");
      const la = col(t, "lines_a");
      const lb = col(t, "lines_b");
      const linesA = new Map<number, number>();
      const linesB = new Map<number, number>();
      const treeA = new FileTree(this.paths);
      const treeB = new FileTree(this.paths);
      const rec = (pathId: number, lines: number) => ({
        pathId, lines, bytes: 0, mot: 0, topAuthor: -1, topShare: 0, binary: false, touched: -1, edited: -1, lastAdds: 0, lastDels: 0,
      });
      for (let i = 0; i < id.length; i++) {
        linesA.set(id[i], la[i]);
        linesB.set(id[i], lb[i]);
        if (la[i] > 0) treeA.set(rec(id[i], la[i]));
        if (lb[i] > 0) treeB.set(rec(id[i], lb[i]));
      }
      treeA.step = a;
      treeB.step = b;
      this.data = { key, a, b, linesA, linesB, treeA, treeB };
      this.pending = "";
      this.listeners.forEach((f) => f());
      requestAnimationFrame(() => setTimeout(() => (this.showMs = performance.now() - t0)));
      this.load();
    }).catch((e) => {
      console.error(e);
      if (this.pending !== key) return;
      this.pending = "";
      const c = this.store.get().compare;
      if (c && compareParams(this.store.get(), c).toString() !== key) this.load();
    });
  }
}
