import type { Dashboard } from "../ui/dashboard";
import { h } from "../ui/dom";
import { popover } from "../ui/popover";
import type { Target } from "./snapshot";

/** Filled in with the export milestone. */
export function openVideoDialog(_d: Dashboard, anchor: HTMLElement, _t: Target) {
  popover(anchor, h("div", { text: "Video export is coming soon." }), 240);
}
