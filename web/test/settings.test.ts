import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, settingsFromSaved, settingsToSave } from "../src/state/store";

describe("saved settings", () => {
  it("default to the force-directed tree", () => {
    expect(DEFAULT_SETTINGS.treeLayout).toBe("force");
  });

  it("keep only values that differ from the defaults", () => {
    const saved = settingsToSave({ ...DEFAULT_SETTINGS, colorBy: "author", treeLayout: "radial" });
    expect(saved).toEqual({ v: 2, colorBy: "author", treeLayout: "radial" });
    expect(settingsFromSaved(saved)).toEqual({ colorBy: "author", treeLayout: "radial" });
  });

  it("treat radial in the old every-value format as the old default", () => {
    const old = { ...DEFAULT_SETTINGS, treeLayout: "radial", colorBy: "author" };
    const loaded = settingsFromSaved(old);
    expect(loaded.treeLayout).toBeUndefined();
    expect(loaded.colorBy).toBe("author");
    expect({ ...DEFAULT_SETTINGS, ...loaded }.treeLayout).toBe("force");
  });

  it("turn the retired line-age coloring into when-written, in either format", () => {
    expect(settingsFromSaved({ v: 2, colorBy: "age" }).colorBy).toBe("cohort");
    expect(settingsFromSaved({ ...DEFAULT_SETTINGS, colorBy: "age" }).colorBy).toBe("cohort");
    expect(settingsFromSaved({ v: 2, colorBy: "heat" }).colorBy).toBe("heat");
  });

  it("keep another layout chosen in the old format", () => {
    expect(settingsFromSaved({ ...DEFAULT_SETTINGS, treeLayout: "icicle" }).treeLayout).toBe("icicle");
  });
});
