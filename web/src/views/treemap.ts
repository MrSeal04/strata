import { type HierarchyRectangularNode, hierarchy, treemap, treemapBinary } from "d3";
import { api, col, filterParams } from "../api/client";
import type { App } from "../app";
import { colorMaps, diverging, inkOn, mix, sequential } from "../model/colors";
import { type TNode, stableChildren } from "../model/filetree";
import type { Painter } from "../paint/painter";
import type { ColorBy } from "../state/store";
import { palette } from "../theme";
import { fmt, h } from "../ui/dom";
import { tipRow, tooltip } from "../ui/tooltip";
import { renderColorLegend } from "./colorlegend";
import { View } from "./view";

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

type LNode = HierarchyRectangularNode<TNode>;

/** Shared per-file coloring for the treemap and the tree. */
export function fileColor(app: App, node: TNode, mode: ColorBy, now: number): string {
  const pal = palette();
  const f = node.file;
  if (!f) return pal.dir;
  switch (mode) {
    case "lang":
      return colorMaps.lang.color(app.paths.lang[f.pathId] || "Other");
    case "author":
      return f.topAuthor < 0 ? pal.other : colorMaps.author.color(app.authorName(f.topAuthor));
    case "age": {
      const t0 = app.tl.time(0);
      const t1 = app.tl.time(app.store.get().cursor);
      return f.mot > 0 ? sequential((f.mot - t0) / Math.max(1, t1 - t0)) : pal.other;
    }
    case "heat": {
      const k = heat(app, f.touched, now);
      if (k <= 0.01) return pal.surface3;
      const hue = f.lastDels > f.lastAdds ? pal.del : pal.add;
      return mix(pal.surface3, hue, k);
    }
  }
}

/** 1 when a file was just touched, decaying to 0 over `heatSeconds` of playback. */
export function heat(app: App, touched: number, pos: number): number {
  if (touched < 0) return 0;
  const age = pos - touched;
  if (age < -0.5) return 0;
  const steps = Math.max(0.5, app.store.get().settings.heatSeconds * app.stepsPerSecond());
  return Math.exp(-Math.max(0, age) / steps);
}

export class TreemapView extends View {
  private root: LNode | null = null;
  private nodes: LNode[] = [];
  private shown = new Map<string, Rect>();
  private layoutRev = -1;
  private layoutAt = 0;
  private layoutW = 0;
  private layoutH = 0;
  private hover: LNode | null = null;
  private moving = false;
  private lastFrame = 0;
  private compareData: { key: string; a: Map<number, number>; b: Map<number, number> } | null = null;

  constructor(private app: App) {
    super("treemap", "Files by size");
    app.store.watch((s) => [s.cursor, s.settings.colorBy, s.search?.paths.size, s.settings.theme, s.settings.diffColors], () => this.invalidate());
    app.store.watch((s) => [s.settings.colorBy, s.compare, s.langs, s.settings.theme, s.settings.diffColors, s.settings.colorBy === "age" ? s.cursor : 0], () => renderColorLegend(app, this.legend), true);
    app.store.watch((s) => [s.root, s.compare, s.filterRev], () => {
      this.layoutRev = -1;
      this.loadCompare();
      this.updateTitle();
      this.invalidate();
    });
    this.updateTitle();
  }

  private updateTitle() {
    const s = this.app.store.get();
    const t = this.head.querySelector("h2")!;
    t.textContent = s.compare
      ? `Files: #${fmt.int(s.compare.a + 1)} → #${fmt.int(s.compare.b + 1)} (size = B, color = growth)`
      : `Files by size${s.root ? ` · ${s.root}/` : ""}`;
  }

  private loadCompare() {
    const s = this.app.store.get();
    if (!s.compare) {
      this.compareData = null;
      return;
    }
    const p = filterParams(s);
    p.set("a", String(s.compare.a));
    p.set("b", String(s.compare.b));
    const key = p.toString();
    if (this.compareData?.key === key) return;
    api.compare(this.app.repo, p).then((t) => {
      const id = col(t, "path_id");
      const la = col(t, "lines_a");
      const lb = col(t, "lines_b");
      const a = new Map<number, number>();
      const b = new Map<number, number>();
      for (let i = 0; i < id.length; i++) {
        a.set(id[i], la[i]);
        b.set(id[i], lb[i]);
      }
      this.compareData = { key, a, b };
      this.invalidate();
    }).catch(console.error);
  }

