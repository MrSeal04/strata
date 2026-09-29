import { tableFromArrays } from "apache-arrow";
import { describe, expect, it } from "vitest";
import { Categorical } from "../src/model/colors";
import { type DecodedEvents, FileTree, Paths, stableChildren } from "../src/model/filetree";

function paths(list: [number, string, number][]) {
  return new Paths(
    tableFromArrays({
      path_id: Uint32Array.from(list.map((p) => p[0])),
      path: list.map((p) => p[1]),
      lang: list.map(() => "Rust"),
      category: Uint8Array.from(list.map(() => 0)),
      first_step: Uint32Array.from(list.map((p) => p[2])),
      last_step: Uint32Array.from(list.map((p) => p[2])),
    }),
  );
}

const rec = (pathId: number, lines: number) => ({
  pathId, lines, bytes: 0, mot: 0, topAuthor: -1, topShare: 0, binary: false, touched: -1, edited: -1, lastAdds: 0, lastDels: 0,
});

describe("FileTree", () => {
  const P = paths([[0, "src/a.rs", 0], [1, "src/deep/b.rs", 1], [2, "README.md", 2], [3, "src/c.rs", 3]]);

  it("keeps directory totals as files change and prunes empty folders", () => {
    const t = new FileTree(P);
    t.set(rec(0, 10));
    t.set(rec(1, 5));
    t.set(rec(2, 3));
    expect(t.root.value).toBe(18);
    expect(t.find("src")!.value).toBe(15);
    t.set(rec(1, 7));
    expect(t.find("src")!.value).toBe(17);
    t.remove(1);
    expect(t.find("src/deep")).toBeNull();
    expect(t.find("src")!.files).toBe(1);
    expect(t.root.value).toBe(13);
  });

  it("applies event chunks up to a step and records renames", () => {
    const t = new FileTree(P);
    t.set(rec(0, 10));
    const ev: DecodedEvents = {
      n: 3,
      step: Float64Array.from([3, 3, 5]),
      pathId: Float64Array.from([0, 3, 2]),
      kind: Float64Array.from([4, 3, 0]),
      adds: Float64Array.from([0, 1, 4]),
      dels: Float64Array.from([0, 0, 0]),
      lines: Float64Array.from([0, 11, 4]),
      bytes: new Float64Array(3),
      mot: new Float64Array(3),
      top: Float64Array.from([-1, -1, -1]),
      share: new Float64Array(3),
      binary: new Uint8Array(3),
      oldPath: Float64Array.from([-1, 0, -1]),
      edited: Float64Array.from([3, 1, 5]),
    };
    const next = t.applyEvents(ev, 0, 4);
    expect(next).toBe(2);
    expect(t.files.has(0)).toBe(false);
    expect(t.files.get(3)!.lines).toBe(11);
    expect(t.renames.get("src/c.rs")).toBe("src/a.rs");
    // The server's `edited` rides along (a pure move keeps its source's last edit).
    expect(t.files.get(3)!.edited).toBe(1);
    t.applyEvents(ev, next, 5);
    expect(t.root.value).toBe(15);
  });

  it("orders children by first appearance, never by size", () => {
    const t = new FileTree(P);
    t.set(rec(3, 1));
    t.set(rec(0, 1));
    const before = stableChildren(t.find("src")!).map((n) => n.name);
    t.set(rec(3, 1000));
    expect(stableChildren(t.find("src")!).map((n) => n.name)).toEqual(before);
    expect(before).toEqual(["a.rs", "c.rs"]);
  });
});

describe("Categorical colors", () => {
  it("keep their slot when the set of series changes", () => {
    const c = new Categorical();
    c.assign(["a", "b", "c"]);
    const b = c.slot("b");
    c.assign(["b", "d"]);
    expect(c.slot("b")).toBe(b);
    expect(c.slot("d")).toBe(3);
    c.assign(["e", "f", "g", "h", "i", "j"]);
    expect(c.slot("i")).toBe(-1);
  });
});
