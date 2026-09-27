import { interpolateLab } from "d3";
import { palette } from "../theme";

/**
 * Stable categorical assignment: the first 8 keys (in rank order) get the 8 fixed slots, in
 * order, and keep them for the session, so filtering never repaints a survivor. Everything
 * else is "other" (neutral).
 */
export class Categorical {
  private slots = new Map<string, number>();

  assign(rankedKeys: Iterable<string>) {
    const used = new Set(this.slots.values());
    for (const k of rankedKeys) {
      if (this.slots.has(k) || k === "(other)") continue;
      if (used.size >= 8) break;
      let slot = 0;
      while (used.has(slot)) slot++;
      this.slots.set(k, slot);
      used.add(slot);
    }
  }

  slot(key: string): number {
    return this.slots.get(key) ?? -1;
  }

  color(key: string): string {
    const s = this.slots.get(key);
    const p = palette();
    return s === undefined ? p.other : p.series[s];
  }

  reset() {
    this.slots.clear();
  }
}

export const colorMaps = {
  lang: new Categorical(),
  author: new Categorical(),
  dir: new Categorical(),
};

/** Sequential single-hue ramp (light -> dark in light mode; recedes to the surface in dark). */
export function sequential(t: number): string {
  const p = palette();
  return interpolateLab(p.seqLo, p.seqHi)(Math.max(0, Math.min(1, t)));
}

/** Diverging: -1 (deletions/shrink, red) .. 0 (neutral gray) .. +1 (additions/growth, blue). */
export function diverging(t: number): string {
  const p = palette();
  const v = Math.max(-1, Math.min(1, t));
  return v >= 0 ? interpolateLab(p.divMid, p.add)(v) : interpolateLab(p.divMid, p.del)(-v);
}

export function mix(a: string, b: string, t: number): string {
  return interpolateLab(a, b)(Math.max(0, Math.min(1, t)));
}

/** Readable ink (white or near-black) on top of a fill. */
export function inkOn(fill: string): string {
  const c = fill.replace("#", "");
  if (c.length < 6) return palette().ink;
  const r = parseInt(c.slice(0, 2), 16) / 255;
  const g = parseInt(c.slice(2, 4), 16) / 255;
  const b = parseInt(c.slice(4, 6), 16) / 255;
  const lin = (u: number) => (u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.4 ? "#0b0b0b" : "#ffffff";
}
