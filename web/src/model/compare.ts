import { api, col, filterParams } from "../api/client";
import type { Store } from "../state/store";
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

/** Loads /compare once per (A, B, filters) and shares it between views. */
export class CompareCache {
  data: CompareData | null = null;
  private pending = "";
  private listeners = new Set<() => void>();

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

  private load() {
    const s = this.store.get();
    if (!s.compare) {
      this.data = null;
      this.pending = "";
      this.listeners.forEach((f) => f());
      return;
    }
    const p = filterParams(s);
    p.set("a", String(s.compare.a));
    p.set("b", String(s.compare.b));
    const key = p.toString();
    if (this.data?.key === key || this.pending === key) return;
    this.pending = key;
    const { a, b } = s.compare;
    api.compare(this.repo, p).then((t) => {
      if (this.pending !== key) return;
      const id = col(t, "path_id");
      const la = col(t, "lines_a");
      const lb = col(t, "lines_b");
      const linesA = new Map<number, number>();
      const linesB = new Map<number, number>();
      const treeA = new FileTree(this.paths);
      const treeB = new FileTree(this.paths);
      const rec = (pathId: number, lines: number) => ({
        pathId, lines, bytes: 0, mot: 0, topAuthor: -1, topShare: 0, binary: false, touched: -1, lastAdds: 0, lastDels: 0,
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
    }).catch(console.error);
  }
}
