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

describe("parseOutcomeShape — release_approved (the release split)", () => {
  it("accepts the PR, the reviewed commit, the version and the note; rejects any missing", () => {
    const ok = { outcome: "release_approved", pr: 220, sha: "abc", version: "2.1.0", note: "Issue stages." };
    expect(parseOutcomeShape(ok)).toEqual(ok);
    for (const key of ["pr", "sha", "version", "note"]) {
      const { [key]: _, ...missing } = ok as Record<string, unknown>;
      expect(parseOutcomeShape(missing), key).toBeNull();
    }
  });
});

describe("parseOutcomeShape — review outcomes", () => {
  it("accepts review_passed, review_findings and review_blocked", () => {
    expect(parseOutcomeShape({ outcome: "review_passed" })).toEqual({ outcome: "review_passed" });
    expect(parseOutcomeShape({ outcome: "review_findings", findings: 3 })).toEqual({ outcome: "review_findings", findings: 3 });
    expect(parseOutcomeShape({ outcome: "review_blocked", reason: "wrong approach" })).toEqual({
      outcome: "review_blocked",
      reason: "wrong approach",
    });
  });

  it("rejects review_findings without a numeric count, and review_blocked without a reason", () => {
    expect(parseOutcomeShape({ outcome: "review_findings", findings: "3" })).toBeNull();
    expect(parseOutcomeShape({ outcome: "review_blocked" })).toBeNull();
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
