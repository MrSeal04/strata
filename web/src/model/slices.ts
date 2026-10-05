// What a file "is" under each way of slicing the repo (directory, language, author, cohort),
// and the one color for it, so the treemap, the tree, the legends and the area chart agree.

import { interpolateYlOrRd } from "d3";
import type { App } from "../app";
import type { ColorBy } from "../state/store";
import { palette } from "../theme";
import { colorMaps, diverging, mix, sequential } from "./colors";
import type { TNode } from "./filetree";

export type CohortUnit = "year" | "quarter" | "month";

/** Months since 1970-01 in UTC: the engine's cohort index (`time.rs` `month_index`). */
export function monthIndex(unixSecs: number): number {
  const d = new Date(unixSecs * 1000);
  return Math.max(0, (d.getUTCFullYear() - 1970) * 12 + d.getUTCMonth());
}

export function bucketOfMonth(month: number, unit: CohortUnit): number {
  return unit === "month" ? month : unit === "quarter" ? Math.floor(month / 3) : Math.floor(month / 12);
}

/** Bucket of an /area cohort label ("2019", "2019-Q3", "2019-07"); NaN for anything else. */
export function bucketOfLabel(label: string, unit: CohortUnit): number {
  const m = /^(\d{4})(?:-Q(\d)|-(\d{2}))?$/.exec(label);
  if (!m) return Number.NaN;
  const y = Number(m[1]) - 1970;
  if (unit === "quarter") return m[2] ? y * 4 + Number(m[2]) - 1 : Number.NaN;
  if (unit === "month") return m[3] ? y * 12 + Number(m[3]) - 1 : Number.NaN;
  return m[2] || m[3] ? Number.NaN : y;
}

/** The label the server gives a bucket (same formats as `bucketOfLabel` reads). */
export function bucketLabel(bucket: number, unit: CohortUnit): string {
  if (unit === "month") return `${1970 + Math.floor(bucket / 12)}-${String((bucket % 12) + 1).padStart(2, "0")}`;
  if (unit === "quarter") return `${1970 + Math.floor(bucket / 4)}-Q${(bucket % 4) + 1}`;
  return String(1970 + bucket);
}

/** The cohort unit in effect: "auto" is months for young histories, quarters up to ~6 years, years beyond. */
export function cohortUnit(app: App): CohortUnit {
  const u = app.store.get().settings.cohortUnit;
  if (u !== "auto") return u;
  const years = (app.tl.time(app.tl.n - 1) - app.tl.time(0)) / (365.25 * 86400);
  return years < 2 ? "month" : years < 6 ? "quarter" : "year";
}

/** First and last cohort buckets of the history. */
export function cohortRange(app: App, unit: CohortUnit): [number, number] {
  return [bucketOfMonth(monthIndex(app.tl.time(0)), unit), bucketOfMonth(monthIndex(app.tl.time(app.tl.n - 1)), unit)];
}

/** Older cohorts light, newer dark (the sequential ramp), placed by time so every view agrees. */
export function cohortColor(bucket: number, first: number, last: number): string {
  if (!Number.isFinite(bucket)) return palette().other;
  return sequential(last <= first ? 0.7 : 0.15 + (0.85 * (bucket - first)) / (last - first));
}

/** Directory key of a path under `root` at `depth` (the /area rule, including "(files)"). */
export function dirKey(path: string, root: string, depth: number): string {
  const rel = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  const parts = rel.split("/");
  if (parts.length > depth) return parts.slice(0, depth).join("/");
  return parts.slice(0, -1).join("/") || "(files)";
}

/** Directory key per path id, rebuilt when the repo (its `Paths`), root or depth changes (a frame
 *  asks per file, so the cache key is rebuilt only when the store's state object changes). */
let dirKeys: { paths: unknown; state: unknown; key: string; keys: (string | undefined)[] } = { paths: null, state: null, key: "", keys: [] };

