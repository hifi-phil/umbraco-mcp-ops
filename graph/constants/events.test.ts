import { describe, expect, it } from "vitest";
import { ALL_EVENTS, EVENTS } from "./events";

describe("EVENTS — the absolute list", () => {
  it("has exactly the thirty domain events, none blank or duplicated", () => {
    expect(ALL_EVENTS).toHaveLength(30);
    expect(new Set(ALL_EVENTS).size).toBe(30);
    expect(ALL_EVENTS.every((e) => e.length > 0)).toBe(true);
  });

  it("ALL_EVENTS is exactly Object.values(EVENTS) — no event defined but left out", () => {
    expect(new Set(ALL_EVENTS)).toEqual(new Set(Object.values(EVENTS)));
  });
});
