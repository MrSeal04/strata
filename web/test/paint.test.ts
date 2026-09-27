import { describe, expect, it } from "vitest";
import { SvgPainter } from "../src/paint/svg";

describe("SvgPainter", () => {
  it("balances groups across save/clip/translate/restore", () => {
    const p = new SvgPainter(100, 50);
    p.rect(0, 0, 10, 10, "#000");
    p.save();
    p.translate(5, 5);
    p.clip(0, 0, 20, 20);
    p.circle(1, 1, 2, "#f00");
    p.restore();
    p.save();
    p.translate(1, 1);
    const svg = p.toString();
    const opens = (svg.match(/<g[ >]/g) ?? []).length;
    const closes = (svg.match(/<\/g>/g) ?? []).length;
    expect(opens).toBe(closes);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('clip-path="url(#c0)"');
  });

  it("escapes text", () => {
    const p = new SvgPainter(10, 10);
    p.text('<a&b>"', 0, 0, { color: "#000" });
    expect(p.toString()).toContain("&lt;a&amp;b&gt;&quot;");
  });
});
