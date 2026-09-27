// A tiny observable store: views subscribe to the slices they use.

export type AxisMode = "index" | "time";
export type PlayMode = "fixed" | "commits" | "calendar";
export type BarScale = "linear" | "sqrt" | "log";
export type AreaSlice = "dir" | "lang" | "author" | "cohort";
export type AreaMode = "size" | "flow";
export type TreeLayout = "force" | "radial" | "sunburst" | "icicle";
export type ColorBy = "lang" | "heat" | "age" | "author";

export interface Settings {
  axis: AxisMode;
  playMode: PlayMode;
  fixedSeconds: number;
  commitsPerSec: number;
  daysPerSec: number;
  loop: boolean;
  /** Category codes hidden everywhere (see engine `category`). */
  exclude: number[];
  ws: boolean;
  hideBots: boolean;
  barScale: BarScale;
  /** Clip bars above this percentile (0 = off). */
  clampPct: number;
  areaSlice: AreaSlice;
  areaMode: AreaMode;
  areaDepth: number;
  cohortUnit: "auto" | "year" | "quarter" | "month";
  treeLayout: TreeLayout;
  colorBy: ColorBy;
  actors: boolean;
  gravatar: boolean;
  nodeBudget: number;
  theme: "auto" | "light" | "dark";
  diffColors: "bluered" | "greenred";
  /** Seconds a touched file stays highlighted in heat mode (playback time). */
  heatSeconds: number;
}

export const DEFAULT_SETTINGS: Settings = {
  axis: "index",
  playMode: "fixed",
  fixedSeconds: 60,
  commitsPerSec: 30,
  daysPerSec: 14,
  loop: false,
  exclude: [4, 5, 6, 7],
  ws: false,
  hideBots: false,
  barScale: "sqrt",
  clampPct: 99,
  areaSlice: "dir",
  areaMode: "size",
  areaDepth: 1,
  cohortUnit: "auto",
  treeLayout: "force",
  colorBy: "lang",
  actors: false,
  gravatar: false,
  nodeBudget: 6000,
  theme: "auto",
  diffColors: "bluered",
  heatSeconds: 1.5,
};

export interface Compare {
  a: number;
  b: number;
  mode: "overlay" | "side";
}

export interface SearchState {
  q: string;
  kind: "message" | "author" | "path";
  steps: number[];
  paths: Set<number>;
}

export interface State {
  repo: string | null;
  steps: number;
  /** Current step (integer). */
  cursor: number;
  /** Fractional playback position (cursor = floor). */
  pos: number;
  playing: boolean;
  /** Selected step range [a, b] (inclusive); bars/area zoom to it. */
  brush: [number, number] | null;
  root: string;
  langs: string[];
  authors: number[];
  compare: Compare | null;
  search: SearchState | null;
  settings: Settings;
  /** Monotonic counter bumped when filters change (views refetch). */
  filterRev: number;
}

type Listener = (s: State, prev: State) => void;

export class Store {
  private s: State;
  private listeners = new Set<Listener>();

  constructor(init: State) {
    this.s = init;
  }

  get(): State {
    return this.s;
  }

  set(patch: Partial<State>) {
    const prev = this.s;
    const next = { ...prev, ...patch };
    const filterKeys: (keyof State)[] = ["root", "langs", "authors", "repo"];
    if (filterKeys.some((k) => k in patch && patch[k] !== prev[k])) next.filterRev = prev.filterRev + 1;
    this.s = next;
    this.listeners.forEach((l) => l(next, prev));
  }

  setSettings(patch: Partial<Settings>) {
    const prev = this.s.settings;
    const settings = { ...prev, ...patch };
    const refetch: (keyof Settings)[] = ["exclude", "ws", "hideBots"];
    const bump = refetch.some((k) => k in patch && JSON.stringify(patch[k]) !== JSON.stringify(prev[k]));
    this.set({ settings, ...(bump ? { filterRev: this.s.filterRev + 1 } : {}) });
  }

  /** Call `fn` when `select(state)` changes (shallow compare of arrays/objects by JSON). */
  watch<T>(select: (s: State) => T, fn: (v: T, s: State) => void, fireNow = false): () => void {
    let last = select(this.s);
    let lastKey = keyOf(last);
    const l: Listener = (s) => {
      const v = select(s);
      const k = keyOf(v);
      if (k !== lastKey) {
        last = v;
        lastKey = k;
        fn(v, s);
      }
    };
    this.listeners.add(l);
    if (fireNow) fn(last, this.s);
    return () => this.listeners.delete(l);
  }
}

function keyOf(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Set) return `set:${v.size}:${[...v].slice(0, 50).join(",")}`;
  return JSON.stringify(v);
}

export function initialState(): State {
  return {
    repo: null,
    steps: 0,
    cursor: 0,
    pos: 0,
    playing: false,
    brush: null,
    root: "",
    langs: [],
    authors: [],
    compare: null,
    search: null,
    settings: { ...DEFAULT_SETTINGS },
    filterRev: 0,
  };
}

/**
 * Saved settings keep only values that differ from the defaults, so a changed default reaches
 * everyone who never picked that setting. Version 1 (no `v`) saved every value.
 */
const SETTINGS_VERSION = 2;

export function settingsToSave(s: Settings): Record<string, unknown> {
  const out: Record<string, unknown> = { v: SETTINGS_VERSION };
  for (const k of Object.keys(s) as (keyof Settings)[]) {
    if (JSON.stringify(s[k]) !== JSON.stringify(DEFAULT_SETTINGS[k])) out[k] = s[k];
  }
  return out;
}

export function settingsFromSaved(saved: Record<string, unknown>): Partial<Settings> {
  const { v, ...rest } = saved;
  // Version 1 saved every value, so its "radial" tree layout is the old default, not a choice.
  if (v === undefined && rest.treeLayout === "radial") delete rest.treeLayout;
  return rest as Partial<Settings>;
}

/** Per-viewer convenience: remember settings per repo in localStorage (never required). */
export function loadSettings(repo: string): Partial<Settings> {
  try {
    const raw = localStorage.getItem(`strata:settings:${repo}`) ?? localStorage.getItem("strata:settings");
    return raw ? settingsFromSaved(JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function saveSettings(repo: string, s: Settings) {
  try {
    const text = JSON.stringify(settingsToSave(s));
    localStorage.setItem(`strata:settings:${repo}`, text);
    localStorage.setItem("strata:settings", text);
  } catch {
    /* storage unavailable: settings just don't persist */
  }
}
