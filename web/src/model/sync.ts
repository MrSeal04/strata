import { api, filterParams } from "../api/client";
import type { Store } from "../state/store";
import { type DecodedEvents, type FileTree, decodeEvents } from "./filetree";

interface Chunk {
  from: number; // exclusive
  to: number; // inclusive
  ev: DecodedEvents | null;
  ptr: number;
  loading: Promise<void> | null;
}

/**
 * Keeps a FileTree at the store's cursor: forward moves apply /events chunks (prefetched while
 * playing), jumps load a /state snapshot.
 */
export class StateSync {
  private chunks: Chunk[] = [];
  private chunkSteps = 256;
  private gen = 0;
  private busy = false;
  private pending: number | null = null;
  onChange: (() => void) | null = null;
  onLoading: ((loading: boolean) => void) | null = null;

  constructor(
    private store: Store,
    private tree: FileTree,
  ) {}

  /** Filters changed: drop everything and reload at the cursor. */
  reset() {
    this.gen++;
    this.chunks = [];
    this.tree.clear();
    void this.goto(this.store.get().cursor);
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

  private async advance(target: number) {
    const s = this.store.get();
    const repo = s.repo;
    if (!repo) return;
    const gen = this.gen;
    const t = this.tree;
    const forward = target > t.step && t.step >= 0;
    const far = target - t.step > Math.max(4 * this.chunkSteps, 2000);
    if (!forward || (far && !s.playing)) {
      this.onLoading?.(true);
      const table = await api.state(repo, this.params({ step: target }));
      if (gen !== this.gen) return;
      t.loadState(table, target);
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
      chunk.ptr = t.applyEvents(ev, chunk.ptr, target);
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
    const chunk: Chunk = { from, to, ev: null, ptr: 0, loading: null };
    const gen = this.gen;
    chunk.loading = api.events(repo, this.params({ from, to })).then((table) => {
      if (gen !== this.gen) return;
      chunk.ev = decodeEvents(table);
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
