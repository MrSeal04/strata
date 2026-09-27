import type { Table } from "apache-arrow";
import { boolCol, col, strCol } from "../api/client";

/** Path dictionary from /paths. */
export class Paths {
  readonly path: string[];
  readonly lang: string[];
  readonly category: Float64Array;
  readonly firstStep: Float64Array;
  constructor(t: Table) {
    const ids = col(t, "path_id");
    let n = 0;
    for (let i = 0; i < ids.length; i++) n = Math.max(n, ids[i] + 1);
    this.path = new Array(n).fill("");
    this.lang = new Array(n).fill("");
    this.category = new Float64Array(n);
    this.firstStep = new Float64Array(n);
    const p = strCol(t, "path");
    const l = strCol(t, "lang");
    const c = col(t, "category");
    const f = col(t, "first_step");
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      this.path[id] = p[i];
      this.lang[id] = l[i];
      this.category[id] = c[i];
      this.firstStep[id] = f[i];
    }
  }
}

export interface FileRec {
  pathId: number;
  lines: number;
  bytes: number;
  /** Mean original-author time of the file's lines (unix s). */
  mot: number;
  topAuthor: number;
  topShare: number;
  binary: boolean;
  /** Last step that changed this file (-1 unknown). */
  touched: number;
  lastAdds: number;
  lastDels: number;
}

export class TNode {
  children: Map<string, TNode> | null;
  value = 0;
  files = 0;
  file: FileRec | null = null;
  constructor(
    readonly id: string,
    readonly name: string,
    readonly parent: TNode | null,
    readonly isDir: boolean,
    public order: number,
  ) {
    this.children = isDir ? new Map() : null;
  }
  depth(): number {
    let d = 0;
    for (let p = this.parent; p; p = p.parent) d++;
    return d;
  }
}

/** Live file set at `step`, as a directory tree with line totals. */
export class FileTree {
  root = new TNode("", "", null, true, 0);
  readonly files = new Map<number, FileRec>();
  private leaves = new Map<number, TNode>();
  step = -1;
  /** Bumped when files appear/disappear (layouts must be recomputed). */
  structureRev = 0;
  /** Bumped on any change. */
  rev = 0;
  /** Path ids changed by the most recent applyEvents call (for actors / beams). */
  lastTouched: number[] = [];
  /** Step of the most recent applied event. */
  lastTouchedStep = -1;

  constructor(readonly paths: Paths) {}

  clear() {
    this.root = new TNode("", "", null, true, 0);
    this.files.clear();
    this.leaves.clear();
    this.step = -1;
    this.structureRev++;
    this.rev++;
  }

