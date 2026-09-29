import { describe, expect, it } from "vitest";
import { bucketLabel, bucketOfLabel, bucketOfMonth, dirKey, monthIndex } from "../src/model/slices";

describe("directory keys", () => {
  // Same rule as the /area SQL: the first `depth` folders, else the file's own folder, else "(files)".
  it("cut paths at the depth below the root", () => {
    expect(dirKey("src/views/tree.ts", "", 1)).toBe("src");
    expect(dirKey("src/views/tree.ts", "", 2)).toBe("src/views");
    expect(dirKey("src/views/tree.ts", "", 3)).toBe("src/views");
    expect(dirKey("README.md", "", 1)).toBe("(files)");
    expect(dirKey("src/views/tree.ts", "src", 1)).toBe("views");
    expect(dirKey("src/main.ts", "src", 1)).toBe("(files)");
  });
});

describe("cohorts", () => {
  it("index months the way the engine does (UTC, since 1970-01)", () => {
    expect(monthIndex(0)).toBe(0);
    // 2026-09-27T12:00:00Z, the engine's own test date
    expect(monthIndex(1_790_510_400)).toBe((2026 - 1970) * 12 + 8);
    expect(monthIndex(-5)).toBe(0);
  });

  it("round-trip the server's bucket labels", () => {
    const m = (2019 - 1970) * 12 + 6; // 2019-07
    for (const unit of ["year", "quarter", "month"] as const) {
      const b = bucketOfMonth(m, unit);
      expect(bucketOfLabel(bucketLabel(b, unit), unit)).toBe(b);
    }
    expect(bucketLabel(bucketOfMonth(m, "year"), "year")).toBe("2019");
    expect(bucketLabel(bucketOfMonth(m, "quarter"), "quarter")).toBe("2019-Q3");
    expect(bucketLabel(bucketOfMonth(m, "month"), "month")).toBe("2019-07");
    expect(bucketOfLabel("(other)", "year")).toBeNaN();
    expect(bucketOfLabel("2019-Q3", "year")).toBeNaN();
  });
});
