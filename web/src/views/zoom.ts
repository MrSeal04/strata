import { type D3ZoomEvent, type Selection, type ZoomBehavior, select, zoom, zoomIdentity } from "d3";

/**
 * Wheel/pinch zoom and drag pan for a view canvas (d3-zoom). Screen = world · k + (x, y), where
 * world is the unzoomed card ([0, W] × [0, H]); the content always covers the card.
 *
 * At k = 1 a one-finger drag scrolls the page (phones stack the cards and scroll), so drags pan
 * only once zoomed in, and the canvas takes over touch only then; a pinch always zooms.
 */
export class ZoomPan {
  k = 1;
  x = 0;
  y = 0;
  /** Time of the last change (views re-layout once zooming settles). */
  changedAt = 0;
  onChange: (() => void) | null = null;
  enabled = true;
  private behavior: ZoomBehavior<HTMLCanvasElement, unknown>;
  private sel: Selection<HTMLCanvasElement, unknown, null, undefined>;

  constructor(private canvas: HTMLCanvasElement) {
    this.behavior = zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([1, 64])
      .clickDistance(4)
      .filter((e: Event) => {
        if (!this.enabled) return false;
        if (e.type === "wheel") return true;
        if (e.type === "mousedown") return (e as MouseEvent).button === 0 && this.k > 1;
        if (e.type === "touchstart") return (e as TouchEvent).touches.length >= 2 || this.k > 1;
        return false;
      })
      .on("zoom", (e: D3ZoomEvent<HTMLCanvasElement, unknown>) => {
        const t = e.transform;
        this.k = t.k;
        this.x = t.x;
        this.y = t.y;
        this.changedAt = performance.now();
        this.syncTouch();
        this.onChange?.();
      });
    this.sel = select(canvas);
    this.sel.call(this.behavior).on("dblclick.zoom", null);
    this.syncTouch();
  }

  /** Card size changed: keep the content covering it. */
  resize(w: number, h: number) {
    this.behavior.extent([[0, 0], [w, h]]).translateExtent([[0, 0], [w, h]]);
    if (this.k > 1) this.behavior.translateBy(this.sel, 0, 0);
  }

  get zoomed(): boolean {
    return this.k > 1.001;
  }

  sx(wx: number): number {
    return wx * this.k + this.x;
  }

  sy(wy: number): number {
    return wy * this.k + this.y;
  }

  /** Screen -> world. */
  wx(sx: number): number {
    return (sx - this.x) / this.k;
  }

  wy(sy: number): number {
    return (sy - this.y) / this.k;
  }

  reset() {
    if (this.k === 1 && this.x === 0 && this.y === 0) return;
    this.behavior.transform(this.sel, zoomIdentity);
  }

  /** Zoom to `k` keeping screen point (px, py) fixed (tests, exports, buttons). */
  set(k: number, px: number, py: number) {
    this.behavior.scaleTo(this.sel, k, [px, py]);
  }

  private syncTouch() {
    this.canvas.style.touchAction = this.zoomed ? "none" : "pan-y";
  }
}
