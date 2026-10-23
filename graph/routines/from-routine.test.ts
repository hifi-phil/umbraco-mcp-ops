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

describe("parseRoutineSignal — completion (timing only, never applied)", () => {
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

describe("parseRoutineSignal — outcome (explicit, authoritative)", () => {
  it("a valid outcome -> an outcome update, the shape checked by parseOutcomeShape", () => {
    expect(
      parseRoutineSignal({
        kind: "outcome",
        routine: ROUTINES.ISSUE_BUILD_LOOP,
        issue: 412,
        outcome: { outcome: "build_succeeded", pr: 123 },
      }),
    ).toEqual({
      kind: "outcome",
      routine: ROUTINES.ISSUE_BUILD_LOOP,
      issue: 412,
      outcome: { outcome: "build_succeeded", pr: 123 },
    });
  });

  it("an invalid outcome -> null", () => {
    expect(
      parseRoutineSignal({ kind: "outcome", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412, outcome: { outcome: "build_succeeded" } }),
    ).toBeNull();
  });
});

describe("parseRoutineSignal — blocked and ended", () => {
  it("blocked with a detail -> a blocked update", () => {
    expect(
      parseRoutineSignal({ kind: "blocked", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412, detail: "Bash(npm publish)" }),
    ).toEqual({ kind: "blocked", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412, detail: "Bash(npm publish)" });
  });

  it("ended with a detail -> an ended update", () => {
    expect(
      parseRoutineSignal({ kind: "ended", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412, detail: "session stopped" }),
    ).toEqual({ kind: "ended", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412, detail: "session stopped" });
  });

  it("an empty detail -> null", () => {
    expect(parseRoutineSignal({ kind: "blocked", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412, detail: "" })).toBeNull();
    expect(parseRoutineSignal({ kind: "ended", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412, detail: "" })).toBeNull();
  });

  it("an unknown kind -> null", () => {
    expect(parseRoutineSignal({ kind: "other", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412 } as never)).toBeNull();
  });
});
