// The real aggregation from-github.ts's check_suite.completed case always
// deferred: "this table has no rule consuming a bare checks_passed/failed
// event today... kept here as the aggregation point once/if CI-driving
// moves out of the loop and into something the reducer watches directly."
// For merge-flow specifically, that time has come — MERGE_GATE_FAILED_SOFT/
// HARD need deciding from several independently-fetched facts (the full
// check-run list for the head SHA, not just the one check_suite payload
// that triggered the webhook; review state; mergeability), not a single
// webhook field. That's I/O, so it can't live in translate() (deliberately
// pure) — this file is the pure DECISION over already-fetched facts;
// worker/src/coordinate.ts's handleCheckSuiteCompleted does the fetching
// and calls this.
//
// Mirrors merge-flow/SKILL.md's real Step 2/Step 4 exactly for the three
// dimensions a check-suite completing actually motivates re-checking:
// - CI genuinely green (every check-run's conclusion, not just one suite)
// - human approval still holds (no unresolved "changes requested")
// - mergeable / no conflicts
// Deliberately excludes the fourth Step 2 gate ("right base") — that's a
// static PR property check_suite completing doesn't change or motivate
// re-checking; a PR on the wrong base was already wrong before any CI
// ran, so it's out of scope for this specific event-triggered path.

export type CheckRunStatus = "queued" | "in_progress" | "completed";
export type CheckRunConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required"
  | null;

export type CheckRun = { status: CheckRunStatus; conclusion: CheckRunConclusion };

// Deliberately simplified vs. github-ops's real "Get reviews + review
// comments" operation: this takes the single most recent review's state
// across all reviewers, not each reviewer's own latest state collapsed
// individually. A reasonable approximation (the most recent submission is
// usually what a maintainer means to have stand), not exact parity —
// flagged rather than silently assumed identical.
export type LatestReviewState = "approved" | "changes_requested" | "commented" | "none";

export type MergeGateFacts = {
  checkRuns: readonly CheckRun[];
  latestReviewState: LatestReviewState;
  mergeable: boolean | null; // null = GitHub is still computing it
};

const NON_FAILING_CONCLUSIONS: readonly CheckRunConclusion[] = ["success", "neutral", "skipped"];

export type MergeGateOutcome = "still_pending" | "soft" | "hard" | null;

/**
 * null means the gate genuinely passes right now — not this function's
 * job to report (merge-flow's own Step 3 does the actual merge; the
 * reducer only ever needs to hear about a *failure*).
 */
export function deriveMergeGateOutcome(facts: MergeGateFacts): MergeGateOutcome {
  if (facts.checkRuns.some((c) => c.status !== "completed")) return "still_pending";
  if (facts.mergeable === null) return "still_pending";

  // Hard: needs a human, per Step 4's own two named cases.
  if (facts.mergeable === false) return "hard";
  if (facts.latestReviewState === "changes_requested") return "hard";

  // Soft: a required check genuinely failed — retryable, leave the label on.
  const anyCheckFailed = facts.checkRuns.some((c) => !NON_FAILING_CONCLUSIONS.includes(c.conclusion));
  if (anyCheckFailed) return "soft";

  return null;
}
