import { scaleUtc, ticks } from "d3";
import type { App } from "../app";
import type { Painter } from "../paint/painter";
import { palette } from "../theme";
import { fmt } from "../ui/dom";
import { type MarkerHit, dragMarker, drawMarker, markerHit, markerTip } from "../ui/markers";

export interface Margins {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Shared x-axis machinery for the bars and area views: domain from brush/axis mode, the
 * px<->step mapping, axis ticks, tags, cursor, brush/seek interaction and the compare markers.
 */
export class TimeStrip {
  lo = 0;
  hi = 1;
  plotW = 1;
  drag: { x0: number; x1: number; moved: boolean } | null = null;
  /** A compare marker is being dragged. */
  private markerDrag = false;

  constructor(
    private app: App,
    readonly m: Margins,
  ) {}

  /** Recompute the visible domain; returns the [first, last] step range shown. */
  update(width: number): [number, number] {
    const s = this.app.store.get();
    const [a, b] = s.brush ?? [0, Math.max(0, s.steps - 1)];
    [this.lo, this.hi] = this.app.tl.domain(s.settings.axis, a, b);
    this.plotW = Math.max(1, width - this.m.left - this.m.right);
    return [a, b];
  }

  /** A brush or a compare marker is being dragged (views skip their hover). */
  get dragging(): boolean {
    return !!this.drag || this.markerDrag;
  }

  get axis() {
    return this.app.store.get().settings.axis;
  }

  /** Axis units -> px. */
  px(x: number): number {
    return this.m.left + ((x - this.lo) / (this.hi - this.lo)) * this.plotW;
  }

  /** px -> axis units. */
  ux(px: number): number {
    return this.lo + ((px - this.m.left) / this.plotW) * (this.hi - this.lo);
  }

  stepAtPx(px: number): number {
    const s = this.app.store.get();
    const [a, b] = s.brush ?? [0, s.steps - 1];
    return Math.max(a, Math.min(b, this.app.tl.stepAt(this.ux(px), this.axis)));
  }

  /** Center x (px) of a step. */
  stepPx(step: number): number {
    const tl = this.app.tl;
    if (this.axis === "index") return this.px(step + 0.5);
    return this.px(tl.x(step, "time"));
  }

  drawXAxis(p: Painter, height: number) {
    const pal = palette();
    const y = height - this.m.bottom;
    p.line(this.m.left, y + 0.5, this.m.left + this.plotW, y + 0.5, pal.axis, 1);
    const n = Math.max(2, Math.floor(this.plotW / 110));
    if (this.axis === "time") {
      const sc = scaleUtc().domain([new Date(this.lo * 1000), new Date(this.hi * 1000)]).range([this.m.left, this.m.left + this.plotW]);
      const tf = sc.tickFormat(n);
      for (const t of sc.ticks(n)) {
        const x = sc(t);
        p.line(x, y, x, y + 4, pal.axis, 1);
        p.text(tf(t), x, y + 6, { color: pal.inkMuted, size: 10, align: "center", baseline: "top" });
      }
    } else {
      for (const t of ticks(this.lo, this.hi, n)) {
        if (!Number.isInteger(t)) continue;
        const x = this.px(t + 0.5);
        p.line(x, y, x, y + 4, pal.axis, 1);
        p.text(`#${fmt.int(t + 1)}`, x, y + 6, { color: pal.inkMuted, size: 10, align: "center", baseline: "top" });
      }
    }
  }

  drawTags(p: Painter, top: number) {
    const pal = palette();
    const s = this.app.store.get();
    const [a, b] = s.brush ?? [0, s.steps - 1];
    let lastLabelEnd = -Infinity;
    let lastTick = -Infinity;
    let tags = this.app.summary.tags.filter((t) => t.step >= a && t.step <= b);
    // Many tags: show final releases only (no -rc / alpha / beta / pre / dev).
    if (tags.length > this.plotW / 12) tags = tags.filter((t) => !/(rc|alpha|beta|pre|dev|test)[-.\d]*$/i.test(t.name));
    for (const t of tags) {
      const x = this.stepPx(t.step);
      if (x - lastTick >= 3) {
        p.line(x, top, x, top + 5, pal.inkMuted, 1);
        lastTick = x;
      }
      const w = p.measure(t.name, 9);
      if (x - w / 2 > lastLabelEnd + 6 && x + w / 2 < this.m.left + this.plotW) {
        p.text(t.name, x, top - 1, { color: pal.inkMuted, size: 9, align: "center", baseline: "bottom" });
        lastLabelEnd = x + w / 2;
      }
    }
  }

