import { FONT, MONO, type Painter, type TextStyle } from "./painter";

/** Truncated labels, cached by (font, text, width): a large treemap fits the same labels every frame. */
const fitCache = new Map<string, string>();

function fitText(c: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, s: string, maxWidth: number, font: string): string {
  const key = `${font}|${Math.floor(maxWidth)}|${s}`;
  const hit = fitCache.get(key);
  if (hit !== undefined) return hit;
  let out = s;
  if (c.measureText(s).width > maxWidth) {
    // binary search on the prefix length
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (c.measureText(`${s.slice(0, mid)}…`).width <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    out = `${s.slice(0, Math.max(1, lo))}…`;
  }
  if (fitCache.size > 20_000) fitCache.clear();
  fitCache.set(key, out);
  return out;
}

export class CanvasPainter implements Painter {
  readonly ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

  constructor(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    readonly width: number,
    readonly height: number,
    readonly dpr = 1,
  ) {
    this.ctx = ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  clear(fill: string) {
    const c = this.ctx;
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.fillStyle = fill;
    c.fillRect(0, 0, c.canvas.width, c.canvas.height);
    c.restore();
  }

  rect(x: number, y: number, w: number, h: number, fill: string, alpha = 1) {
    if (w <= 0 || h <= 0) return;
    this.ctx.globalAlpha = alpha;
    this.ctx.fillStyle = fill;
    this.ctx.fillRect(x, y, w, h);
    this.ctx.globalAlpha = 1;
  }

  rects(xywh: ArrayLike<number>, fill: string, alpha = 1) {
    // One fillStyle, many fillRect calls: much cheaper to rasterize than one huge path.
    const c = this.ctx;
    c.globalAlpha = alpha;
    c.fillStyle = fill;
    for (let i = 0; i + 3 < xywh.length; i += 4) c.fillRect(xywh[i], xywh[i + 1], xywh[i + 2], xywh[i + 3]);
    c.globalAlpha = 1;
  }

  roundRect(x: number, y: number, w: number, h: number, r: [number, number, number, number], fill: string, alpha = 1) {
    if (w <= 0 || h <= 0) return;
    const c = this.ctx;
    const m = Math.min(w / 2, h / 2);
    c.globalAlpha = alpha;
    c.fillStyle = fill;
    c.beginPath();
    c.roundRect(x, y, w, h, r.map((v) => Math.min(v, m)));
    c.fill();
    c.globalAlpha = 1;
  }

  strokeRect(x: number, y: number, w: number, h: number, stroke: string, width: number, alpha = 1) {
    const c = this.ctx;
    c.globalAlpha = alpha;
    c.strokeStyle = stroke;
    c.lineWidth = width;
    c.strokeRect(x, y, w, h);
    c.globalAlpha = 1;
  }

  line(x1: number, y1: number, x2: number, y2: number, stroke: string, width: number, alpha = 1) {
    const c = this.ctx;
    c.globalAlpha = alpha;
    c.strokeStyle = stroke;
    c.lineWidth = width;
    c.lineCap = "round";
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
    c.stroke();
    c.globalAlpha = 1;
  }

  segments(coords: ArrayLike<number>, stroke: string, width: number, alpha = 1) {
    const c = this.ctx;
    c.globalAlpha = alpha;
    c.strokeStyle = stroke;
    c.lineWidth = width;
    c.lineCap = "round";
    c.beginPath();
    for (let i = 0; i + 3 < coords.length; i += 4) {
      c.moveTo(coords[i], coords[i + 1]);
      c.lineTo(coords[i + 2], coords[i + 3]);
    }
    c.stroke();
    c.globalAlpha = 1;
  }

  polyline(xy: ArrayLike<number>, stroke: string, width: number, alpha = 1) {
    if (xy.length < 4) return;
    const c = this.ctx;
    c.globalAlpha = alpha;
    c.strokeStyle = stroke;
    c.lineWidth = width;
    c.lineJoin = "round";
    c.lineCap = "round";
    c.beginPath();
    c.moveTo(xy[0], xy[1]);
    for (let i = 2; i + 1 < xy.length; i += 2) c.lineTo(xy[i], xy[i + 1]);
    c.stroke();
    c.globalAlpha = 1;
  }

  band(xs: ArrayLike<number>, top: ArrayLike<number>, bottom: ArrayLike<number>, fill: string, alpha = 1) {
    const n = xs.length;
    if (n < 2) return;
    const c = this.ctx;
    c.globalAlpha = alpha;
    c.fillStyle = fill;
    c.beginPath();
    c.moveTo(xs[0], top[0]);
    for (let i = 1; i < n; i++) c.lineTo(xs[i], top[i]);
    for (let i = n - 1; i >= 0; i--) c.lineTo(xs[i], bottom[i]);
    c.closePath();
    c.fill();
    c.globalAlpha = 1;
  }

  circle(x: number, y: number, r: number, fill: string, alpha = 1, ring?: string, ringWidth = 2) {
    const c = this.ctx;
    c.globalAlpha = alpha;
    c.beginPath();
    c.arc(x, y, Math.max(0.3, r), 0, Math.PI * 2);
    if (ring) {
      c.lineWidth = ringWidth * 2;
      c.strokeStyle = ring;
      c.stroke();
    }
    c.fillStyle = fill;
    c.fill();
    c.globalAlpha = 1;
  }

  arc(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number, fill: string, alpha = 1) {
    const c = this.ctx;
    const s = a0 - Math.PI / 2;
    const e = a1 - Math.PI / 2;
    c.globalAlpha = alpha;
    c.fillStyle = fill;
    c.beginPath();
    c.arc(cx, cy, r1, s, e);
    c.arc(cx, cy, Math.max(0, r0), e, s, true);
    c.closePath();
    c.fill();
    c.globalAlpha = 1;
  }

  private font(size: number, weight: number | string = 400, mono = false) {
    return `${weight} ${size}px ${mono ? MONO : FONT}`;
  }

  text(s: string, x: number, y: number, st: TextStyle) {
    const c = this.ctx;
    c.font = this.font(st.size ?? 11, st.weight, st.mono);
    c.fillStyle = st.color;
    c.textAlign = st.align ?? "left";
    c.textBaseline = st.baseline ?? "alphabetic";
    let str = s;
    if (st.maxWidth !== undefined) {
      if (st.maxWidth < 12 && c.measureText(str).width > st.maxWidth) return;
      str = fitText(c, s, st.maxWidth, c.font);
    }
    c.fillText(str, x, y);
  }

  measure(s: string, size: number, weight: number | string = 400) {
    this.ctx.font = this.font(size, weight);
    return this.ctx.measureText(s).width;
  }

  save() {
    this.ctx.save();
  }
  restore() {
    this.ctx.restore();
  }
  clip(x: number, y: number, w: number, h: number) {
    this.ctx.beginPath();
    this.ctx.rect(x, y, w, h);
    this.ctx.clip();
  }
  translate(x: number, y: number) {
    this.ctx.translate(x, y);
  }
}
