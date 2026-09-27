import { CanvasPainter } from "../paint/canvas";
import type { Painter } from "../paint/painter";
import { SvgPainter } from "../paint/svg";
import { palette } from "../theme";
import type { Dashboard } from "../ui/dashboard";
import { fmt } from "../ui/dom";
import type { View } from "../views/view";

export type Target = "dashboard" | "treemap" | "tree" | "area" | "bars";

function viewsFor(d: Dashboard, target: Target): View[] {
  return target === "dashboard" ? [d.views.treemap, d.views.tree, d.views.area, d.views.bars] : [d.views[target]];
}

/** Paint a whole-dashboard (or single-view) frame: header, each card's title, plot and legend. */
export function paintFrame(d: Dashboard, target: Target, p: Painter, header = true) {
  const pal = palette();
  const views = viewsFor(d, target);
  const origin = (target === "dashboard" ? d.grid : views[0].el).getBoundingClientRect();
  const top = header ? 34 : 0;
  p.clear(pal.page);
  if (header) {
    const s = d.app.store.get();
    const t = d.app.tl.time(s.cursor);
    p.text(`${d.app.meta.name}`, 12, 22, { color: pal.ink, size: 15, weight: 600 });
    const w = p.measure(d.app.meta.name, 15, 600);
    p.text(`${fmt.date(t)} · commit ${fmt.int(s.cursor + 1)} of ${fmt.int(s.steps)}${s.root ? ` · ${s.root}/` : ""}`, 24 + w, 22, { color: pal.ink2, size: 12 });
  }
  for (const v of views) {
    const card = v.el.getBoundingClientRect();
    const body = v.body.getBoundingClientRect();
    const x = card.left - origin.left;
    const y = card.top - origin.top + top;
    p.save();
    p.translate(x, y);
    p.roundRect(0, 0, card.width, card.height, [8, 8, 8, 8], pal.surface);
    const title = v.head.querySelector("h2")?.textContent ?? "";
    p.text(title, 10, 19, { color: pal.ink2, size: 12, weight: 600, maxWidth: card.width - 20 });
    p.save();
    p.translate(body.left - card.left, body.top - card.top);
    p.clip(0, 0, v.width, v.height);
    v.renderTo(p);
    p.restore();
    // legend as swatch + text, like the DOM one
    let lx = 10;
    const ly = body.bottom - card.top + 12;
    for (const it of v.legend.querySelectorAll<HTMLElement>(".it")) {
      const sw = it.querySelector<HTMLElement>(".sw");
      const label = it.textContent ?? "";
      const tw = p.measure(label, 11);
      if (lx + tw + 30 > card.width) break;
      if (sw) p.roundRect(lx, ly - 8, 10, 10, [2, 2, 2, 2], getComputedStyle(sw).backgroundColor);
      p.text(label, lx + 15, ly + 1, { color: pal.ink2, size: 11 });
      lx += tw + 30;
    }
    p.restore();
  }
}

export function frameSize(d: Dashboard, target: Target, header = true): { w: number; h: number } {
  const el = target === "dashboard" ? d.grid : d.views[target].el;
  const r = el.getBoundingClientRect();
  return { w: Math.ceil(r.width), h: Math.ceil(r.height) + (header ? 34 : 0) };
}

function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function fileBase(d: Dashboard, target: Target): string {
  return `${d.app.meta.name}-${target}-${d.app.store.get().cursor + 1}`;
}

export async function exportPng(d: Dashboard, target: Target, scale = 2) {
  const { w, h } = frameSize(d, target);
  const canvas = new OffscreenCanvas(Math.round(w * scale), Math.round(h * scale));
  const p = new CanvasPainter(canvas.getContext("2d")!, w, h, scale);
  paintFrame(d, target, p);
  download(await canvas.convertToBlob({ type: "image/png" }), `${fileBase(d, target)}.png`);
}

export function exportSvg(d: Dashboard, target: Target) {
  const { w, h } = frameSize(d, target);
  const p = new SvgPainter(w, h);
  paintFrame(d, target, p);
  download(new Blob([p.toString()], { type: "image/svg+xml" }), `${fileBase(d, target)}.svg`);
}

export { download };
