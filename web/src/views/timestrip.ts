import { scaleUtc, ticks } from "d3";
import type { App } from "../app";
import type { Painter } from "../paint/painter";
import { palette } from "../theme";
import { fmt } from "../ui/dom";

export interface Margins {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Shared x-axis machinery for the bars and area views: domain from brush/axis mode, the
 * px<->step mapping, axis ticks, tags, cursor, and brush/seek interaction.
 */
export class TimeStrip {
  lo = 0;
  hi = 1;
  plotW = 1;
  drag: { x0: number; x1: number; moved: boolean } | null = null;

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
    for (const t of this.app.summary.tags) {
      if (t.step < a || t.step > b) continue;
      const x = this.stepPx(t.step);
      p.line(x, top, x, top + 5, pal.inkMuted, 1);
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
        if (x < this.m.left || x > this.m.left + this.plotW) continue;
        p.line(x, top, x, bottom, pal.accent, 1.5);
        p.text(label, x + 3, top + 2, { color: pal.accent, size: 10, weight: 600, baseline: "top" });
      }
    }
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

  /** Start a drag (brush) or click (seek). Returns false if the point is outside the plot. */
  pointerDown(x: number, e: PointerEvent, canvas: HTMLCanvasElement, redraw: () => void): boolean {
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
