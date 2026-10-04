// The merge gate's two outcomes when AUTO_MERGING is on: a hard block
// (MERGE_BLOCKED) or CI failing, handed to rework-loop up to
// caps.ciFixAttempts times; and the settled facts both read.

import { LABELS } from "@orchestrator/graph/constants/labels";
import { failedCheckNames, type MergeGateFacts } from "@orchestrator/graph/github/merge-gate";
import { EVENTS } from "@orchestrator/graph/constants/events";
import { depsFor, type Acting, type CoordinateResult, type Deps, type IssueRef } from "./types";
import { applyEvent } from "./apply";

/** CI failed under AUTO_MERGING: swap AUTO_MERGING -> AUTO_REWORKING so
 * rework-loop fixes it (its push swaps back to AUTO_MERGING), up to
 * caps.ciFixAttempts per PR, then MERGE_BLOCKED. */
export async function handToRework(
  deps: Deps,
  input: IssueRef & Acting,
  currentLabels: string[],
  facts: MergeGateFacts,
): Promise<CoordinateResult> {
  const failed = failedCheckNames(facts).join(", ") || "a required check";
  const attempts = (await deps.getCiFix())?.attempts ?? 0;
  if (attempts >= deps.caps.ciFixAttempts) {
    return blockMerge(deps, input, currentLabels, `CI still failing after ${attempts} fix attempts (${failed})`);
  }
  const result = await applyEvent(deps, input, EVENTS.MERGE_GATE_FAILED_SOFT, currentLabels);
  if (result.outcome === "applied") {
    // A MERGE_BLOCKED PR's retry (AUTO_MERGING re-added, read as AUTO_MERGING):
    // the rule swaps only AUTO_MERGING, so MERGE_BLOCKED comes off here, or
    // MERGE_BLOCKED + AUTO_REWORKING would read as ambiguous from then on.
    if (currentLabels.includes(LABELS.MERGE_BLOCKED)) {
      await depsFor(deps, EVENTS.MERGE_GATE_FAILED_SOFT).io.removeLabel(input.owner, input.repo, input.issueNumber, LABELS.MERGE_BLOCKED);
    }
    await deps.setCiFix({ attempts: attempts + 1, pending: true });
    if (deps.enforced(EVENTS.MERGE_GATE_FAILED_SOFT)) await deps.recordStatus(input, { kind: "rework", count: attempts + 1 });
    await depsFor(deps, EVENTS.MERGE_GATE_FAILED_SOFT).io.commentOnIssue(
      input.owner,
      input.repo,
      input.issueNumber,
      `🔧 CI failing: ${failed}. Handing this to rework-loop to fix (attempt ${attempts + 1} of ` +
        `${deps.caps.ciFixAttempts}); \`${LABELS.AUTO_MERGING}\` comes back when it pushes the fix. ` +
        `(Automatic, from the orchestrator's merge gate.)`,
    );
  }
  return result;
}

/** GitHub computes `mergeable` in the background, so right after a push it
 * reads null. Re-read a couple of times before deciding; if it's still
 * null, hardBlockReason treats that as "no conflict known". */
export async function settledGateFacts(deps: Deps, input: IssueRef): Promise<MergeGateFacts> {
  let facts = await deps.getMergeGateFacts(input.owner, input.repo, input.issueNumber);
  for (let i = 0; i < MERGEABLE_RETRIES && facts.mergeable === null; i++) {
    await new Promise((r) => setTimeout(r, MERGEABLE_RETRY_MS));
    facts = await deps.getMergeGateFacts(input.owner, input.repo, input.issueNumber);
  }
  return facts;
}

export const MERGEABLE_RETRIES = 2;
export const MERGEABLE_RETRY_MS = 1000;

/** AUTO_MERGING -> MERGE_BLOCKED (the table's MERGE_GATE_FAILED_HARD rule),
 * plus a comment saying why, since the label alone doesn't. */
export async function blockMerge(
  deps: Deps,
  input: IssueRef & Acting,
  currentLabels: string[],
  reason: string,
): Promise<CoordinateResult> {
  const result = await applyEvent(deps, input, EVENTS.MERGE_GATE_FAILED_HARD, currentLabels);
  if (result.outcome === "applied") {
    await depsFor(deps, EVENTS.MERGE_GATE_FAILED_HARD).io.commentOnIssue(
      input.owner,
      input.repo,
      input.issueNumber,
      `🛑 Not merging: ${reason}. \`${LABELS.AUTO_MERGING}\` is replaced by \`${LABELS.MERGE_BLOCKED}\`. ` +
        `Fix it, then re-add \`${LABELS.AUTO_MERGING}\` to try again. (Automatic, from the orchestrator's merge gate.)`,
    );
  }
  return result;
}
