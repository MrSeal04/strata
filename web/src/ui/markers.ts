import type { App } from "../app";
import type { Painter } from "../paint/painter";
import { palette } from "../theme";
import { fmt, h } from "./dom";
import { tooltip } from "./tooltip";

/** A compare marker; "ab" when A and B share a pixel (the first move picks: left A, right B). */
export type MarkerHit = "a" | "b" | "ab";

/** How far from a marker's line (px) a pointer still grabs it. */
const GRAB = 6;

/** The marker within grabbing distance of x, given A's and B's x (NaN when not shown). */
export function markerHit(xa: number, xb: number, x: number): MarkerHit | null {
  const da = Number.isNaN(xa) ? Infinity : Math.abs(x - xa);
  const db = Number.isNaN(xb) ? Infinity : Math.abs(x - xb);
  if (Math.min(da, db) > GRAB) return null;
  if (Math.abs(xb - xa) < 3) return "ab";
  return da < db ? "a" : "b";
}

/** A compare marker in the timeline: a lettered 12 px tab from `tabTop`, a line below to `bottom`. */
export function drawMarker(p: Painter, x: number, tabTop: number, bottom: number, label: "A" | "B") {
  const pal = palette();
  p.line(x, tabTop + 10, x, bottom, pal.accent, 1.5);
  // (at the very ends of the scrubber the tab stays whole)
  const tx = Math.max(6, Math.min(p.width - 6, x));
  p.roundRect(tx - 6, tabTop, 12, 12, [2, 2, 2, 2], pal.accent);
  p.text(label, tx, tabTop + 6.5, { color: "#fff", size: 9, weight: 700, align: "center", baseline: "middle" });
}

/** Tooltip naming the marker under the pointer, or the one being dragged. */
export function markerTip(app: App, hit: MarkerHit, cx: number, cy: number, dragging: boolean) {
  const c = app.store.get().compare;
  if (!c) return;
  const at = (st: number) => `#${fmt.int(st + 1)} · ${fmt.date(app.tl.time(st))}`;
  const box = hit === "ab"
    ? h("div", {}, h("div", { class: "h", text: `A ${at(c.a)}` }), h("div", { class: "h", text: `B ${at(c.b)}` }), h("div", { class: "sub", text: "Drag left to move A, right to move B" }))
    : h("div", {}, h("div", { class: "h", text: `${hit.toUpperCase()} ${at(c[hit])}` }), !dragging && h("div", { class: "sub", text: "Drag to move" }));
  tooltip.show(cx, cy, box);
}

/**
 * Drag a compare marker like an editor's in/out point: it follows `stepAt(clientX)`, and
 * `app.compare.move` keeps A before B. The playhead stays where it is.
 */
export function dragMarker(app: App, el: HTMLElement, e: PointerEvent, hit: MarkerHit, stepAt: (clientX: number) => number, done: () => void) {
  el.setPointerCapture(e.pointerId);
  app.compare.hold(true);
  let end: "a" | "b" | null = hit === "ab" ? null : hit;
  const move = (ev: PointerEvent) => {
    if (!end) {
      if (Math.abs(ev.clientX - e.clientX) < 2) return;
      end = ev.clientX < e.clientX ? "a" : "b";
    }
    app.compare.move(end, stepAt(ev.clientX));
    markerTip(app, end, ev.clientX, ev.clientY, true);
  };
  const up = () => {
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", up);
    tooltip.hide();
    app.compare.hold(false);
    done();
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
}
