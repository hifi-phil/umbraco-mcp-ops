import { describe, expect, it } from "vitest";
import { ROUTINES } from "../constants/routines";
import { parseRoutineSignal } from "./from-routine";

describe("parseRoutineSignal — process (heartbeat)", () => {
  it("a valid step -> a process update", () => {
    expect(
      parseRoutineSignal({
        kind: "process",
        routine: ROUTINES.ISSUE_BUILD_LOOP,
        issue: 412,
        step: "running tests",
      }),
    ).toEqual({
      kind: "process",
      routine: ROUTINES.ISSUE_BUILD_LOOP,
      issue: 412,
      step: "running tests",
    });
  });

  it("an empty step -> null", () => {
    expect(
      parseRoutineSignal({ kind: "process", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412, step: "" }),
    ).toBeNull();
  });
});

describe("parseRoutineSignal — completion (fast-path, non-authoritative)", () => {
  it("a valid build_succeeded outcome -> a completion update", () => {
    expect(
      parseRoutineSignal({
        kind: "completion",
        routine: ROUTINES.ISSUE_BUILD_LOOP,
        issue: 412,
        outcome: { outcome: "build_succeeded", pr: 123 },
      }),
    ).toEqual({
      kind: "completion",
      routine: ROUTINES.ISSUE_BUILD_LOOP,
      issue: 412,
      outcome: { outcome: "build_succeeded", pr: 123 },
    });
  });

  it("a valid build_blocked outcome -> a completion update", () => {
    expect(
      parseRoutineSignal({
        kind: "completion",
        routine: ROUTINES.ISSUE_BUILD_LOOP,
        issue: 412,
        outcome: { outcome: "build_blocked", reason: "CI cap tripped" },
      }),
    ).toEqual({
      kind: "completion",
      routine: ROUTINES.ISSUE_BUILD_LOOP,
      issue: 412,
      outcome: { outcome: "build_blocked", reason: "CI cap tripped" },
    });
  });

  it("an unrecognised outcome shape -> null, not a throw", () => {
    expect(
      parseRoutineSignal({
        kind: "completion",
        routine: ROUTINES.ISSUE_BUILD_LOOP,
        issue: 412,
        outcome: { outcome: "something_else" },
      }),
    ).toBeNull();
  });

  it("outcome missing entirely -> null", () => {
    expect(
      parseRoutineSignal({
        kind: "completion",
        routine: ROUTINES.ISSUE_BUILD_LOOP,
        issue: 412,
        outcome: undefined,
      }),
    ).toBeNull();
  });
});