  drawCursor(p: Painter, top: number, bottom: number) {
    const pal = palette();
    const s = this.app.store.get();
    const x = this.stepPx(s.cursor);
    if (x < this.m.left - 1 || x > this.m.left + this.plotW + 1) return;
    p.line(x, top, x, bottom, pal.ink, 1, 0.85);
  }

  drawSelection(p: Painter, top: number, bottom: number) {
    const pal = palette();
    if (this.drag?.moved) {
      const x0 = Math.min(this.drag.x0, this.drag.x1);
      const x1 = Math.max(this.drag.x0, this.drag.x1);
      p.rect(x0, top, x1 - x0, bottom - top, pal.accent, 0.12);
      p.line(x0, top, x0, bottom, pal.accent, 1);
      p.line(x1, top, x1, bottom, pal.accent, 1);
    }
    const cmp = this.app.store.get().compare;
    if (cmp) {
      for (const [st, label] of [[cmp.a, "A"], [cmp.b, "B"]] as const) {
        const x = this.stepPx(st);
        // (the tab sits in the margin above the plot, like a ruler's flag)
        if (x >= this.m.left && x <= this.m.left + this.plotW) drawMarker(p, x, top - 14, bottom, label);
      }
    }
  }

  /** The compare marker under x, if one is shown there. */
  markerAt(x: number): MarkerHit | null {
    const cmp = this.app.store.get().compare;
    if (!cmp) return null;
    const shown = (st: number) => {
      const px = this.stepPx(st);
      return px >= this.m.left && px <= this.m.left + this.plotW ? px : NaN;
    };
    return markerHit(shown(cmp.a), shown(cmp.b), x);
  }

  /** Hover: over a compare marker, show the grab cursor and its tooltip and return true. */
  hoverMarker(x: number, e: PointerEvent, canvas: HTMLCanvasElement): boolean {
    const hit = this.markerAt(x);
    canvas.style.cursor = hit ? "ew-resize" : "";
    if (hit) markerTip(this.app, hit, e.clientX, e.clientY, false);
    return !!hit;
  }

  drawSearch(p: Painter, y: number) {
    const s = this.app.store.get();
    if (!s.search?.steps.length) return;
    const pal = palette();
    const [a, b] = s.brush ?? [0, s.steps - 1];
    let lastX = -2;
    for (const st of s.search.steps) {
      if (st < a || st > b) continue;
      const x = Math.round(this.stepPx(st));
      if (x - lastX < 2) continue;
      p.rect(x - 1, y, 2, 4, pal.accent);
      lastX = x;
    }
  }

  /** Start a drag (a compare marker, or a brush) or click (seek). Returns false if the point is outside the plot. */
  pointerDown(x: number, e: PointerEvent, canvas: HTMLCanvasElement, redraw: () => void): boolean {
    const hit = this.markerAt(x);
    if (hit) {
      this.markerDrag = true;
      const stepAt = (clientX: number) => this.stepAtPx(clientX - canvas.getBoundingClientRect().left);
      dragMarker(this.app, canvas, e, hit, stepAt, () => {
        this.markerDrag = false;
        redraw();
      });
      return true;
    }
    if (x < this.m.left || x > this.m.left + this.plotW) return false;
    this.drag = { x0: x, x1: x, moved: false };
    canvas.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const nx = Math.max(this.m.left, Math.min(this.m.left + this.plotW, ev.clientX - r.left));
      if (this.drag) {
        this.drag.x1 = nx;
        this.drag.moved ||= Math.abs(nx - this.drag.x0) > 4;
      }
      redraw();
    };
    const up = () => {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      if (d.moved) {
        const a = this.stepAtPx(Math.min(d.x0, d.x1));
        const b = this.stepAtPx(Math.max(d.x0, d.x1));
        if (b > a) {
          this.app.store.set({ brush: [a, b] });
          const cur = this.app.store.get().cursor;
          if (cur < a || cur > b) this.app.player.seek(a);
        }
      } else {
        this.app.player.seek(this.stepAtPx(d.x0));
      }
      redraw();
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    return true;
  }
}
