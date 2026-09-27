import type { App } from "../app";
import { colorMaps, sequential } from "../model/colors";
import { palette } from "../theme";
import { fmt, h } from "../ui/dom";

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
    case "author": {
      const names = app.authors.map((a) => a.name).filter((n) => colorMaps.author.slot(n) >= 0).sort((a, b) => colorMaps.author.slot(a) - colorMaps.author.slot(b));
      el.replaceChildren(...names.map((n) => item(colorMaps.author.color(n), n)), item(pal.other, "other authors"));
      break;
    }
    case "age": {
      const t0 = app.tl.time(0);
      const t1 = app.tl.time(s.cursor);
      el.replaceChildren(
        item(sequential(0), `lines written ${fmt.date(t0)}`),
        item(sequential(0.5), fmt.date((t0 + t1) / 2)),
        item(sequential(1), `${fmt.date(t1)} (newest)`),
      );
      break;
    }
    case "heat":
      el.replaceChildren(item(pal.add, "just gained lines"), item(pal.del, "just lost lines"), item(pal.surface3, "untouched lately"));
      break;
  }
}
