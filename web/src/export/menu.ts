import type { Dashboard } from "../ui/dashboard";
import { h } from "../ui/dom";
import { popover } from "../ui/popover";
import { type Target, exportPng, exportSvg } from "./snapshot";

export function openExportMenu(d: Dashboard, anchor: HTMLElement) {
  const target = h("select", {},
    h("option", { value: "dashboard", text: "whole dashboard" }),
    h("option", { value: "treemap", text: "treemap" }),
    h("option", { value: "tree", text: "file tree" }),
    h("option", { value: "area", text: "stacked area" }),
    h("option", { value: "bars", text: "bars" }),
  );
  const t = () => target.value as Target;
  const png = h("button", { class: "btn", text: "PNG snapshot (2×)" });
  png.addEventListener("click", () => void exportPng(d, t()));
  const svg = h("button", { class: "btn", text: "SVG snapshot" });
  svg.addEventListener("click", () => exportSvg(d, t()));
  const video = h("button", { class: "btn", text: "Video (MP4 / GIF)…" });
  // Encoders load only when someone records a video.
  video.addEventListener("click", () => void import("./video").then((m) => m.openVideoDialog(d, anchor, t())));
  popover(anchor, h("div", {},
    h("h3", { text: "Export" }),
    h("label", { class: "row" }, h("span", { text: "What" }), target),
    h("div", { style: "display:flex;flex-direction:column;gap:6px;margin-top:8px" }, png, svg, video),
  ), 260);
}
