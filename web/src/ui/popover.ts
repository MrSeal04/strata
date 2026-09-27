import { h } from "./dom";

let open: { el: HTMLElement; close: () => void } | null = null;

document.addEventListener("pointerdown", (e) => {
  if (open && !open.el.contains(e.target as Node)) open.close();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && open) open.close();
});

/** Anchor a floating panel under `anchor`; closes on outside click / Escape. */
export function popover(anchor: HTMLElement, content: HTMLElement, width = 280): () => void {
  open?.close();
  const r = anchor.getBoundingClientRect();
  const el = h("div", { class: "panel", role: "dialog" }, content);
  el.style.width = `${width}px`;
  el.style.top = `${r.bottom + 6}px`;
  el.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, r.left))}px`;
  el.style.right = "auto";
  document.body.append(el);
  const close = () => {
    el.remove();
    if (open?.el === el) open = null;
  };
  open = { el, close };
  return close;
}

export interface Option {
  value: string;
  label: string;
  hint?: string;
  swatch?: string;
}

/** Multi-select with a filter box. `selected` empty means "all". */
export function multiSelect(
  anchor: HTMLElement,
  title: string,
  options: Option[],
  selected: string[],
  onChange: (values: string[]) => void,
) {
  const chosen = new Set(selected);
  const list = h("div", { style: "max-height:320px;overflow:auto;margin-top:8px" });
  const filter = h("input", { type: "search", placeholder: "Filter…", style: "width:100%" });
  const render = () => {
    const q = filter.value.toLowerCase();
    list.replaceChildren(
      ...options
        .filter((o) => !q || o.label.toLowerCase().includes(q))
        .slice(0, 300)
        .map((o) => {
          const cb = h("input", { type: "checkbox" });
          cb.checked = chosen.has(o.value);
          cb.addEventListener("change", () => {
            if (cb.checked) chosen.add(o.value);
            else chosen.delete(o.value);
            onChange([...chosen]);
          });
          const sw = h("span", { class: "sw" });
          if (o.swatch) sw.style.cssText = `width:10px;height:10px;border-radius:2px;background:${o.swatch};flex:none`;
          return h("label", { class: "row", style: "justify-content:flex-start;gap:8px;cursor:pointer" },
            cb, o.swatch ? sw : null,
            h("span", { text: o.label, style: "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }),
            o.hint ? h("span", { class: "muted num", text: o.hint }) : null,
          );
        }),
    );
  };
  filter.addEventListener("input", render);
  const clearBtn = h("button", { class: "btn", text: "Show all" });
  clearBtn.addEventListener("click", () => {
    chosen.clear();
    onChange([]);
    render();
  });
  render();
  popover(anchor, h("div", {}, h("h3", { text: title }), h("div", { style: "display:flex;gap:6px" }, filter, clearBtn), list), 320);
  filter.focus();
}
