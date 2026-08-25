import { describe, expect, it } from "vitest";
import { ALL_LABELS, LABELS } from "./labels";

describe("LABELS — the absolute list", () => {
  it("has exactly the seven tracked labels, none blank or duplicated", () => {
    expect(ALL_LABELS).toHaveLength(7);
    expect(new Set(ALL_LABELS).size).toBe(7);
    expect(ALL_LABELS.every((l) => l.length > 0)).toBe(true);
  });

  it("ALL_LABELS is exactly Object.values(LABELS) — no label defined but left out", () => {
    expect(new Set(ALL_LABELS)).toEqual(new Set(Object.values(LABELS)));
  });
});
