import { h } from "./dom";

/** One floating tooltip for the whole app. Content is built with DOM nodes (textContent). */
class Tooltip {
  private el: HTMLDivElement | null = null;

  show(clientX: number, clientY: number, content: Node) {
    if (!this.el) {
      this.el = h("div", { class: "tip", role: "tooltip" });
      document.body.append(this.el);
    }
    const el = this.el;
    el.replaceChildren(content);
    el.style.display = "block";
    const pad = 14;
    const r = el.getBoundingClientRect();
    let x = clientX + pad;
    let y = clientY + pad;
    if (x + r.width > window.innerWidth - 8) x = clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = clientY - r.height - pad;
    el.style.left = `${Math.max(8, x)}px`;
    el.style.top = `${Math.max(8, y)}px`;
  }

  hide() {
    if (this.el) this.el.style.display = "none";
  }
}

export const tooltip = new Tooltip();

/** Tooltip row: short line key in the series color, value first (strong), then the name. */
export function tipRow(color: string | null, value: string, name: string): HTMLElement {
  const k = h("span", { class: "k" });
  if (color) k.style.background = color;
  else k.style.visibility = "hidden";
  return h("div", { class: "row" }, k, h("span", { class: "v", text: value }), h("span", { class: "n", text: name }));
}
