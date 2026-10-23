import { describe, expect, it } from "vitest";
import { ROUTINES } from "../constants/routines";
import { parseRoutineSignal, type RoutineSignal } from "./from-routine";

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

describe("parseRoutineSignal — completion (the outcome, applied like its comment)", () => {
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

describe("parseRoutineSignal — blocked and ended", () => {
  it("blocked with a detail -> a blocked update", () => {
    expect(
      parseRoutineSignal({ kind: "blocked", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412, detail: "Bash: npm publish" }),
    ).toEqual({ kind: "blocked", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412, detail: "Bash: npm publish" });
  });

  it("ended with a detail -> an ended update", () => {
    expect(
      parseRoutineSignal({ kind: "ended", routine: ROUTINES.REVIEW_LOOP, issue: 7, detail: "session stopped: max turns" }),
    ).toEqual({ kind: "ended", routine: ROUTINES.REVIEW_LOOP, issue: 7, detail: "session stopped: max turns" });
  });

  it("an empty or missing detail -> null", () => {
    expect(parseRoutineSignal({ kind: "blocked", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412, detail: "  " })).toBeNull();
    expect(
      parseRoutineSignal({ kind: "ended", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412 } as unknown as RoutineSignal),
    ).toBeNull();
  });

  it("an unknown kind -> null, not a throw", () => {
    expect(
      parseRoutineSignal({ kind: "paused", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412 } as unknown as RoutineSignal),
    ).toBeNull();
  });
});
