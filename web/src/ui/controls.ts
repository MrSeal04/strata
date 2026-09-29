import type { App } from "../app";
import { COLOR_BY_LABEL, cohortUnit } from "../model/slices";
import type { ColorBy, Settings, Store } from "../state/store";
import { h } from "./dom";

type BoolKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

/**
 * A card-header select bound to one setting. It follows changes made anywhere else (the linked
 * card, the settings panel). With `custom`, a value no preset matches (saved by an older version)
 * gets an option of its own instead of showing as blank.
 */
export function settingSelect<K extends keyof Settings>(
  store: Store,
  key: K,
  options: [Settings[K], string][],
  attrs: { label: string; title?: string; custom?: (v: Settings[K]) => string },
): HTMLSelectElement {
  const el = h("select", { "aria-label": attrs.label, title: attrs.title });
  const sync = () => {
    const v = store.get().settings[key];
    let opts = options;
    if (attrs.custom && !options.some(([o]) => o === v)) {
      opts = [...options, [v, attrs.custom(v)]];
      if (typeof v === "number") opts.sort((a, b) => Number(a[0]) - Number(b[0]));
    }
    el.replaceChildren(...opts.map(([o, text]) => h("option", { value: String(o), text })));
    el.value = String(v);
  };
  el.addEventListener("change", () => {
    const cur = store.get().settings[key];
    store.setSettings({ [key]: typeof cur === "number" ? Number(el.value) : el.value } as Partial<Settings>);
  });
  store.watch((s) => s.settings[key], sync, true);
  return el;
}

/** A card-header button that turns a setting on and off (dark while on). */
export function settingToggle(store: Store, key: BoolKey, text: string, title: string): HTMLButtonElement {
  const el = h("button", { class: "btn", title, "aria-pressed": "false" }, text);
  el.addEventListener("click", () => store.setSettings({ [key]: !store.get().settings[key] }));
  store.watch((s) => s.settings[key], (on) => {
    el.classList.toggle("on", on);
    el.setAttribute("aria-pressed", String(on));
  }, true);
  return el;
}

const LINK_HINT = "while cards are linked (settings → Link shared options)";

/** Outlier clipping for the bars (`clampPct`) or the added / deleted area chart (`areaClampPct`). */
export function clipSelect(store: Store, key: "clampPct" | "areaClampPct", twin: string): HTMLSelectElement {
  return settingSelect(store, key, [[0, "no clipping"], [95, "clip at p95"], [99, "clip at p99"], [99.9, "clip at p99.9"]], {
    label: "Clip outliers",
    title: `Clip values above this percentile so small commits stay visible. Clipped ones get a ▲ marker; the true value is in the tooltip. Shared with the ${twin} ${LINK_HINT}`,
    custom: (v) => `clip at p${v}`,
  });
}

const GLOW_SECONDS = [0.5, 1, 1.5, 3, 5, 10];

/**
 * What a file card is colored by (`colorBy` for the treemap, `treeColorBy` for the tree), its
 * granularity (directory depth or cohort unit, shared by every card) and how long a touched file
 * glows (shared too; every mode but "last edited" shows activity). All step aside in compare,
 * which colors by growth.
 */
export function colorControls(app: App, key: "colorBy" | "treeColorBy", twin: string) {
  const store = app.store;
  const show = settingSelect(store, key, (Object.keys(COLOR_BY_LABEL) as ColorBy[]).map((k) => [k, `by ${COLOR_BY_LABEL[k]}`]), {
    label: "Color by",
    title: `What the colors show. Shared with the ${twin} ${LINK_HINT}`,
  });
  const extra = h("select", { "aria-label": "Granularity" });
  extra.addEventListener("change", () => {
    const v = extra.value;
    if (store.get().settings[key] === "cohort") store.setSettings({ cohortUnit: v as Settings["cohortUnit"] });
    else store.setSettings({ areaDepth: Number(v) });
  });
  const glow = settingSelect(store, "heatSeconds", GLOW_SECONDS.map((v) => [v, `glow ${v} s`]), {
    label: "Activity glow",
    title: `How long a file stays highlighted after a commit touches it, in playback seconds (also the ${twin})`,
    custom: (v) => `glow ${v} s`,
  });
  const sync = () => {
    const s = store.get();
    const by = s.settings[key];
    const comparing = !!s.compare;
    show.style.display = comparing ? "none" : "";
    const opts: [string, string][] =
      by === "cohort"
        ? [["auto", `auto (${cohortUnit(app)})`], ["year", "per year"], ["quarter", "per quarter"], ["month", "per month"]]
        : by === "dir"
          ? Array.from({ length: 6 }, (_, i): [string, string] => [String(i + 1), `depth ${i + 1}`])
          : [];
    extra.replaceChildren(...opts.map(([v, text]) => h("option", { value: v, text })));
    extra.style.display = opts.length && !comparing ? "" : "none";
    extra.value = by === "cohort" ? s.settings.cohortUnit : String(s.settings.areaDepth);
    glow.style.display = by === "edited" || comparing ? "none" : "";
  };
  store.watch((s) => [s.settings[key], !!s.compare, s.settings.cohortUnit, s.settings.areaDepth], sync, true);
  return { show, extra, glow };
}
