import { describe, expect, it } from "vitest";
import { ALL_ROUTINES, ROUTINES } from "./routines";

describe("ROUTINES — the absolute list", () => {
  it("has exactly the five real loop skills, none blank or duplicated", () => {
    expect(ALL_ROUTINES).toHaveLength(5);
    expect(new Set(ALL_ROUTINES).size).toBe(5);
    expect(ALL_ROUTINES.every((r) => r.length > 0)).toBe(true);
  });

  it("ALL_ROUTINES is exactly Object.values(ROUTINES) — no routine defined but left out", () => {
    expect(new Set(ALL_ROUTINES)).toEqual(new Set(Object.values(ROUTINES)));
  });
});
