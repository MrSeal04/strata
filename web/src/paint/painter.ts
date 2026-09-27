// Every view draws through this interface so the same frame can go to a canvas (screen, PNG,
// video) or to an SVG string (vector export).

export interface TextStyle {
  color: string;
  size?: number;
  weight?: number | string;
  align?: "left" | "center" | "right";
  baseline?: "top" | "middle" | "bottom" | "alphabetic";
  maxWidth?: number;
  mono?: boolean;
}

export interface Painter {
  readonly width: number;
  readonly height: number;
  clear(fill: string): void;
  rect(x: number, y: number, w: number, h: number, fill: string, alpha?: number): void;
  /** Rect with per-corner radii [tl, tr, br, bl]. */
  roundRect(x: number, y: number, w: number, h: number, r: [number, number, number, number], fill: string, alpha?: number): void;
  strokeRect(x: number, y: number, w: number, h: number, stroke: string, width: number, alpha?: number): void;
  line(x1: number, y1: number, x2: number, y2: number, stroke: string, width: number, alpha?: number): void;
  /** Many independent segments [x1,y1,x2,y2, ...] in one stroke. */
  segments(coords: ArrayLike<number>, stroke: string, width: number, alpha?: number): void;
  polyline(xy: ArrayLike<number>, stroke: string, width: number, alpha?: number): void;
  /** Filled band between an upper and a lower curve sharing xs. */
  band(xs: ArrayLike<number>, top: ArrayLike<number>, bottom: ArrayLike<number>, fill: string, alpha?: number): void;
  circle(x: number, y: number, r: number, fill: string, alpha?: number, ring?: string, ringWidth?: number): void;
  /** Annular sector (angles in radians, 0 = 12 o'clock, clockwise). */
  arc(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number, fill: string, alpha?: number): void;
  text(s: string, x: number, y: number, style: TextStyle): void;
  measure(s: string, size: number, weight?: number | string): number;
  save(): void;
  restore(): void;
  clip(x: number, y: number, w: number, h: number): void;
  translate(x: number, y: number): void;
}

export const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
export const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';
