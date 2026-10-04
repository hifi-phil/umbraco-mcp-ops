// The review's gate (15-agent-splits.md): a PR in AI_REVIEWING gets review-loop
// once its CI is green, rework-loop first if it's red. And the caps: CI
// fixes at caps.ciFixAttempts, the review's own findings at
// caps.botReviewReworks, then AI_STUCK.

import { LABELS } from "@orchestrator/graph/constants/labels";
import { ROUTINES } from "@orchestrator/graph/constants/routines";
import { failedCheckNames, type MergeGateFacts } from "@orchestrator/graph/github/merge-gate";
import { EVENTS } from "@orchestrator/graph/constants/events";
import { depsFor, type Acting, type CoordinateResult, type Deps, type IssueRef } from "./types";
import { applyEvent } from "./apply";

/**
 * Reads the PR's CI and moves it on: green fires review-loop, red hands it to
 * rework-loop, still running (or nothing reported yet) waits for the next
 * check suite to finish. Called when AI_REVIEWING is added, each time a check
 * suite finishes, and by the sweep. A review already out leaves CI alone:
 * its verdict decides what's next.
 */
export async function reviewGate(deps: Deps, input: IssueRef & Acting, currentLabels: string[]): Promise<CoordinateResult> {
  if ((await deps.getPendingFire())?.run === ROUTINES.REVIEW_LOOP) return { outcome: "no_event" };
  const facts = await deps.getMergeGateFacts(input.owner, input.repo, input.issueNumber);
  // No checks yet is "CI hasn't started", not "CI passed": a PR labelled the
  // moment it opens would otherwise be reviewed before CI ran.
  if (facts.checkRuns.length === 0 || facts.checkRuns.some((c) => c.status !== "completed")) return { outcome: "no_event" };
  if (failedCheckNames(facts).length > 0) return handReviewToRework(deps, input, currentLabels, facts);
  return applyEvent(deps, input, EVENTS.REVIEW_CI_PASSED, currentLabels);
}

/** CI red under AI_REVIEWING: rework-loop fixes it (its push comes back to
 * AI_REVIEWING), up to caps.ciFixAttempts, then AI_STUCK. */
async function handReviewToRework(
  deps: Deps,
  input: IssueRef & Acting,
  currentLabels: string[],
  facts: MergeGateFacts,
): Promise<CoordinateResult> {
  const failed = failedCheckNames(facts).join(", ");
  const attempts = (await deps.getCiFix())?.attempts ?? 0;
  if (attempts >= deps.caps.ciFixAttempts) {
    return capReview(deps, input, currentLabels, `CI is still failing after ${attempts} fix attempts (${failed})`);
  }
  const result = await applyEvent(deps, input, EVENTS.REVIEW_CI_FAILED, currentLabels);
  if (result.outcome === "applied") {
    await deps.setCiFix({ attempts: attempts + 1, pending: true, returnTo: LABELS.AI_REVIEWING });
    if (deps.enforced(EVENTS.REVIEW_CI_FAILED)) await deps.recordStatus(input, { kind: "rework", count: attempts + 1 });
    await depsFor(deps, EVENTS.REVIEW_CI_FAILED).io.commentOnIssue(
      input.owner,
      input.repo,
      input.issueNumber,
      `🔧 CI failing: ${failed}. Handing this to rework-loop to fix before the review (attempt ${attempts + 1} of ` +
        `${deps.caps.ciFixAttempts}); \`${LABELS.AI_REVIEWING}\` comes back when it pushes the fix. (Automatic, from the orchestrator.)`,
    );
  }
  return result;
}

/** review-loop found things to fix: a round for rework-loop, counted per PR,
 * up to caps.botReviewReworks, then AI_STUCK. */
export async function reviewFindings(deps: Deps, input: IssueRef & Acting, currentLabels: string[]): Promise<CoordinateResult> {
  const rounds = ((await deps.getReviewLoop())?.botRounds ?? 0) + 1;
  const cap = deps.caps.botReviewReworks;
  if (rounds > cap) {
    return capReview(deps, input, currentLabels, `the review has asked for changes ${rounds - 1} times, the most it's given (${cap})`);
  }
  const result = await applyEvent(deps, input, EVENTS.REVIEW_FINDINGS, currentLabels);
  if (result.outcome === "applied") {
    await deps.setReviewLoop({ botRounds: rounds, fixPending: true });
    await depsFor(deps, EVENTS.REVIEW_FINDINGS).io.commentOnIssue(
      input.owner,
      input.repo,
      input.issueNumber,
      `🔍 Review round ${rounds} of ${cap} found things to fix: handing them to rework-loop; ` +
        `\`${LABELS.AI_REVIEWING}\` comes back when it pushes. (Automatic, from the orchestrator.)`,
    );
  }
  return result;
}

/** AI_REVIEWING -> AI_STUCK (the table's REWORK_CAP_REACHED rule), saying why. */
async function capReview(deps: Deps, input: IssueRef & Acting, currentLabels: string[], why: string): Promise<CoordinateResult> {
  const result = await applyEvent(deps, input, EVENTS.REWORK_CAP_REACHED, currentLabels);
  if (result.outcome === "applied") {
    await depsFor(deps, EVENTS.REWORK_CAP_REACHED).io.commentOnIssue(
      input.owner,
      input.repo,
      input.issueNumber,
      `🛑 Stopping: ${why}, so it's moved to \`${LABELS.AI_STUCK}\` for a person to look at. ` +
        `Re-add \`${LABELS.AI_REVIEWING}\` to try again; that starts fresh counts. (Automatic, from the orchestrator.)`,
    );
  }
  return result;
}