  private relayout() {
    const s = this.app.store.get();
    const tree = this.app.tree;
    const display = tree.find(s.root) ?? tree.root;
    const cmp = this.compareData;
    const value = (n: TNode) => {
      const f = n.file;
      if (!f || f.binary) return 0;
      return cmp ? (cmp.b.get(f.pathId) ?? f.lines) : f.lines;
    };
    const root = hierarchy<TNode>(display, (n) => (n.children ? stableChildren(n) : null)).sum(value);
    const W = this.width;
    const H = this.height;
    treemap<TNode>()
      .tile(treemapBinary)
      .size([W, H])
      .paddingOuter(2)
      .paddingInner(1)
      .paddingTop((n) => (n.depth > 0 && n.data.isDir && n.x1 - n.x0 > 60 && n.y1 - n.y0 > 36 ? 15 : n.depth === 0 ? 2 : 1))(root);
    this.root = root as LNode;
    this.nodes = this.root.descendants().filter((n) => n.x1 - n.x0 >= 0.3 && n.y1 - n.y0 >= 0.3 && n.value! > 0);
    this.layoutRev = tree.rev;
    this.layoutAt = performance.now();
    this.layoutW = W;
    this.layoutH = H;
  }

  protected animating() {
    return this.moving;
  }

  draw(p: Painter) {
    const pal = palette();
    const tree = this.app.tree;
    const s = this.app.store.get();
    const now = performance.now();
    const big = this.nodes.length > 20_000;
    const throttle = s.playing ? (big ? 250 : 60) : 0;
    const sizeChanged = this.width !== this.layoutW || this.height !== this.layoutH;
    if (sizeChanged || (tree.rev !== this.layoutRev && now - this.layoutAt >= throttle)) this.relayout();
    else if (tree.rev !== this.layoutRev) this.invalidate();
    if (!this.root || !this.nodes.length) {
      p.text(tree.step < 0 ? "Loading…" : "No files at this point", this.width / 2, this.height / 2, { color: pal.inkMuted, size: 12, align: "center" });
      return;
    }
    // Ease shown rects toward the layout.
    const dt = this.lastFrame ? Math.min(100, now - this.lastFrame) : 16;
    this.lastFrame = now;
    const k = sizeChanged || this.exporting ? 1 : 1 - Math.exp(-dt / 70);
    let moving = false;
    const pos = s.pos;
    const colorBy = s.settings.colorBy;
    const searchPaths = s.search?.kind === "path" && s.search.paths.size ? s.search.paths : null;
    const cmp = this.compareData;
    const seen = new Set<string>();
    for (const n of this.nodes) {
      const id = n.data.id;
      seen.add(id);
      let r = this.shown.get(id);
      if (!r) {
        r = { x0: n.x0, y0: n.y0, x1: n.x1, y1: n.y1 };
        this.shown.set(id, r);
      } else if (k < 1) {
        r.x0 += (n.x0 - r.x0) * k;
        r.y0 += (n.y0 - r.y0) * k;
        r.x1 += (n.x1 - r.x1) * k;
        r.y1 += (n.y1 - r.y1) * k;
        if (Math.abs(r.x0 - n.x0) + Math.abs(r.y0 - n.y0) + Math.abs(r.x1 - n.x1) + Math.abs(r.y1 - n.y1) > 0.6) moving = true;
      } else {
        r.x0 = n.x0; r.y0 = n.y0; r.x1 = n.x1; r.y1 = n.y1;
      }
      const w = r.x1 - r.x0;
      const hh = r.y1 - r.y0;
      if (n.data.isDir) {
        if (n.depth === 0) continue;
        p.rect(r.x0, r.y0, w, hh, pal.dir);
        if (n.y0 + 15 <= n.children?.[0]?.y0! + 0.5 && w > 60) {
          p.text(n.data.name, r.x0 + 4, r.y0 + 7.5, { color: pal.ink2, size: 10, weight: 600, baseline: "middle", maxWidth: w - 8 });
        }
        continue;
      }
      const f = n.data.file!;
      let fill: string;
      let alpha = 1;
      if (cmp) {
        const a = cmp.a.get(f.pathId) ?? 0;
        const b = cmp.b.get(f.pathId) ?? f.lines;
        fill = a === 0 ? pal.add : diverging(Math.log2((b + 1) / (a + 1)) / 3);
      } else {
        fill = fileColor(this.app, n.data, colorBy, pos);
      }
      if (searchPaths && !searchPaths.has(f.pathId)) alpha = 0.2;
      p.rect(r.x0, r.y0, w, hh, fill, alpha);
      // Activity cue in every mode: a brief ring on files touched right now.
      if (colorBy !== "heat" && !cmp) {
        const ht = heat(this.app, f.touched, pos);
        if (ht > 0.15 && w > 2 && hh > 2) {
          p.strokeRect(r.x0 + 0.75, r.y0 + 0.75, w - 1.5, hh - 1.5, f.lastDels > f.lastAdds ? pal.del : pal.add, 1.5, ht);
          moving = moving || s.playing;
        }
      } else if (colorBy === "heat" && heat(this.app, f.touched, pos) > 0.01) {
        moving = moving || s.playing;
      }
      if (w > 46 && hh > 16) {
        p.text(n.data.name, r.x0 + 4, r.y0 + 11, { color: inkOn(fill), size: 10, maxWidth: w - 8 });
      }
    }
    if (this.shown.size > seen.size * 1.5 + 100) {
      for (const id of this.shown.keys()) if (!seen.has(id)) this.shown.delete(id);
    }
    if (this.hover) {
      const r = this.shown.get(this.hover.data.id);
      if (r) p.strokeRect(r.x0 + 0.5, r.y0 + 0.5, r.x1 - r.x0 - 1, r.y1 - r.y0 - 1, pal.ink, 1.5);
    }
    this.moving = moving;
  }

