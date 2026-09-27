import { FONT, MONO, type Painter, type TextStyle } from "./painter";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const f = (v: number) => (Math.round(v * 100) / 100).toString();

/** Emits SVG markup for the same drawing calls (vector export). */
export class SvgPainter implements Painter {
  private out: string[] = [];
  private clipId = 0;
  private measureCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  private op(alpha: number) {
    return alpha < 1 ? ` fill-opacity="${f(alpha)}"` : "";
  }

  clear(fill: string) {
    this.out.push(`<rect x="0" y="0" width="${f(this.width)}" height="${f(this.height)}" fill="${fill}"/>`);
  }
  rect(x: number, y: number, w: number, h: number, fill: string, alpha = 1) {
    if (w <= 0 || h <= 0) return;
    this.out.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="${fill}"${this.op(alpha)}/>`);
  }
  roundRect(x: number, y: number, w: number, h: number, r: [number, number, number, number], fill: string, alpha = 1) {
    if (w <= 0 || h <= 0) return;
    const m = Math.min(w / 2, h / 2);
    const [tl, tr, br, bl] = r.map((v) => Math.min(v, m));
    const d = `M${f(x + tl)},${f(y)}H${f(x + w - tr)}Q${f(x + w)},${f(y)} ${f(x + w)},${f(y + tr)}V${f(y + h - br)}Q${f(x + w)},${f(y + h)} ${f(x + w - br)},${f(y + h)}H${f(x + bl)}Q${f(x)},${f(y + h)} ${f(x)},${f(y + h - bl)}V${f(y + tl)}Q${f(x)},${f(y)} ${f(x + tl)},${f(y)}Z`;
    this.out.push(`<path d="${d}" fill="${fill}"${this.op(alpha)}/>`);
  }
  strokeRect(x: number, y: number, w: number, h: number, stroke: string, width: number, alpha = 1) {
    this.out.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="none" stroke="${stroke}" stroke-width="${f(width)}" stroke-opacity="${f(alpha)}"/>`);
  }
  line(x1: number, y1: number, x2: number, y2: number, stroke: string, width: number, alpha = 1) {
    this.out.push(`<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${stroke}" stroke-width="${f(width)}" stroke-opacity="${f(alpha)}" stroke-linecap="round"/>`);
  }
  segments(c: ArrayLike<number>, stroke: string, width: number, alpha = 1) {
    let d = "";
    for (let i = 0; i + 3 < c.length; i += 4) d += `M${f(c[i])},${f(c[i + 1])}L${f(c[i + 2])},${f(c[i + 3])}`;
    if (d) this.out.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${f(width)}" stroke-opacity="${f(alpha)}" stroke-linecap="round"/>`);
  }
  polyline(xy: ArrayLike<number>, stroke: string, width: number, alpha = 1) {
    let pts = "";
    for (let i = 0; i + 1 < xy.length; i += 2) pts += `${f(xy[i])},${f(xy[i + 1])} `;
    this.out.push(`<polyline points="${pts.trim()}" fill="none" stroke="${stroke}" stroke-width="${f(width)}" stroke-opacity="${f(alpha)}" stroke-linejoin="round" stroke-linecap="round"/>`);
  }
  band(xs: ArrayLike<number>, top: ArrayLike<number>, bottom: ArrayLike<number>, fill: string, alpha = 1) {
    const n = xs.length;
    if (n < 2) return;
    let d = `M${f(xs[0])},${f(top[0])}`;
    for (let i = 1; i < n; i++) d += `L${f(xs[i])},${f(top[i])}`;
    for (let i = n - 1; i >= 0; i--) d += `L${f(xs[i])},${f(bottom[i])}`;
    this.out.push(`<path d="${d}Z" fill="${fill}"${this.op(alpha)}/>`);
  }
  circle(x: number, y: number, r: number, fill: string, alpha = 1, ring?: string, ringWidth = 2) {
    const s = ring ? ` stroke="${ring}" stroke-width="${f(ringWidth)}" paint-order="stroke"` : "";
    this.out.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(Math.max(0.3, r))}" fill="${fill}"${this.op(alpha)}${s}/>`);
  }
  arc(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number, fill: string, alpha = 1) {
    const pt = (r: number, a: number) => `${f(cx + r * Math.sin(a))},${f(cy - r * Math.cos(a))}`;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const d = `M${pt(r1, a0)}A${f(r1)},${f(r1)} 0 ${large} 1 ${pt(r1, a1)}L${pt(r0, a1)}A${f(r0)},${f(r0)} 0 ${large} 0 ${pt(r0, a0)}Z`;
    this.out.push(`<path d="${d}" fill="${fill}"${this.op(alpha)}/>`);
  }
  text(s: string, x: number, y: number, st: TextStyle) {
    let str = s;
    const size = st.size ?? 11;
    if (st.maxWidth !== undefined && this.measure(str, size, st.weight) > st.maxWidth) {
      if (st.maxWidth < 12) return;
      while (str.length > 1 && this.measure(`${str}…`, size, st.weight) > st.maxWidth) str = str.slice(0, -1);
      str = `${str}…`;
    }
    const anchor = st.align === "center" ? "middle" : st.align === "right" ? "end" : "start";
    const base = { top: "hanging", middle: "central", bottom: "text-after-edge", alphabetic: "alphabetic" }[st.baseline ?? "alphabetic"];
    this.out.push(
      `<text x="${f(x)}" y="${f(y)}" fill="${st.color}" font-size="${size}" font-weight="${st.weight ?? 400}" font-family="${esc(st.mono ? MONO : FONT)}" text-anchor="${anchor}" dominant-baseline="${base}">${esc(str)}</text>`,
    );
  }
  measure(s: string, size: number, weight: number | string = 400) {
    if (!this.measureCtx) {
      this.measureCtx = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1).getContext("2d") : document.createElement("canvas").getContext("2d");
    }
    if (!this.measureCtx) return s.length * size * 0.55;
    this.measureCtx.font = `${weight} ${size}px ${FONT}`;
    return this.measureCtx.measureText(s).width;
  }
  /** Open <g> elements per save() level; index 0 is the root level. */
  private opened: number[] = [0];

  save() {
    this.opened.push(0);
  }
  restore() {
    const n = this.opened.length > 1 ? this.opened.pop()! : 0;
    this.out.push("</g>".repeat(n));
  }
  private open(tag: string) {
    this.out.push(tag);
    this.opened[this.opened.length - 1]++;
  }
  clip(x: number, y: number, w: number, h: number) {
    const id = `c${this.clipId++}`;
    this.out.push(`<clipPath id="${id}"><rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}"/></clipPath>`);
    this.open(`<g clip-path="url(#${id})">`);
  }
  translate(x: number, y: number) {
    this.open(`<g transform="translate(${f(x)},${f(y)})">`);
  }

  toString(): string {
    const closes = "</g>".repeat(this.opened.reduce((a, b) => a + b, 0));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${f(this.width)}" height="${f(this.height)}" viewBox="0 0 ${f(this.width)} ${f(this.height)}">${this.out.join("")}${closes}</svg>`;
  }
}
