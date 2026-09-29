import { tableFromArrays } from "apache-arrow";
import { type HierarchyRectangularNode, treemapBinary } from "d3";
import { describe, expect, it } from "vitest";
import { FileTree, Paths, type TNode } from "../src/model/filetree";
import { Lineage, type Pads, type Splits, frozenPadding, layoutTree, livePadding, recordingTile, replayTile } from "../src/model/steady";

const names = ["src/a.rs", "src/b.rs", "src/c.rs", "src/deep/d.rs", "src/deep/e.rs", "docs/x.md", "docs/y.md", "README.md", "src/f.rs", "lib/g.rs"];
const P = new Paths(
  tableFromArrays({
    path_id: Uint32Array.from(names.map((_, i) => i)),
    path: names,
    lang: names.map(() => "Rust"),
    category: Uint8Array.from(names.map(() => 0)),
    first_step: Uint32Array.from(names.map((_, i) => i)),
    last_step: Uint32Array.from(names.map((_, i) => i)),
  }),
);
const rec = (pathId: number, lines: number) => ({
  pathId, lines, bytes: 0, mot: 0, topAuthor: -1, topShare: 0, binary: false, touched: -1, edited: -1, lastAdds: 0, lastDels: 0,
});
const SIZES = [400, 120, 900, 60, 300, 250, 40, 80, 700, 150];

function tree(sizes: number[]): FileTree {
  const t = new FileTree(P);
  sizes.forEach((n, i) => t.set(rec(i, n)));
  return t;
}
const lines = (n: TNode) => n.file?.lines ?? 0;
const rects = (root: HierarchyRectangularNode<TNode>) => {
  const out = new Map<string, number[]>();
  root.each((n) => out.set(n.data.id, [n.x0, n.y0, n.x1, n.y1]));
  return out;
};

describe("steady tiling", () => {
  it("records exactly what d3's binary tiling lays out", () => {
    const t = tree(SIZES);
    const d3 = rects(layoutTree(t.root, 800, 500, lines, treemapBinary as never, livePadding));
    const ours = rects(layoutTree(t.root, 800, 500, lines, recordingTile(new Map()), livePadding));
    expect(ours).toEqual(d3);
  });

  it("replays the recording exactly at the recorded sizes", () => {
    const t = tree(SIZES);
    const splits: Splits = new Map();
    const pads: Pads = new Map();
    const recorded = rects(layoutTree(t.root, 800, 500, lines, recordingTile(splits), frozenPadding(pads, true)));
    const replayed = rects(layoutTree(t.root, 800, 500, lines, replayTile(splits), frozenPadding(pads, false)));
    expect(replayed).toEqual(recorded);
  });

  it("moves every rect a little when one file grows a little", () => {
    const t = tree(SIZES);
    const splits: Splits = new Map();
    const pads: Pads = new Map();
    const before = rects(layoutTree(t.root, 800, 500, lines, recordingTile(splits), frozenPadding(pads, true)));
    t.set(rec(2, SIZES[2] * 1.02));
    const after = rects(layoutTree(t.root, 800, 500, lines, replayTile(splits), frozenPadding(pads, false)));
    let worst = 0;
    for (const [id, r] of before) for (let i = 0; i < 4; i++) worst = Math.max(worst, Math.abs(r[i] - after.get(id)![i]));
    expect(worst).toBeLessThan(6);
    // d3's own tiling reshuffles for the same change when a cut flips; ours never does, so
    // every file keeps its neighbours.
  });

  it("gives files with no lines no area, and keeps everything inside the card", () => {
    const t = tree(SIZES);
    const splits: Splits = new Map();
    const pads: Pads = new Map();
    layoutTree(t.root, 800, 500, lines, recordingTile(splits), frozenPadding(pads, true));
    const early = SIZES.map((n, i) => (i % 3 === 0 ? 0 : n / 10));
    early.forEach((n, i) => t.set(rec(i, n)));
    const root = layoutTree(t.root, 800, 500, lines, replayTile(splits), frozenPadding(pads, false));
    let area = 0;
    for (const l of root.leaves()) {
      const a = (l.x1 - l.x0) * (l.y1 - l.y0);
      expect(l.x0).toBeGreaterThanOrEqual(0);
      expect(l.y0).toBeGreaterThanOrEqual(0);
      expect(l.x1).toBeLessThanOrEqual(800);
      expect(l.y1).toBeLessThanOrEqual(500);
      if (!lines(l.data)) expect(a).toBeLessThan(1e-9);
      area += a;
    }
    // Leaves don't overlap: their areas add up to no more than the card.
    expect(area).toBeLessThanOrEqual(800 * 500);
  });
});

describe("rename lineage", () => {
  it("follows chains of moves to where the content ends up", () => {
    // 0 -> 1 at step 5, 1 -> 2 at step 8
    const l = new Lineage([5, 8], [1, 2], [0, 1]);
    expect(l.resolve(0, 3)).toBe(2);
    expect(l.resolve(1, 6)).toBe(2);
    expect(l.resolve(2, 9)).toBe(2);
    expect([...l.terminals()]).toEqual([2]);
  });

  it("tells a path's content before and after it was reused", () => {
    // 0 -> 1 at step 5; a new 0 appears, then 0 -> 3 at step 10
    const l = new Lineage([10, 5], [3, 1], [0, 0]);
    expect(l.resolve(0, 3)).toBe(1);
    expect(l.resolve(0, 7)).toBe(3);
    expect(l.resolve(0, 12)).toBe(0);
    expect(l.lastAway(0)).toBe(10);
    expect(l.lastAway(5)).toBe(-1);
  });
});
