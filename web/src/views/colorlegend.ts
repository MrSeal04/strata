import type { App } from "../app";
import { colorMaps } from "../model/colors";
import { bucketLabel, cohortColor, cohortRange, cohortUnit } from "../model/slices";
import { palette } from "../theme";
import { h } from "../ui/dom";

/** Legend for the tree/treemap color-by mode (identity is never color-alone). */
export function renderColorLegend(app: App, el: HTMLElement) {
  const s = app.store.get();
  const pal = palette();
  const sw = (c: string) => {
    const e = h("span", { class: "sw" });
    e.style.background = c;
    return e;
  };
  const item = (c: string, label: string, onClick?: () => void) => {
    const it = h("span", { class: "it", title: label }, sw(c), h("span", { class: "l", text: label }));
    if (onClick) it.addEventListener("click", onClick);
    return it;
  };
  if (s.compare) {
    el.replaceChildren(item(pal.add, "grew / new"), item(pal.divMid, "unchanged"), item(pal.del, "shrank"));
    return;
  }
  switch (s.settings.colorBy) {
    case "lang": {
      const langs = app.summary.langs.map((l) => l.lang).filter((l) => colorMaps.lang.slot(l) >= 0).sort((a, b) => colorMaps.lang.slot(a) - colorMaps.lang.slot(b));
      el.replaceChildren(
        ...langs.map((l) => item(colorMaps.lang.color(l), l, () => app.store.set({ langs: s.langs.length === 1 && s.langs[0] === l ? [] : [l] }))),
        item(pal.other, "other languages"),
      );
      break;
    }
    case "dir": {
      // Clicking a folder opens it, as in the area chart.
      const open = (key: string) => (key === "(files)" ? undefined : () => app.store.set({ root: s.root ? `${s.root}/${key}` : key }));
      el.replaceChildren(...colorMaps.dir.keys().map((k) => item(colorMaps.dir.color(k), k, open(k))), item(pal.other, "other folders"));
      break;
    }
    case "author": {
      const names = app.authors.map((a) => a.name).filter((n) => colorMaps.author.slot(n) >= 0).sort((a, b) => colorMaps.author.slot(a) - colorMaps.author.slot(b));
      const only = (name: string) => () => {
        const a = app.authors.find((x) => x.name === name);
        if (a) app.store.set({ authors: s.authors.length === 1 && s.authors[0] === a.id ? [] : [a.id] });
      };
      el.replaceChildren(...names.map((n) => item(colorMaps.author.color(n), n, only(n))), item(pal.other, "other authors"));
      break;
    }
    case "cohort": {
      // A stepped ramp: at most six labelled cohorts, spread over the history.
      const unit = cohortUnit(app);
      const [first, last] = cohortRange(app, unit);
      const n = Math.min(6, last - first + 1);
      const buckets = Array.from({ length: n }, (_, i) => Math.round(first + ((last - first) * i) / Math.max(1, n - 1)));
      el.replaceChildren(
        ...[...new Set(buckets)].map((b, i, all) => item(cohortColor(b, first, last), `${bucketLabel(b, unit)}${i === 0 ? " (oldest)" : i === all.length - 1 ? " (newest)" : ""}`)),
      );
      break;
    }
    case "heat":
      el.replaceChildren(item(pal.add, "just gained lines"), item(pal.del, "just lost lines"), item(pal.surface3, "untouched lately"));
      break;
  }
}
