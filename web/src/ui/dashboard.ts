import { type Author, api, boolCol, col, filterParams, strCol } from "../api/client";
import type { App } from "../app";
import { openExportMenu } from "../export/menu";
import { colorMaps } from "../model/colors";
import { ChurnTree } from "../model/churn";
import { CompareCache } from "../model/compare";
import { Composition } from "../model/composition";
import { FileTree, Paths } from "../model/filetree";
import { StateSync } from "../model/sync";
import { DEFAULT_SETTINGS, Store, initialState, linkShared, loadSettings, saveSettings } from "../state/store";
import { applyTheme, onPaletteChange } from "../theme";
import { Timeline } from "../timeline/axis";
import { Player, runDuration } from "../timeline/playback";
import { AreaView } from "../views/area";
import { BarsView } from "../views/bars";
import { TreeView } from "../views/tree";
import { TreemapView } from "../views/treemap";
import type { View } from "../views/view";
import { h } from "./dom";
import { FilterBar } from "./filterbar";
import { openCommit, openSettings } from "./panels";
import { Transport } from "./transport";

export interface Dashboard {
  app: App;
  views: { treemap: TreemapView; tree: TreeView; area: AreaView; bars: BarsView };
  grid: HTMLElement;
  frame: HTMLElement;
  destroy(): void;
}

export async function openDashboard(root: HTMLElement, repo: string): Promise<Dashboard> {
  const [metaRes, axisT, pathsT, authors] = await Promise.all([api.meta(repo), api.axis(repo), api.paths(repo), api.authors(repo)]);
  const tl = new Timeline(col(axisT, "t"), Uint8Array.from(col(axisT, "flags")), boolCol(axisT, "is_merge"), col(axisT, "author", -1));
  const paths = new Paths(pathsT);
  const tree = new FileTree(paths);
  const steps = tl.n;
  const settings = linkShared({ ...DEFAULT_SETTINGS, ...loadSettings(repo) }, {});
  const store = new Store({ ...initialState(), repo, steps, cursor: steps - 1, pos: steps - 1, settings });
  applyTheme(settings.theme, settings.diffColors);
  const player = new Player(store, () => tl);
  const sync = new StateSync(store, tree);
  const byId = new Map<number, Author>(authors.map((a) => [a.id, a]));

  // Stable colors for this repo: languages ranked by current size.
  colorMaps.lang.reset();
  colorMaps.author.reset();
  colorMaps.dir.reset();
  // "Other" (unrecognized extensions) stays neutral rather than taking a slot.
  colorMaps.lang.assign(metaRes.summary.langs.map((l) => l.lang).filter((l) => l !== "Other"));

  const app: App = {
    repo,
    meta: metaRes.meta,
    store,
    tl,
    paths,
    tree,
    sync,
    player,
    summary: metaRes.summary,
    authors,
    authorName: (id) => byId.get(id)?.name ?? (id >= 0 ? `author ${id}` : "unknown"),
    openCommit: (step) => void openCommit(app, step),
    compare: new CompareCache(store, repo, paths),
    composition: null as unknown as Composition,
    churn: null as unknown as ChurnTree,
    exportRate: null,
    stepsPerSecond: () => {
      if (app.exportRate) return app.exportRate;
      const s = store.get();
      const [a, b] = s.brush ?? [0, Math.max(0, s.steps - 1)];
      return (b - a + 1) / Math.max(0.1, runDuration(s.settings, tl, a, b));
    },
  };
  app.churn = new ChurnTree(app);
  app.composition = new Composition(app);
  sync.addLayer(app.churn);
  sync.addLayer(app.composition);
  // Author color slots go to the authors with the most surviving lines, the ones the area chart
  // and the treemap's bands label (ranked by commits until that answer arrives, or if it fails).
  const byCommits = () => colorMaps.author.assign(authors.filter((a) => !a.is_bot).map((a) => a.name));
  const topP = filterParams(store.get());
  for (const [k, v] of Object.entries({ slice: "author", axis: "index", lo: 0, hi: steps, bins: 1, top: 8 })) topP.set(k, String(v));
  api.keys(repo, topP).then((t) => {
    colorMaps.author.assign(strCol(t, "label"));
    byCommits();
  }).catch(byCommits);

  const views = { treemap: new TreemapView(app), tree: new TreeView(app), area: new AreaView(app), bars: new BarsView(app) };
  const grid = h("main", { class: "dash" }, views.treemap.el, views.tree.el, views.area.el, views.bars.el);
  const transport = new Transport(app);
  const bar = new FilterBar(app, {
    settings: (a) => openSettings(app, a),
    export: (a) => openExportMenu(dash, a),
    theme: () => {
      const cur = store.get().settings.theme;
      const dark = cur === "dark" || (cur === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
      store.setSettings({ theme: dark ? "light" : "dark" });
    },
  });
  const frame = h("div", { class: "frame" }, bar.el, grid, transport.el);
  root.replaceChildren(frame);

  const all: View[] = Object.values(views);
  sync.onChange = () => {
    views.treemap.invalidate();
    views.tree.invalidate();
  };
  sync.onLoading = (on) => {
    views.treemap.setLoading(on);
    views.tree.setLoading(on);
  };
  const unsubs = [
    store.watch((s) => s.filterRev, () => sync.reset()),
    // Bands follow what's shown, the range and the filters (their keys come from /keys).
    store.watch((s) => [s.settings.colorBy, !!s.compare, s.brush, s.settings.axis, s.filterRev, s.settings.cohortUnit, s.settings.hideBots, s.settings.exclude, s.settings.treemapMeasure], () => app.composition.update(), true),
    // The churn view turns on and off, or its window moves, with the measure, compare and brush.
    store.watch((s) => [s.settings.treemapMeasure, !!s.compare, s.brush?.[0]], () => sync.refresh()),
    // Directory keys are relative to the root at a depth: a new root or depth is a new key space.
    store.watch((s) => [s.root, s.settings.areaDepth], () => colorMaps.dir.reset()),
    store.watch((s) => s.cursor, (c) => void sync.goto(c)),
    store.watch((s) => s.settings, (s) => saveSettings(repo, s)),
    store.watch((s) => [s.settings.theme, s.settings.diffColors], () => applyTheme(store.get().settings.theme, store.get().settings.diffColors)),
    onPaletteChange(() => all.forEach((v) => v.invalidate())),
  ];
  void sync.goto(store.get().cursor);

  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
    const s = store.get();
    if (e.key === " ") {
      e.preventDefault();
      player.toggle();
    } else if (e.key === "ArrowRight") {
      player.seek(s.cursor + (e.shiftKey ? 10 : 1));
    } else if (e.key === "ArrowLeft") {
      player.seek(s.cursor - (e.shiftKey ? 10 : 1));
    } else if (e.key === "Home") {
      player.seek(s.brush?.[0] ?? 0);
    } else if (e.key === "End") {
      player.seek(s.brush?.[1] ?? s.steps - 1);
    } else if (e.key === "/") {
      e.preventDefault();
      bar.focusSearch();
    } else if (e.key === "Escape") {
      if (s.compare) store.set({ compare: null });
      else if (s.brush) store.set({ brush: null });
      document.querySelectorAll(".commit-panel").forEach((el) => el.remove());
    }
  };
  document.addEventListener("keydown", onKey);

  const dash: Dashboard = {
    app,
    views,
    grid,
    frame,
    destroy() {
      player.pause();
      unsubs.forEach((u) => u());
      document.removeEventListener("keydown", onKey);
      all.forEach((v) => v.destroy());
    },
  };
  return dash;
}
