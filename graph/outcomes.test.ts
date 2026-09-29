import { describe, expect, it } from "vitest";
import { parseOutcomeShape } from "./outcomes";

describe("parseOutcomeShape — build outcomes", () => {
  it("accepts a valid build_succeeded shape", () => {
    expect(parseOutcomeShape({ outcome: "build_succeeded", pr: 123 })).toEqual({
      outcome: "build_succeeded",
      pr: 123,
    });
  });

  it("accepts a valid build_blocked shape", () => {
    expect(parseOutcomeShape({ outcome: "build_blocked", reason: "CI cap tripped" })).toEqual({
      outcome: "build_blocked",
      reason: "CI cap tripped",
    });
  });

  it("rejects build_succeeded with a non-number pr", () => {
    expect(parseOutcomeShape({ outcome: "build_succeeded", pr: "123" })).toBeNull();
  });

  it("rejects build_blocked with a non-string reason", () => {
    expect(parseOutcomeShape({ outcome: "build_blocked", reason: 42 })).toBeNull();
  });
});

describe("parseOutcomeShape — release outcomes", () => {
  it("accepts a valid release_blocked shape", () => {
    expect(parseOutcomeShape({ outcome: "release_blocked", reason: "BLOCK: missing changelog" })).toEqual(
      { outcome: "release_blocked", reason: "BLOCK: missing changelog" },
    );
  });

  it("accepts a valid release_published shape", () => {
    expect(parseOutcomeShape({ outcome: "release_published", version: "18.0.0-beta3" })).toEqual({
      outcome: "release_published",
      version: "18.0.0-beta3",
    });
  });

  it("rejects release_blocked with a non-string reason", () => {
    expect(parseOutcomeShape({ outcome: "release_blocked", reason: 42 })).toBeNull();
  });

  it("rejects release_published with a non-string version", () => {
    expect(parseOutcomeShape({ outcome: "release_published", version: 18 })).toBeNull();
  });
});

describe("parseOutcomeShape — general rejects", () => {
  it("rejects an unrecognised outcome name", () => {
    expect(parseOutcomeShape({ outcome: "something_else" })).toBeNull();
  });

  it("rejects non-object input", () => {
    expect(parseOutcomeShape(null)).toBeNull();
    expect(parseOutcomeShape("build_succeeded")).toBeNull();
    expect(parseOutcomeShape(undefined)).toBeNull();
  });
});
