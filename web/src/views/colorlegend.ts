import type { App } from "../app";
import { colorMaps } from "../model/colors";
import { bucketLabel, cohortColor, cohortRange, cohortUnit, heatColor, heatSpan } from "../model/slices";
import type { ColorBy } from "../state/store";
import { palette } from "../theme";
import { fmt, h } from "../ui/dom";

/** Legend for a tree or treemap color-by mode (identity is never color-alone). */
export function renderColorLegend(app: App, el: HTMLElement, colorBy: ColorBy) {
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
  // A stepped ramp: at most six labelled cohorts, spread over the history.
  const cohortRamp = () => {
    const unit = cohortUnit(app);
    const [first, last] = cohortRange(app, unit);
    const n = Math.min(6, last - first + 1);
    const buckets = Array.from({ length: n }, (_, i) => Math.round(first + ((last - first) * i) / Math.max(1, n - 1)));
    el.replaceChildren(
      ...[...new Set(buckets)].map((b, i, all) => item(cohortColor(b, first, last), `${bucketLabel(b, unit)}${i === 0 ? " (oldest)" : i === all.length - 1 ? " (newest)" : ""}`)),
    );
  };
  if (s.compare) {
    el.replaceChildren(item(pal.add, "grew / new"), item(pal.divMid, "unchanged"), item(pal.del, "shrank"));
    return;
  }
  switch (colorBy) {
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
    case "author":
    case "cohort": {
      // Clicking an author filters to them, as in the area chart.
      const only = (name: string) => {
        const a = app.authors.find((x) => x.name === name);
        return a ? () => app.store.set({ authors: s.authors.length === 1 && s.authors[0] === a.id ? [] : [a.id] }) : undefined;
      };
      if (app.composition.ready(colorBy)) {
        // Exactly the bands: the keys the area chart labels, then everything else.
        const comp = app.composition;
        el.replaceChildren(
          ...comp.order.filter((k) => k >= 0).map((k) => item(comp.color(k), comp.label(k), colorBy === "author" ? only(comp.label(k)) : undefined)),
          item(pal.other, colorBy === "author" ? "other authors" : "other periods"),
        );
      } else if (colorBy === "cohort") {
        cohortRamp();
      } else {
        const names = app.authors.map((a) => a.name).filter((n) => colorMaps.author.slot(n) >= 0).sort((a, b) => colorMaps.author.slot(a) - colorMaps.author.slot(b));
        el.replaceChildren(...names.map((n) => item(colorMaps.author.color(n), n, only(n))), item(pal.other, "other authors"));
      }
      break;
    }
    case "edited": {
      // Ticks along the log scale, ending with the scale's far end (the history's age).
      const span = heatSpan(app);
      const D = 86400;
      const ticks: [number, string][] = [[3600, "just now"], [D, "1 day"], [7 * D, "1 week"], [30.4 * D, "1 month"], [182 * D, "6 months"], [365.25 * D, "1 year"], [2 * 365.25 * D, "2 years"], [5 * 365.25 * D, "5 years"], [10 * 365.25 * D, "10 years"]];
      const shown = ticks.filter(([t]) => t < span * 0.8);
      el.replaceChildren(
        ...shown.map(([t, label]) => item(heatColor(t, span), label)),
        item(heatColor(span, span), `${fmt.ago(span)} ago`),
        item(pal.other, "unknown"),
      );
      break;
    }
    case "heat":
      el.replaceChildren(item(pal.add, "just gained lines"), item(pal.del, "just lost lines"), item(pal.surface3, "untouched lately"));
      break;
  }
}
