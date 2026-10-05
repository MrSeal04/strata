import { describe, expect, it, vi } from "vitest";
import { CompareCache } from "../src/model/compare";
import type { Paths } from "../src/model/filetree";
import { Store, initialState } from "../src/state/store";
import { markerHit } from "../src/ui/markers";

// (a comparison that never arrives: these tests are about A and B, not the data)
vi.mock(import("../src/api/client"), async (orig) => ({ ...(await orig()), api: { ...(await orig()).api, compare: () => new Promise(() => {}) } }));

describe("markerHit", () => {
  it("grabs the nearest marker within 6 px", () => {
    expect(markerHit(100, 200, 104)).toBe("a");
    expect(markerHit(100, 200, 195)).toBe("b");
    expect(markerHit(100, 200, 107)).toBeNull();
    expect(markerHit(100, 110, 106)).toBe("b");
  });

  it("leaves the choice to the drag when A and B share a pixel", () => {
    expect(markerHit(100, 101, 103)).toBe("ab");
  });

  it("skips a marker that isn't shown", () => {
    expect(markerHit(Number.NaN, 200, 3)).toBeNull();
    expect(markerHit(Number.NaN, 200, 198)).toBe("b");
  });
});

describe("CompareCache.move", () => {
  const setup = () => {
    const store = new Store({ ...initialState(), steps: 100 });
    const cache = new CompareCache(store, "r", {} as Paths);
    store.set({ compare: { a: 10, b: 50, mode: "overlay" } });
    return { store, cache };
  };

  it("keeps A before B and both inside the history", () => {
    const { store, cache } = setup();
    cache.move("a", 70);
    expect(store.get().compare).toMatchObject({ a: 49, b: 50 });
    cache.move("b", 20);
    expect(store.get().compare).toMatchObject({ a: 49, b: 50 });
    cache.move("b", 500);
    expect(store.get().compare).toMatchObject({ a: 49, b: 99 });
    cache.move("a", -5);
    expect(store.get().compare).toMatchObject({ a: 0, b: 99 });
  });

  it("does nothing outside compare", () => {
    const { store, cache } = setup();
    store.set({ compare: null });
    cache.move("a", 5);
    expect(store.get().compare).toBeNull();
  });
});
