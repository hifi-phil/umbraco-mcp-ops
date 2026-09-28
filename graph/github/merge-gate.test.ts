import { describe, expect, it } from "vitest";
import { deriveMergeGateOutcome, type MergeGateFacts } from "./merge-gate";

function facts(overrides: Partial<MergeGateFacts> = {}): MergeGateFacts {
  return {
    checkRuns: [{ status: "completed", conclusion: "success" }],
    latestReviewState: "approved",
    mergeable: true,
    ...overrides,
  };
}

describe("deriveMergeGateOutcome", () => {
  it("everything green -> null (the gate passes; not this function's job to say so)", () => {
    expect(deriveMergeGateOutcome(facts())).toBeNull();
  });

  it("a check still running -> still_pending", () => {
    expect(
      deriveMergeGateOutcome(facts({ checkRuns: [{ status: "in_progress", conclusion: null }] })),
    ).toBe("still_pending");
  });

  it("mergeable still being computed (null) -> still_pending", () => {
    expect(deriveMergeGateOutcome(facts({ mergeable: null }))).toBe("still_pending");
  });

  it("unresolvable conflicts (mergeable: false) -> hard", () => {
    expect(deriveMergeGateOutcome(facts({ mergeable: false }))).toBe("hard");
  });

  it("changes requested -> hard, even with green CI and mergeable", () => {
    expect(deriveMergeGateOutcome(facts({ latestReviewState: "changes_requested" }))).toBe("hard");
  });

  it("a required check failed -> soft (retryable, per Step 4's default)", () => {
    expect(
      deriveMergeGateOutcome(facts({ checkRuns: [{ status: "completed", conclusion: "failure" }] })),
    ).toBe("soft");
  });

  it("a required check timed out -> soft, same as a plain failure", () => {
    expect(
      deriveMergeGateOutcome(facts({ checkRuns: [{ status: "completed", conclusion: "timed_out" }] })),
    ).toBe("soft");
  });

  it("neutral/skipped conclusions don't count as failures", () => {
    expect(
      deriveMergeGateOutcome(
        facts({
          checkRuns: [
            { status: "completed", conclusion: "neutral" },
            { status: "completed", conclusion: "skipped" },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("hard failures win over a soft one when both are present (mergeable=false AND a failed check)", () => {
    expect(
      deriveMergeGateOutcome(
        facts({ mergeable: false, checkRuns: [{ status: "completed", conclusion: "failure" }] }),
      ),
    ).toBe("hard");
  });

  it("no check runs at all -> nothing to fail on, falls through to null", () => {
    expect(deriveMergeGateOutcome(facts({ checkRuns: [] }))).toBeNull();
  });

  it("a merely-commented review doesn't block anything", () => {
    expect(deriveMergeGateOutcome(facts({ latestReviewState: "commented" }))).toBeNull();
  });
});
