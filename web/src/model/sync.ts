import { api, filterParams } from "../api/client";
import type { Store } from "../state/store";
import { type DecodedEvents, type FileTree, decodeEvents } from "./filetree";

/**
 * Extra per-file data kept at the tree's step (e.g. the treemap's bands): loaded with the tree
 * on a jump and advanced from the same chunks while playing, so the two never disagree.
 */
export interface SyncLayer {
  /** What the layer holds ("" = off). When it changes the layer is reloaded at the tree's step. */
  key(): string;
  /** Everything up to `step` (a jump). */
  snapshot(step: number): Promise<unknown>;
  /** Rows for the steps in (from, to], in step order (playback). */
  chunk(from: number, to: number): Promise<unknown>;
  /** Replace the layer's contents with a snapshot. */
  load(data: unknown, step: number): void;
  /** Apply chunk rows from index `ptr` whose step <= `upto`; returns the next row index. */
  apply(data: unknown, ptr: number, upto: number): number;
  /** Optional: the /events rows [from, to) just applied to the tree (layers built from them). */
  events?(ev: DecodedEvents, from: number, to: number): void;
  clear(): void;
}

interface Extra {
  key: string;
  data: unknown;
  ptr: number;
}

interface Chunk {
  from: number; // exclusive
  to: number; // inclusive
  ev: DecodedEvents | null;
  extras: Map<SyncLayer, Extra>;
  ptr: number;
  loading: Promise<void> | null;
}

/**
 * Keeps a FileTree (and its layers) at the store's cursor: forward moves apply /events chunks
 * (prefetched while playing), jumps load a /state snapshot.
 */
export class StateSync {
  private chunks: Chunk[] = [];
  private chunkSteps = 256;
  private gen = 0;
  private busy = false;
  private pending: number | null = null;
  private layers: SyncLayer[] = [];
  /** Key each layer's contents were loaded for ("" = empty). */
  private loaded = new Map<SyncLayer, string>();
  onChange: (() => void) | null = null;
  onLoading: ((loading: boolean) => void) | null = null;

  constructor(
    private store: Store,
    private tree: FileTree,
  ) {}

  addLayer(layer: SyncLayer) {
    this.layers.push(layer);
    this.loaded.set(layer, "");
  }

  /** A layer's key changed: bring it to the tree's step. */
  refresh() {
    void this.goto(this.pending ?? this.store.get().cursor);
  }

  /** Filters changed: drop everything and reload at the cursor. */
  reset() {
    this.gen++;
    this.chunks = [];
    this.tree.clear();
    for (const l of this.layers) {
      l.clear();
      this.loaded.set(l, "");
    }
    void this.goto(this.store.get().cursor);
  }

  /** Move to `step` and resolve once the tree reflects it. */
  async settle(step: number): Promise<void> {
    for (let tries = 0; tries < 200 && (this.tree.step !== step || this.layersStale()); tries++) {
      await this.goto(step);
      if (this.tree.step !== step || this.layersStale()) await new Promise((r) => setTimeout(r, 15));
    }
  }

  private layersStale(): boolean {
    return this.layers.some((l) => l.key() !== this.loaded.get(l));
  }

  async goto(step: number) {
    this.pending = step;
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.pending !== null) {
        const target = this.pending;
        this.pending = null;
        await this.advance(target);
      }
    } finally {
      this.busy = false;
    }
  }

  private params(extra: Record<string, string | number>): URLSearchParams {
    const p = filterParams(this.store.get());
    for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
    return p;
  }

  private active(): SyncLayer[] {
    return this.layers.filter((l) => l.key() !== "");
  }

  private async advance(target: number) {
    const s = this.store.get();
    const repo = s.repo;
    if (!repo) return;
    const gen = this.gen;
    const t = this.tree;
    // Layers whose key changed since they were loaded start again at the tree's step (in this
    // loop, so no chunk is ever applied to a layer mid-reload).
    if (t.step >= 0) {
      for (const l of this.layers) {
        const key = l.key();
        if (key === this.loaded.get(l)) continue;
        this.chunks = [];
        if (!key) {
          l.clear();
        } else {
          this.onLoading?.(true);
          const data = await l.snapshot(t.step);
          this.onLoading?.(false);
          if (gen !== this.gen) return;
          l.load(data, t.step);
        }
        this.loaded.set(l, key);
        this.onChange?.();
      }
    }
    if (target === t.step) return;
    const forward = target > t.step && t.step >= 0;
    const far = target - t.step > Math.max(4 * this.chunkSteps, 2000);
    if (!forward || (far && !s.playing)) {
      this.onLoading?.(true);
      const layers = this.active().map((l) => [l, l.key()] as const);
      const [table, ...extra] = await Promise.all([api.state(repo, this.params({ step: target })), ...layers.map(([l]) => l.snapshot(target))]);
      if (gen !== this.gen) return;
      t.loadState(table, target);
      layers.forEach(([l, key], i) => {
        l.load(extra[i], target);
        this.loaded.set(l, key);
      });
      this.chunks = [];
      this.onLoading?.(false);
      this.onChange?.();
      return;
    }
    while (t.step < target) {
      const chunk = this.chunkFor(t.step + 1, repo);
      if (!chunk.ev) {
        this.onLoading?.(true);
        await chunk.loading;
        this.onLoading?.(false);
        if (gen !== this.gen) return;
      }
      const ev = chunk.ev!;
      const p0 = chunk.ptr;
      chunk.ptr = t.applyEvents(ev, chunk.ptr, target);
      for (const l of this.layers) {
        const key = this.loaded.get(l);
        if (l.events && key && key === l.key()) l.events(ev, p0, chunk.ptr);
      }
      for (const [l, x] of chunk.extras) {
        if (x.key === this.loaded.get(l)) x.ptr = l.apply(x.data, x.ptr, target);
      }
      t.step = Math.min(target, chunk.to);
      if (t.step >= chunk.to) this.chunks = this.chunks.filter((c) => c !== chunk);
    }
    this.onChange?.();
    // Prefetch the next chunk while playing.
    if (this.store.get().playing) this.chunkFor(t.step + 1, repo);
  }

  private chunkFor(step: number, repo: string): Chunk {
    const have = this.chunks.find((c) => step > c.from && step <= c.to);
    if (have) return have;
    const from = step - 1;
    const to = Math.min(this.store.get().steps - 1, from + this.chunkSteps);
    const chunk: Chunk = { from, to, ev: null, extras: new Map(), ptr: 0, loading: null };
    const gen = this.gen;
    // Layer rows come along only for layers loaded for their current key.
    const layers = this.active().filter((l) => l.key() === this.loaded.get(l));
    chunk.loading = Promise.all([api.events(repo, this.params({ from, to })), ...layers.map((l) => l.chunk(from, to))]).then(([table, ...extra]) => {
      if (gen !== this.gen) return;
      chunk.ev = decodeEvents(table);
      layers.forEach((l, i) => chunk.extras.set(l, { key: this.loaded.get(l) ?? "", data: extra[i], ptr: 0 }));
      // Adapt chunk size to keep responses around 5k-50k rows.
      if (table.numRows > 50_000) this.chunkSteps = Math.max(8, this.chunkSteps >> 1);
      else if (table.numRows < 5_000) this.chunkSteps = Math.min(20_000, this.chunkSteps * 2);
    });
    this.chunks.push(chunk);
    // Keep memory bounded.
    if (this.chunks.length > 4) this.chunks.shift();
    return chunk;
  }
}