  private ensureLeaf(pathId: number): TNode {
    let leaf = this.leaves.get(pathId);
    if (leaf) return leaf;
    const path = this.paths.path[pathId] ?? `#${pathId}`;
    const parts = path.split("/");
    let node = this.root;
    let acc = "";
    const order = this.paths.firstStep[pathId] ?? 0;
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      let next = node.children!.get(parts[i]);
      if (!next) {
        next = new TNode(acc, parts[i], node, true, order);
        node.children!.set(parts[i], next);
      }
      node = next;
    }
    const name = parts[parts.length - 1];
    leaf = new TNode(path, name, node, false, order);
    node.children!.set(name, leaf);
    for (let p: TNode | null = node; p; p = p.parent) p.files++;
    leaf.files = 1;
    this.leaves.set(pathId, leaf);
    this.structureRev++;
    return leaf;
  }

  private addValue(node: TNode, delta: number) {
    for (let p: TNode | null = node; p; p = p.parent) p.value += delta;
  }

  set(rec: FileRec) {
    const leaf = this.ensureLeaf(rec.pathId);
    const before = leaf.file?.lines ?? 0;
    leaf.file = rec;
    this.files.set(rec.pathId, rec);
    if (rec.lines !== before) this.addValue(leaf, rec.lines - before);
    this.rev++;
  }

  remove(pathId: number) {
    const leaf = this.leaves.get(pathId);
    if (!leaf) return;
    this.addValue(leaf, -(leaf.file?.lines ?? 0));
    this.leaves.delete(pathId);
    this.files.delete(pathId);
    let node: TNode | null = leaf.parent;
    node?.children!.delete(leaf.name);
    for (let p = node; p; p = p.parent) p.files--;
    // prune empty directories
    while (node && node.parent && node.children!.size === 0) {
      node.parent.children!.delete(node.name);
      node = node.parent;
    }
    this.structureRev++;
    this.rev++;
  }

  /** Replace everything with a /state snapshot. */
  loadState(t: Table, step: number) {
    this.clear();
    const id = col(t, "path_id");
    const lines = col(t, "lines");
    const bytes = col(t, "bytes");
    const mot = col(t, "mot");
    const top = col(t, "top_author", -1);
    const share = col(t, "top_share");
    const bin = boolCol(t, "binary");
    const touched = col(t, "touched", -1);
    for (let i = 0; i < id.length; i++) {
      this.set({
        pathId: id[i], lines: lines[i], bytes: bytes[i], mot: mot[i], topAuthor: top[i], topShare: share[i],
        binary: bin[i] === 1, touched: touched[i], lastAdds: 0, lastDels: 0,
      });
    }
    this.step = step;
  }

  /** Apply decoded /events rows [from, to) whose step <= `upto`; returns the next row index. */
  applyEvents(ev: DecodedEvents, from: number, upto: number): number {
    let i = from;
    for (; i < ev.n && ev.step[i] <= upto; i++) {
      const k = ev.kind[i];
      const pid = ev.pathId[i];
      if (ev.step[i] !== this.lastTouchedStep) {
        this.lastTouched = [];
        this.lastTouchedStep = ev.step[i];
      }
      if (k !== 4) this.lastTouched.push(pid);
      if (k === 2 || k === 4) {
        this.remove(pid);
      } else {
        this.set({
          pathId: pid, lines: ev.lines[i], bytes: ev.bytes[i], mot: ev.mot[i], topAuthor: ev.top[i],
          topShare: ev.share[i], binary: ev.binary[i] === 1, touched: ev.step[i],
          lastAdds: ev.adds[i], lastDels: ev.dels[i],
        });
      }
    }
    return i;
  }

  /** Node for a directory path ("" = root), or null if it has no live files. */
  find(dir: string): TNode | null {
    if (!dir) return this.root;
    let node: TNode | undefined = this.root;
    for (const part of dir.split("/")) {
      node = node?.children?.get(part);
      if (!node) return null;
    }
    return node ?? null;
  }
}

export interface DecodedEvents {
  n: number;
  step: Float64Array;
  pathId: Float64Array;
  kind: Float64Array;
  adds: Float64Array;
  dels: Float64Array;
  lines: Float64Array;
  bytes: Float64Array;
  mot: Float64Array;
  top: Float64Array;
  share: Float64Array;
  binary: Uint8Array;
  oldPath: Float64Array;
}

export function decodeEvents(t: Table): DecodedEvents {
  return {
    n: t.numRows,
    step: col(t, "step"),
    pathId: col(t, "path_id"),
    kind: col(t, "kind"),
    adds: col(t, "adds"),
    dels: col(t, "dels"),
    lines: col(t, "lines"),
    bytes: col(t, "bytes"),
    mot: col(t, "mot"),
    top: col(t, "top_author", -1),
    share: col(t, "top_share"),
    binary: boolCol(t, "binary"),
    oldPath: col(t, "old_path_id", -1),
  };
}

/** Sort children stably: first appearance, then name (never by size, so layouts don't shuffle). */
export function stableChildren(n: TNode): TNode[] {
  if (!n.children) return [];
  return [...n.children.values()].sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
