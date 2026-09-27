// Canvas can't read CSS variables, so resolved token values are mirrored here and refreshed
// whenever the theme changes.

export interface Palette {
  dark: boolean;
  page: string;
  surface: string;
  surface2: string;
  surface3: string;
  ink: string;
  ink2: string;
  inkMuted: string;
  grid: string;
  axis: string;
  accent: string;
  series: string[];
  other: string;
  dir: string;
  add: string;
  del: string;
  divMid: string;
  seqLo: string;
  seqHi: string;
  font: string;
}

let current: Palette | null = null;
const listeners = new Set<() => void>();

function read(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  const classic = document.documentElement.dataset.diff === "greenred";
  return {
    dark: cs.colorScheme.includes("dark") || v("--surface").toLowerCase() === "#1a1a19",
    page: v("--page"),
    surface: v("--surface"),
    surface2: v("--surface-2"),
    surface3: v("--surface-3"),
    ink: v("--ink"),
    ink2: v("--ink-2"),
    inkMuted: v("--ink-muted"),
    grid: v("--grid"),
    axis: v("--axis"),
    accent: v("--accent"),
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--s${i}`)),
    other: v("--other"),
    dir: v("--dir"),
    add: classic ? v("--add-classic") : v("--add"),
    del: v("--del"),
    divMid: v("--div-mid"),
    seqLo: v("--seq-lo"),
    seqHi: v("--seq-hi"),
    font: v("--font") || "system-ui, sans-serif",
  };
}

export function palette(): Palette {
  if (!current) current = read();
  return current;
}

export function onPaletteChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function refresh() {
  current = read();
  listeners.forEach((fn) => fn());
}

/** Apply theme ("auto" | "light" | "dark") and diff colors ("bluered" | "greenred"). */
export function applyTheme(theme: string, diff: string) {
  const root = document.documentElement;
  if (theme === "auto") delete root.dataset.theme;
  else root.dataset.theme = theme;
  root.dataset.diff = diff;
  refresh();
}

if (typeof window !== "undefined") {
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", refresh);
}
