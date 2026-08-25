import { describe, expect, it } from "vitest";
import { parseBuildOutcomeShape } from "./outcomes";

describe("parseBuildOutcomeShape", () => {
  it("accepts a valid build_succeeded shape", () => {
    expect(parseBuildOutcomeShape({ outcome: "build_succeeded", pr: 123 })).toEqual({
      outcome: "build_succeeded",
      pr: 123,
    });
  });

  it("accepts a valid build_blocked shape", () => {
    expect(parseBuildOutcomeShape({ outcome: "build_blocked", reason: "CI cap tripped" })).toEqual(
      { outcome: "build_blocked", reason: "CI cap tripped" },
    );
  });

  it("rejects build_succeeded with a non-number pr", () => {
    expect(parseBuildOutcomeShape({ outcome: "build_succeeded", pr: "123" })).toBeNull();
  });

  it("rejects build_blocked with a non-string reason", () => {
    expect(parseBuildOutcomeShape({ outcome: "build_blocked", reason: 42 })).toBeNull();
  });

  it("rejects an unrecognised outcome name", () => {
    expect(parseBuildOutcomeShape({ outcome: "something_else" })).toBeNull();
  });

  it("rejects non-object input", () => {
    expect(parseBuildOutcomeShape(null)).toBeNull();
    expect(parseBuildOutcomeShape("build_succeeded")).toBeNull();
    expect(parseBuildOutcomeShape(undefined)).toBeNull();
  });
});
