import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, Store, initialState, linkShared, settingsFromSaved, settingsToSave } from "../src/state/store";

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

describe("linked cards", () => {
  const store = (patch: Partial<typeof DEFAULT_SETTINGS> = {}) => new Store({ ...initialState(), settings: linkShared({ ...DEFAULT_SETTINGS, ...patch }, {}) });

  it("move the tree with the treemap, and the area with the bars, either way round", () => {
    const s = store();
    s.setSettings({ colorBy: "author" });
    expect(s.get().settings.treeColorBy).toBe("author");
    s.setSettings({ treeColorBy: "cohort" });
    expect(s.get().settings.colorBy).toBe("cohort");
    s.setSettings({ clampPct: 95 });
    expect(s.get().settings.areaClampPct).toBe(95);
    s.setSettings({ areaClampPct: 0 });
    expect(s.get().settings.clampPct).toBe(0);
  });

  it("keep each card's own value while unlinked", () => {
    const s = store();
    s.setSettings({ linkCards: false });
    s.setSettings({ treeColorBy: "dir", areaClampPct: 0 });
    s.setSettings({ colorBy: "heat", clampPct: 95 });
    const st = s.get().settings;
    expect([st.colorBy, st.treeColorBy, st.clampPct, st.areaClampPct]).toEqual(["heat", "dir", 95, 0]);
  });

  it("take the treemap's and the bars' values when the link comes back on", () => {
    const s = store({ linkCards: false, colorBy: "author", treeColorBy: "dir", clampPct: 95, areaClampPct: 0 });
    s.setSettings({ linkCards: true });
    const st = s.get().settings;
    expect([st.colorBy, st.treeColorBy, st.clampPct, st.areaClampPct]).toEqual(["author", "author", 95, 95]);
  });

  it("resolve a patch that sets both sides to the treemap's and the bars' values", () => {
    const s = store();
    s.setSettings({ colorBy: "dir", treeColorBy: "author", clampPct: 99.9, areaClampPct: 0 });
    const st = s.get().settings;
    expect([st.colorBy, st.treeColorBy, st.clampPct, st.areaClampPct]).toEqual(["dir", "dir", 99.9, 99.9]);
  });

  it("give a color-by saved before the tree had its own to the tree too", () => {
    const loaded = linkShared({ ...DEFAULT_SETTINGS, ...settingsFromSaved({ v: 2, colorBy: "author", clampPct: 0 }) }, {});
    expect(loaded.treeColorBy).toBe("author");
    expect(loaded.areaClampPct).toBe(0);
  });

  it("leave unlinked settings alone when loading", () => {
    const loaded = linkShared({ ...DEFAULT_SETTINGS, ...settingsFromSaved({ v: 2, linkCards: false, colorBy: "author", treeColorBy: "heat" }) }, {});
    expect([loaded.colorBy, loaded.treeColorBy]).toEqual(["author", "heat"]);
  });
});
