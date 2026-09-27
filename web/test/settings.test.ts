import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, settingsFromSaved, settingsToSave } from "../src/state/store";

describe("saved settings", () => {
  it("default to the force-directed tree", () => {
    expect(DEFAULT_SETTINGS.treeLayout).toBe("force");
  });

  it("keep only values that differ from the defaults", () => {
    const saved = settingsToSave({ ...DEFAULT_SETTINGS, colorBy: "age", treeLayout: "radial" });
    expect(saved).toEqual({ v: 2, colorBy: "age", treeLayout: "radial" });
    expect(settingsFromSaved(saved)).toEqual({ colorBy: "age", treeLayout: "radial" });
  });

  it("treat radial in the old every-value format as the old default", () => {
    const old = { ...DEFAULT_SETTINGS, treeLayout: "radial", colorBy: "age" };
    const loaded = settingsFromSaved(old);
    expect(loaded.treeLayout).toBeUndefined();
    expect(loaded.colorBy).toBe("age");
    expect({ ...DEFAULT_SETTINGS, ...loaded }.treeLayout).toBe("force");
  });

  it("keep another layout chosen in the old format", () => {
    expect(settingsFromSaved({ ...DEFAULT_SETTINGS, treeLayout: "icicle" }).treeLayout).toBe("icicle");
  });
});
