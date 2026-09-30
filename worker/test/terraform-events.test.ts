// terraform/variables.tf validates enforce_events against a literal copy of
// the event names (HCL can't import graph/). This keeps the copy honest.

import { describe, expect, it } from "vitest";
import { ALL_EVENTS } from "../../graph/constants/events";
// Vite's ?raw import (no Node types in this Workers project).
// @ts-expect-error — no type declaration for ?raw modules
import tf from "../terraform/variables.tf?raw";

describe("terraform enforce_events validation", () => {
  it("lists exactly the events in graph/constants/events.ts", () => {
    const text = tf as string;
    const block = text.slice(text.indexOf('variable "enforce_events"'));
    const list = block.slice(block.indexOf("contains(["), block.indexOf("], e)"));
    const names = [...list.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names)).toEqual(new Set(ALL_EVENTS));
  });
});
