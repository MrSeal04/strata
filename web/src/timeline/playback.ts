import type { Settings, Store } from "../state/store";
import type { Timeline } from "./axis";

/** Where playback is at wall-clock `elapsed` seconds into a run over steps [a, b]. */
export function positionAt(
  elapsed: number,
  s: Pick<Settings, "playMode" | "fixedSeconds" | "commitsPerSec" | "daysPerSec">,
  tl: Timeline,
  a: number,
  b: number,
): number {
  const span = Math.max(1, b - a + 1);
  switch (s.playMode) {
    case "fixed":
      return a + (elapsed / Math.max(0.1, s.fixedSeconds)) * span;
    case "commits":
      return a + elapsed * Math.max(0.01, s.commitsPerSec);
    case "calendar": {
      const t = tl.time(a) + elapsed * s.daysPerSec * 86_400;
      const st = tl.stepAtTime(t);
      const t0 = tl.time(st);
      const t1 = st + 1 < tl.n ? tl.time(st + 1) : t0 + 1;
      return st + Math.min(0.999, Math.max(0, (t - t0) / Math.max(1e-9, t1 - t0)));
    }
  }
}

/** Seconds a full run over [a, b] takes in the current mode. */
export function runDuration(s: Settings, tl: Timeline, a: number, b: number): number {
  switch (s.playMode) {
    case "fixed":
      return s.fixedSeconds;
    case "commits":
      return (b - a + 1) / Math.max(0.01, s.commitsPerSec);
    case "calendar":
      return (tl.time(b) - tl.time(a)) / 86_400 / Math.max(1e-6, s.daysPerSec) + 0.5;
  }
}

/** requestAnimationFrame-driven playback clock that writes `pos`/`cursor` into the store. */
export class Player {
  private raf = 0;
  private startWall = 0;
  private startElapsed = 0;

  constructor(
    private store: Store,
    private tl: () => Timeline | null,
  ) {}

  private range(): [number, number] {
    const s = this.store.get();
    return s.brush ?? [0, Math.max(0, s.steps - 1)];
  }

  /** Elapsed run time that corresponds to the current position (so resuming continues smoothly). */
  private elapsedFor(pos: number): number {
    const tl = this.tl();
    const s = this.store.get().settings;
    const [a, b] = this.range();
    if (!tl) return 0;
    const dur = runDuration(s, tl, a, b);
    if (s.playMode === "calendar") {
      return (tl.x(pos, "time") - tl.time(a)) / 86_400 / Math.max(1e-6, s.daysPerSec);
    }
    return ((pos - a) / Math.max(1, b - a + 1)) * (s.playMode === "fixed" ? dur : (b - a + 1) / s.commitsPerSec);
  }

  play() {
    const s = this.store.get();
    if (!this.tl() || s.steps === 0) return;
    const [a, b] = this.range();
    let pos = s.pos;
    if (pos >= b || pos < a) pos = a;
    this.startElapsed = this.elapsedFor(pos);
    this.startWall = performance.now();
    this.store.set({ playing: true, pos, cursor: Math.floor(pos) });
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
  }

  pause() {
    cancelAnimationFrame(this.raf);
    if (this.store.get().playing) this.store.set({ playing: false });
  }

  toggle() {
    if (this.store.get().playing) this.pause();
    else this.play();
  }

  /** Jump to a step (pauses nothing; a running clock continues from there). */
  seek(step: number) {
    const s = this.store.get();
    const pos = Math.max(0, Math.min(s.steps - 1, step));
    this.store.set({ pos, cursor: Math.floor(pos) });
    if (s.playing) {
      this.startElapsed = this.elapsedFor(pos);
      this.startWall = performance.now();
    }
  }

  private tick = (now: number) => {
    const tl = this.tl();
    const s = this.store.get();
    if (!tl || !s.playing) return;
    const [a, b] = this.range();
    // rAF timestamps are frame starts and can precede the play() call: never run backwards.
    const elapsed = this.startElapsed + Math.max(0, now - this.startWall) / 1000;
    let pos = Math.max(a, positionAt(elapsed, s.settings, tl, a, b));
    if (pos >= b + 1) {
      if (s.settings.loop) {
        this.startElapsed = 0;
        this.startWall = now;
        pos = a;
      } else {
        this.store.set({ pos: b, cursor: b, playing: false });
        return;
      }
    }
    const cursor = Math.min(b, Math.floor(pos));
    this.store.set({ pos, cursor });
    this.raf = requestAnimationFrame(this.tick);
  };
}
