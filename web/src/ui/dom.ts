// Minimal DOM helpers. Untrusted strings (paths, names, messages) always go through textContent.

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "text") el.textContent = String(v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

export function clear(el: Element) {
  while (el.firstChild) el.firstChild.remove();
}

const ICONS: Record<string, string> = {
  play: "M5 3.5v9l8-4.5z",
  pause: "M4 3h3v10H4zM9 3h3v10H9z",
  prev: "M4 3h2v10H4zM13 3v10L6.5 8z",
  next: "M10 3h2v10h-2zM3 3v10l6.5-5z",
  loop: "M3 7a4 4 0 0 1 4-4h5l-2-2M13 9a4 4 0 0 1-4 4H4l2 2",
  gear: "M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1l1.2 2 2.3-.6.6 2.3 2 1.2-1 2.1 1 2.1-2 1.2-.6 2.3-2.3-.6L8 15l-1.2-2-2.3.6-.6-2.3-2-1.2 1-2.1-1-2.1 2-1.2.6-2.3 2.3.6z",
  download: "M8 2v8m0 0l-3-3m3 3l3-3M3 13h10",
  search: "M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zm3.5-1.5L14 14",
  close: "M4 4l8 8M12 4l-8 8",
  moon: "M13 9.5A5.5 5.5 0 0 1 6.5 3 5.5 5.5 0 1 0 13 9.5z",
  table: "M2 3h12v10H2zM2 6.5h12M2 10h12M6 3v10",
  compare: "M3 3h4v10H3zM9 6h4v7H9z",
  back: "M10 3L5 8l5 5",
  fit: "M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4",
};

export function icon(name: string, filled = false): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", ICONS[name] ?? "");
  const fill = filled || ["play", "pause", "prev", "next", "moon"].includes(name);
  path.setAttribute("fill", fill ? "currentColor" : "none");
  path.setAttribute("stroke", fill ? "none" : "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

export const fmt = {
  int: (n: number) => Math.round(n).toLocaleString("en-US"),
  compact: (n: number) => {
    const a = Math.abs(n);
    if (a >= 1e9) return `${(n / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`;
    if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
    if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K`;
    return `${Math.round(n)}`;
  },
  date: (t: number) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : ""),
  datetime: (t: number) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") : ""),
  signed: (n: number) => (n > 0 ? `+${fmt.int(n)}` : n < 0 ? `−${fmt.int(-n)}` : "0"),
  ago: (secs: number) => {
    const d = secs / 86400;
    if (d < 1) return "today";
    if (d < 60) return `${Math.round(d)} days`;
    if (d < 730) return `${Math.round(d / 30.4)} months`;
    return `${(d / 365.25).toFixed(1)} years`;
  },
};