  /** Set during export so every frame is fully settled. */
  exporting = false;

  private hit(x: number, y: number): LNode | null {
    let n = this.root;
    if (!n) return null;
    for (;;) {
      const next: LNode | undefined = n.children?.find((c) => x >= c.x0 && x <= c.x1 && y >= c.y0 && y <= c.y1) as LNode | undefined;
      if (!next) return n.depth === 0 ? null : n;
      n = next;
    }
  }

  protected onPointerMove(x: number, y: number, e: PointerEvent) {
    const n = this.hit(x, y);
    if (n !== this.hover) {
      this.hover = n;
      this.invalidate();
    }
    if (!n) {
      tooltip.hide();
      return;
    }
    tooltip.show(e.clientX, e.clientY, this.describe(n));
  }

  private describe(n: LNode): HTMLElement {
    const pal = palette();
    const box = h("div", {}, h("div", { class: "h", text: n.data.id || "/" }));
    if (n.data.isDir) {
      box.append(tipRow(null, fmt.int(n.value ?? 0), "lines"), tipRow(null, fmt.int(n.data.files), "files"));
      box.append(h("div", { class: "sub", text: "Click to zoom in" }));
      return box;
    }
    const f = n.data.file!;
    const lang = this.app.paths.lang[f.pathId];
    box.append(tipRow(colorMaps.lang.color(lang), fmt.int(f.lines), `lines · ${lang}`));
    const cmp = this.compareData;
    if (cmp) {
      const a = cmp.a.get(f.pathId) ?? 0;
      box.append(tipRow(null, fmt.signed(f.lines - a), `since #${fmt.int(this.app.store.get().compare!.a + 1)} (was ${fmt.int(a)})`));
    }
    if (f.topAuthor >= 0) {
      const name = this.app.authorName(f.topAuthor);
      box.append(tipRow(colorMaps.author.color(name), `${Math.round(f.topShare * 100)}%`, `written by ${name}`));
    }
    if (f.mot > 0) box.append(tipRow(null, fmt.date(f.mot), "average line written"));
    if (f.touched >= 0) {
      const act = f.lastAdds || f.lastDels ? ` (+${fmt.int(f.lastAdds)} −${fmt.int(f.lastDels)})` : "";
      box.append(tipRow(f.lastDels > f.lastAdds ? pal.del : pal.add, `#${fmt.int(f.touched + 1)}`, `last changed${act}`));
    }
    return box;
  }

  protected onPointerLeave() {
    this.hover = null;
    this.invalidate();
  }

  protected onPointerDown(x: number, y: number) {
    const n = this.hit(x, y);
    if (!n) return;
    const dir = n.data.isDir ? n.data : n.data.parent;
    if (dir && dir.id !== this.app.store.get().root) {
      tooltip.hide();
      this.app.store.set({ root: dir.id });
    }
  }

  protected onDoubleClick() {
    const root = this.app.store.get().root;
    if (!root) return;
    const up = root.includes("/") ? root.slice(0, root.lastIndexOf("/")) : "";
    this.app.store.set({ root: up });
  }
}
