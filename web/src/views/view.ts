import { clock } from "../clock";
import { CanvasPainter } from "../paint/canvas";
import type { Painter } from "../paint/painter";
import { palette, paletteVersion } from "../theme";
import { h } from "../ui/dom";
import { tooltip } from "../ui/tooltip";

/** A dashboard card with a DPR-aware canvas, redraw scheduling and pointer plumbing. */
export abstract class View {
  readonly el: HTMLElement;
  readonly head: HTMLElement;
  readonly body: HTMLElement;
  readonly legend: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  width = 0;
  height = 0;
  private raf = 0;
  private ro: ResizeObserver;
  protected pointer: { x: number; y: number; cx: number; cy: number } | null = null;

  constructor(area: string, title: string) {
    this.canvas = h("canvas");
    this.head = h("div", { class: "card-head" }, h("h2", { text: title }), h("span", { class: "spacer" }));
    this.body = h("div", { class: "card-body" }, this.canvas);
    this.legend = h("div", { class: "legend" });
    this.el = h("section", { class: "card", "aria-label": title }, this.head, this.body, this.legend);
    this.el.style.gridArea = area;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.body);
    this.canvas.addEventListener("pointermove", (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.pointer = { x: e.clientX - r.left, y: e.clientY - r.top, cx: e.clientX, cy: e.clientY };
      this.onPointerMove(this.pointer.x, this.pointer.y, e);
    });
    this.canvas.addEventListener("pointerleave", () => {
      this.pointer = null;
      tooltip.hide();
      this.onPointerLeave();
    });
    this.canvas.addEventListener("pointerdown", (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.onPointerDown(e.clientX - r.left, e.clientY - r.top, e);
    });
    this.canvas.addEventListener("dblclick", (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.onDoubleClick(e.clientX - r.left, e.clientY - r.top);
    });
  }

  /** Add a control to the card header (right side). */
  addControl(el: HTMLElement) {
    this.head.append(el);
  }

  setLoading(on: boolean) {
    this.el.classList.toggle("loading", on);
  }

  private resize() {
    const r = this.body.getBoundingClientRect();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.floor(r.width));
    const hgt = Math.max(1, Math.floor(r.height));
    if (w === this.width && hgt === this.height && this.canvas.width === Math.round(w * dpr)) return;
    this.width = w;
    this.height = hgt;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(hgt * dpr);
    this.onResize();
    this.invalidate();
  }

  invalidate() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.drawNow();
    });
  }

  /** True while painting the on-screen canvas (false for exports). */
  protected onScreen = false;

  drawNow() {
    // During video export frames are painted by the exporter (with virtual time); the screen waits.
    if (this.width <= 1 || this.height <= 1 || clock.exporting) return;
    const dpr = this.canvas.width / this.width;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const p = new CanvasPainter(ctx, this.width, this.height, dpr);
    const key = this.staticKey();
    this.onScreen = true;
    try {
      if (key === null) {
        if (this.transparentBackground()) ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        else p.clear(palette().surface);
        this.draw(p);
      } else {
        // Split view: the static layer is re-rendered only when its inputs change; each frame
        // just blits it and paints the overlay (cursor, hover, selection).
        const full = `${key}|${this.canvas.width}x${this.canvas.height}|${paletteVersion()}`;
        if (this.layer?.key !== full) {
          const off = new OffscreenCanvas(this.canvas.width, this.canvas.height);
          const lp = new CanvasPainter(off.getContext("2d")!, this.width, this.height, dpr);
          lp.clear(palette().surface);
          this.drawStatic(lp);
          this.layer = { key: full, canvas: off };
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(this.layer.canvas, 0, 0);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.drawOverlay(p);
      }
    } finally {
      this.onScreen = false;
    }
    if (this.animating()) this.invalidate();
  }

  private layer: { key: string; canvas: OffscreenCanvas } | null = null;

  /** Views split into a cached static layer and a cheap overlay return a key for the static
   *  layer's inputs here (null = no split: `draw` paints everything every frame). */
  protected staticKey(): string | null {
    return null;
  }

  protected drawStatic(_p: Painter) {}

  protected drawOverlay(_p: Painter) {}

  /** A view that paints part of itself on a layer underneath keeps its 2D canvas transparent. */
  protected transparentBackground(): boolean {
    return false;
  }

  /** Render into an arbitrary painter (export). */
  renderTo(p: Painter) {
    this.draw(p);
  }

  abstract draw(p: Painter): void;
  /** Return true to keep redrawing every frame (tweens in progress). */
  protected animating(): boolean {
    return false;
  }
  protected onResize() {}
  protected onPointerMove(_x: number, _y: number, _e: PointerEvent) {}
  protected onPointerLeave() {}
  protected onPointerDown(_x: number, _y: number, _e: PointerEvent) {}
  protected onDoubleClick(_x: number, _y: number) {}

  destroy() {
    this.ro.disconnect();
    cancelAnimationFrame(this.raf);
  }
}
