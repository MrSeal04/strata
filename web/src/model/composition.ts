import type { Table } from "apache-arrow";
import { api, col, filterParams, strCol } from "../api/client";
import type { App } from "../app";
import { palette } from "../theme";
import { colorMaps } from "./colors";
import { cohortColor, cohortRange, cohortUnit } from "./slices";
import type { SyncLayer } from "./sync";

export type BandSlice = "author" | "cohort";

/**
 * Each file's lines broken down by author or by when they were written (the treemap's bands):
 * surviving lines per key at the tree's step. The keys are the ones the area chart labels for
 * the same range and filters (from /keys, best first); every other key is -1, "(other)". Summed
 * over files, a key's lines are that area layer's height at the cursor.
 */
type Key = { key: number; label: string };

export class Composition implements SyncLayer {
  /** Keys the loaded values refer to, best first: raw key (canonical author id or cohort
   *  bucket) and label. */
  keys: Key[] = [];
  /** Band order: key indexes (authors by rank, cohorts oldest first), then -1. */
  order: number[] = [-1];
  /** Bumped on every change (frame caches). */
  rev = 0;
  /** Slice the loaded values are for. */
  private loadedSlice: BandSlice | null = null;
  /** Keys and slice being loaded (they become `keys` with the snapshot that uses them). */
  private next: Key[] = [];
  /** Size (surviving lines) or flow (lines changed after `window`, the churn view). */
  private mode: "size" | "flow" = "size";
  private window = -1;
  private slice: BandSlice | null = null;
  /** Parameters the keys were fetched for ("" = none yet). */
  private keysFor = "";
  private fetching = "";
  /** path id -> [k0, v0, k1, v1, ...] */
  private values = new Map<number, number[]>();
  private listeners = new Set<() => void>();

  constructor(private app: App) {}

  /** New values for new keys were loaded (legends follow). */
  onChange(fn: () => void) {
    this.listeners.add(fn);
  }

  /** The slice shown, if the treemap (which draws the bands) or else the tree needs it. With the
   *  cards unlinked on different slices, the tree colors by each file's own top author or age. */
  private wanted(): BandSlice | null {
    const s = this.app.store.get();
    if (s.compare) return null;
    for (const by of [s.settings.colorBy, s.settings.treeColorBy]) if (by === "author" || by === "cohort") return by;
    return null;
  }

  /** The area query these keys match: slice, unit and the brushed range on the chart's axis. */
  private keyParams(slice: BandSlice): URLSearchParams {
    const s = this.app.store.get();
    const [a, b] = s.brush ?? [0, Math.max(0, s.steps - 1)];
    const [lo, hi] = this.app.tl.domain(s.settings.axis, a, b);
    const p = filterParams(s);
    p.set("slice", slice);
    p.set("unit", cohortUnit(this.app));
    p.set("axis", s.settings.axis);
    p.set("lo", String(lo));
    p.set("hi", String(hi));
    p.set("bins", "1");
    p.set("top", "8");
    p.set("mode", this.measure());
    return p;
  }

  /** The churn view breaks down lines changed instead of surviving lines. */
  private measure(): "size" | "flow" {
    return this.app.store.get().settings.treemapMeasure === "churn" ? "flow" : "size";
  }

  /** Fetch the keys for what's shown now; the sync layer turns on once they're here. */
  update() {
    const slice = this.wanted();
    if (!slice) {
      if (this.slice !== null) {
        this.slice = null;
        this.app.sync.refresh();
      }
      return;
    }
    const p = this.keyParams(slice);
    const mode = this.measure();
    const window = mode === "flow" ? this.app.churn.from() : -1;
    const want = `${slice}|${window}|${p}`;
    if (want === this.keysFor && this.slice === slice) return;
    if (want === this.fetching) return;
    this.fetching = want;
    api.keys(this.app.repo, p).then((t) => {
      if (this.fetching !== want) return;
      this.fetching = "";
      const raw = strCol(t, "key");
      const labels = strCol(t, "label");
      this.next = raw.map((k, i) => ({ key: Number(k), label: labels[i] }));
      this.mode = mode;
      this.window = window;
      if (slice === "author") colorMaps.author.assign(this.next.map((k) => k.label));
      this.slice = slice;
      this.keysFor = want;
      this.app.sync.refresh();
    }).catch((e) => {
      if (this.fetching === want) this.fetching = "";
      console.error(e);
    });
  }

