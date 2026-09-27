import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/state/store";
import { Timeline } from "../src/timeline/axis";
import { positionAt, runDuration } from "../src/timeline/playback";

const tl = new Timeline(Float64Array.from([100, 200, 200, 400, 1000]), new Uint8Array(5), new Uint8Array(5), new Float64Array(5));

describe("Timeline", () => {
  it("maps steps to x and back on the index axis", () => {
    expect(tl.domain("index")).toEqual([0, 5]);
    expect(tl.domain("index", 1, 3)).toEqual([1, 4]);
    expect(tl.stepAt(3.7, "index")).toBe(3);
    expect(tl.stepAt(99, "index")).toBe(4);
  });

  it("finds the last step at or before a time (monotonic axis with ties)", () => {
    expect(tl.stepAtTime(50)).toBe(0);
    expect(tl.stepAtTime(200)).toBe(2);
    expect(tl.stepAtTime(399)).toBe(2);
    expect(tl.stepAtTime(5000)).toBe(4);
    const [lo, hi] = tl.domain("time");
    expect(lo).toBe(100);
    expect(hi).toBeGreaterThan(1000);
  });

  it("interpolates fractional steps on the time axis", () => {
    expect(tl.x(2.5, "time")).toBe(300);
  });
});

describe("playback modes", () => {
  const s = { ...DEFAULT_SETTINGS };
  it("fixed length spreads the range over the run", () => {
    const c = { ...s, playMode: "fixed" as const, fixedSeconds: 10 };
    expect(positionAt(0, c, tl, 0, 4)).toBe(0);
    expect(positionAt(5, c, tl, 0, 4)).toBe(2.5);
    expect(runDuration(c, tl, 0, 4)).toBe(10);
  });
  it("commits per second is linear in commits", () => {
    const c = { ...s, playMode: "commits" as const, commitsPerSec: 2 };
    expect(positionAt(1.5, c, tl, 1, 4)).toBe(4);
    expect(runDuration(c, tl, 0, 4)).toBe(2.5);
  });
  it("calendar mode advances by days of history", () => {
    const c = { ...s, playMode: "calendar" as const, daysPerSec: 100 / 86_400 };
    // after 1 s, 100 s of history have passed: t = 200 -> step 2
    expect(Math.floor(positionAt(1, c, tl, 0, 4))).toBe(2);
    expect(Math.floor(positionAt(2.5, c, tl, 0, 4))).toBe(2); // t = 350
    expect(Math.floor(positionAt(3, c, tl, 0, 4))).toBe(3); // t = 400
    expect(Math.floor(positionAt(9.5, c, tl, 0, 4))).toBe(4); // t = 1050
  });
});