export function dirKeyOf(app: App, pathId: number): string {
  const s = app.store.get();
  if (dirKeys.state !== s || dirKeys.paths !== app.paths) {
    const key = `${s.root}|${s.settings.areaDepth}`;
    if (dirKeys.key !== key || dirKeys.paths !== app.paths) dirKeys = { paths: app.paths, state: s, key, keys: [] };
    else dirKeys.state = s;
  }
  let k = dirKeys.keys[pathId];
  if (k === undefined) {
    k = dirKey(app.paths.path[pathId] ?? "", s.root, s.settings.areaDepth);
    dirKeys.keys[pathId] = k;
  }
  return k;
}

/** Give the largest directory keys under `node` their color slots (no-op once all are taken). */
export function assignDirColors(app: App, node: TNode) {
  const size = new Map<string, number>();
  const walk = (n: TNode) => {
    if (n.file) {
      if (!n.file.binary) {
        const k = dirKeyOf(app, n.file.pathId);
        size.set(k, (size.get(k) ?? 0) + n.file.lines);
      }
      return;
    }
    n.children?.forEach(walk);
  };
  walk(node);
  colorMaps.dir.assign([...size.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k));
}

/** Language color per path id, rebuilt when the palette changes (a 100k-file frame asks a lot). */
let langCache: { paths: unknown; pal: unknown; version: number; colors: string[] } = { paths: null, pal: null, version: -1, colors: [] };

function langColor(app: App, pathId: number): string {
  const pal = palette();
  // (per repo, and the version changes when a dashboard assigns its languages' slots)
  if (langCache.paths !== app.paths || langCache.pal !== pal || langCache.version !== colorMaps.lang.version) {
    const byLang = new Map<string, string>();
    langCache = {
      paths: app.paths,
      pal,
      version: colorMaps.lang.version,
      colors: app.paths.lang.map((l) => {
        const key = l || "Other";
        let c = byLang.get(key);
        if (c === undefined) {
          c = colorMaps.lang.color(key);
          byLang.set(key, c);
        }
        return c;
      }),
    };
  }
  return langCache.colors[pathId] ?? pal.other;
}

/** Directory color per path id, rebuilt when the key space, slots or palette change. */
let dirCache: { paths: unknown; state: unknown; version: number; key: string; colors: (string | undefined)[] } = { paths: null, state: null, version: -1, key: "", colors: [] };

function dirColor(app: App, pathId: number): string {
  const s = app.store.get();
  if (dirCache.state !== s || dirCache.version !== colorMaps.dir.version || dirCache.paths !== app.paths) {
    const key = `${s.root}|${s.settings.areaDepth}|${colorMaps.dir.version}|${s.settings.theme}|${s.settings.diffColors}`;
    if (dirCache.key !== key || dirCache.paths !== app.paths) dirCache = { paths: app.paths, state: s, version: colorMaps.dir.version, key, colors: [] };
    else {
      dirCache.state = s;
      dirCache.version = colorMaps.dir.version;
    }
  }
  let c = dirCache.colors[pathId];
  if (c === undefined) {
    c = colorMaps.dir.color(dirKeyOf(app, pathId));
    dirCache.colors[pathId] = c;
  }
  return c;
}

/**
 * "Last edited": yellow for just edited, through orange to deep red for untouched a long time,
 * on a log time scale. The scale runs from an hour to the history's age at the cursor (at least
 * a month), so a young repo still spans the ramp. 64 steps keep batches few.
 */
const HEAT_STEPS = 64;
const HEAT_RAMP = Array.from({ length: HEAT_STEPS }, (_, i) => {
  // YlOrRd's palest yellow vanishes against light surfaces; start at a saturated one.
  const c = interpolateYlOrRd(0.24 + (0.71 * i) / (HEAT_STEPS - 1));
  const m = /(\d+),\s*(\d+),\s*(\d+)/.exec(c);
  return m ? `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, "0")).join("")}` : c;
});
const HOUR = 3600;

