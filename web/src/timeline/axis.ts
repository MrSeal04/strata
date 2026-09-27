import type { AxisMode } from "../state/store";

/** Per-step axis data and the step <-> x mapping for both axis modes. */
export class Timeline {
  readonly n: number;
  constructor(
    /** Monotonic committer time per step (unix seconds). */
    readonly times: Float64Array,
    readonly flags: Uint8Array,
    readonly merges: Uint8Array,
    /** Canonical author id per step (-1 unknown). */
    readonly authors: Float64Array,
  ) {
    this.n = times.length;
  }

  /** x-domain [lo, hi) covering steps a..=b. */
  domain(axis: AxisMode, a = 0, b = this.n - 1): [number, number] {
    if (this.n === 0) return [0, 1];
    a = Math.max(0, Math.min(a, this.n - 1));
    b = Math.max(a, Math.min(b, this.n - 1));
    if (axis === "index") return [a, b + 1];
    const lo = this.times[a];
    const hi = this.times[b];
    return [lo, hi + Math.max(1, (hi - lo) * 0.002)];
  }

  /** Left edge of a step in axis units (index: s, time: its time). */
  x(step: number, axis: AxisMode): number {
    if (axis === "index") return step;
    const s = Math.max(0, Math.min(this.n - 1, Math.floor(step)));
    const frac = step - s;
    const t0 = this.times[s];
    const t1 = s + 1 < this.n ? this.times[s + 1] : t0;
    return t0 + (t1 - t0) * frac;
  }

  /** Step at axis position x (last step whose x <= x). */
  stepAt(x: number, axis: AxisMode): number {
    if (this.n === 0) return 0;
    if (axis === "index") return Math.max(0, Math.min(this.n - 1, Math.floor(x)));
    return this.stepAtTime(x);
  }

  stepAtTime(t: number): number {
    let lo = 0;
    let hi = this.n - 1;
    if (t < this.times[0]) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.times[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  time(step: number): number {
    return this.times[Math.max(0, Math.min(this.n - 1, Math.floor(step)))] ?? 0;
  }
}