  key(): string {
    if (!this.slice || this.wanted() !== this.slice) return "";
    return this.keysFor;
  }

  private params(extra: Record<string, string | number>): URLSearchParams {
    const p = filterParams(this.app.store.get());
    p.set("slice", this.slice ?? "author");
    p.set("unit", cohortUnit(this.app));
    p.set("keys", this.next.map((k) => k.key).join(","));
    p.set("mode", this.mode);
    for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
    return p;
  }

  snapshot(step: number): Promise<Table> {
    return api.composition(this.app.repo, this.params({ from: this.window, to: step }));
  }

  chunk(from: number, to: number): Promise<Table> {
    // (lines changed only count inside the churn window)
    return api.origins(this.app.repo, this.params({ from: Math.max(from, this.window), to }));
  }

  load(data: unknown) {
    const t = data as Table;
    const id = col(t, "path_id");
    const k = col(t, "k");
    const v = col(t, "v");
    this.values.clear();
    for (let i = 0; i < id.length; i++) this.add(id[i], k[i], v[i]);
    this.keys = this.next;
    this.loadedSlice = this.slice;
    const idx = this.keys.map((_, i) => i);
    if (this.loadedSlice === "cohort") idx.sort((x, y) => this.keys[x].key - this.keys[y].key);
    this.order = [...idx, -1];
    this.rev++;
    this.listeners.forEach((f) => f());
  }

  apply(data: unknown, ptr: number, upto: number): number {
    const t = data as Table;
    const step = col(t, "step");
    const id = col(t, "path_id");
    const k = col(t, "k");
    const v = col(t, "v");
    let i = ptr;
    for (; i < step.length && step[i] <= upto; i++) this.add(id[i], k[i], v[i]);
    if (i !== ptr) this.rev++;
    return i;
  }

  clear() {
    this.values.clear();
    this.loadedSlice = null;
    this.rev++;
  }

  private add(pathId: number, k: number, v: number) {
    let a = this.values.get(pathId);
    if (!a) {
      if (v <= 0) return;
      a = [];
      this.values.set(pathId, a);
    }
    for (let j = 0; j < a.length; j += 2) {
      if (a[j] !== k) continue;
      a[j + 1] += v;
      if (a[j + 1] <= 0) a.splice(j, 2);
      if (!a.length) this.values.delete(pathId);
      return;
    }
    if (v > 0) a.push(k, v);
  }

  /** Whether bands are loaded for `slice` (else views fall back to one color per file). */
  ready(slice: BandSlice): boolean {
    return this.loadedSlice === slice && this.values.size > 0;
  }

  /** [k, v, ...] for a file, or undefined. */
  of(pathId: number): number[] | undefined {
    return this.values.get(pathId);
  }

  /** The key with the most lines in a file. */
  dominant(pathId: number): number | undefined {
    const a = this.values.get(pathId);
    if (!a) return undefined;
    let best = 0;
    for (let j = 2; j < a.length; j += 2) if (a[j + 1] > a[best + 1]) best = j;
    return a[best];
  }

  label(k: number): string {
    return k < 0 ? "(other)" : (this.keys[k]?.label ?? "(other)");
  }

  color(k: number): string {
    if (k < 0 || !this.keys[k]) return palette().other;
    if (this.loadedSlice === "author") return colorMaps.author.color(this.keys[k].label);
    const unit = cohortUnit(this.app);
    const [first, last] = cohortRange(this.app, unit);
    return cohortColor(this.keys[k].key, first, last);
  }
}