export function heatSpan(app: App): number {
  const s = app.store.get();
  return Math.max(30 * 86400, app.tl.time(s.cursor) - app.tl.time(0));
}

/** Color for content last edited `ageSecs` before the cursor, on a scale spanning `spanSecs`. */
export function heatColor(ageSecs: number, spanSecs: number): string {
  const u = Math.log(Math.max(HOUR, ageSecs) / HOUR) / Math.log(Math.max(2 * HOUR, spanSecs) / HOUR);
  return HEAT_RAMP[Math.max(0, Math.min(HEAT_STEPS - 1, Math.round(u * (HEAT_STEPS - 1))))];
}

/** Per-file color for a color-by mode (tree and treemap). */
export function fileColor(app: App, node: TNode, mode: ColorBy, now: number): string {
  const pal = palette();
  const f = node.file;
  if (!f) return pal.dir;
  if (app.store.get().compare && app.compare.data) return growthColor(app, f.pathId);
  switch (mode) {
    case "lang":
      return langColor(app, f.pathId);
    case "dir":
      return dirColor(app, f.pathId);
    case "author":
    case "cohort": {
      // The key holding most of the file's lines, once the bands are loaded.
      const comp = app.composition;
      if (comp.ready(mode)) {
        const k = comp.dominant(f.pathId);
        return k === undefined ? pal.other : comp.color(k);
      }
      if (mode === "author") return f.topAuthor < 0 ? pal.other : colorMaps.author.color(app.authorName(f.topAuthor));
      if (f.mot <= 0) return pal.other;
      const unit = cohortUnit(app);
      const [first, last] = cohortRange(app, unit);
      return cohortColor(bucketOfMonth(monthIndex(f.mot), unit), first, last);
    }
    case "edited": {
      if (f.edited < 0) return pal.other;
      const cur = app.store.get().cursor;
      return heatColor(app.tl.time(cur) - app.tl.time(Math.min(cur, f.edited)), heatSpan(app));
    }
    case "heat": {
      const k = heat(app, f.touched, now);
      if (k <= 0.01) return pal.surface3;
      const hue = f.lastDels > f.lastAdds ? pal.del : pal.add;
      return mix(pal.surface3, hue, k);
    }
  }
}

/** Compare mode: born = additions color, died = deletions color, otherwise diverging on log2(B/A). */
export function growthColor(app: App, pathId: number): string {
  const pal = palette();
  const d = app.compare.data!;
  const a = d.linesA.get(pathId) ?? 0;
  const b = d.linesB.get(pathId) ?? 0;
  if (a === 0 && b > 0) return pal.add;
  if (b === 0 && a > 0) return pal.del;
  return diverging(Math.log2((b + 1) / (a + 1)) / 3);
}

/** 1 when a file was just touched, decaying to 0 over `heatSeconds` of playback. */
let heatSteps: { state: unknown; rate: number | null; steps: number } = { state: null, rate: null, steps: 1 };

export function heat(app: App, touched: number, pos: number): number {
  if (touched < 0) return 0;
  const age = pos - touched;
  if (age < -0.5) return 0;
  // The decay length is the same for every file in a frame: it changes only with the store's
  // state (a new object on every change) or the exporter's rate. (Reading the clock per file
  // to throttle it cost more than the computation.)
  const s = app.store.get();
  if (heatSteps.state !== s || heatSteps.rate !== app.exportRate) {
    heatSteps = { state: s, rate: app.exportRate, steps: Math.max(0.5, s.settings.heatSeconds * app.stepsPerSecond()) };
  }
  return Math.exp(-Math.max(0, age) / heatSteps.steps);
}

export const COLOR_BY_LABEL: Record<ColorBy, string> = {
  dir: "directory",
  lang: "language",
  author: "author",
  cohort: "when written",
  edited: "last edited",
  heat: "recent activity",
};
