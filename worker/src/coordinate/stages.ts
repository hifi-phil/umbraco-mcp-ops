// The issue's stages after its PR: the hand-offs from one item to another.
// A merged PR tells each issue its description closes (pr_merged, with the
// merge commit); a published release tells each issue waiting for one
// (released, with the version), and the issue closes if the release's tag
// contains its merge.

import { LABELS } from "@orchestrator/graph/constants/labels";
import { EVENTS } from "@orchestrator/graph/constants/events";
import { closingIssues } from "@orchestrator/graph/github/closing-refs";
import { type CoordinateInput, type CoordinateResult, type Deps } from "./types";
import { applyEvent, deriveState } from "./apply";

/** A delivery id for a hand-off: the original's, plus the item it's for, so
 * each item dedupes a redelivery of the original on its own. */
const handOffId = (deliveryId: string, issueNumber: number) => `${deliveryId || "worker"}:#${issueNumber}`;

/** A PR merged: pr_merged to each issue its description closes. */
export async function handOffMerged(deps: Deps, input: CoordinateInput): Promise<void> {
  const pr = input.payload.pull_request;
  if (!pr?.merged || !pr.merge_commit_sha) return;
  for (const issueNumber of closingIssues(pr.body).filter((n) => n !== input.issueNumber)) {
    await deps.forward(
      { owner: input.owner, repo: input.repo, issueNumber },
      { action: "orchestrator.pr_merged", shipped: { pr: input.issueNumber, sha: pr.merge_commit_sha } },
      handOffId(input.deliveryId, issueNumber),
    );
  }
}

/** A release published: released to each open issue waiting for one, with
 * the tag the release reported (no naming convention assumed). */
export async function handOffRelease(deps: Deps, input: CoordinateInput, version: string, tag: string): Promise<void> {
  for (const issueNumber of await deps.openWithLabel(input.owner, input.repo, LABELS.READY_FOR_RELEASE)) {
    await deps.forward(
      { owner: input.owner, repo: input.repo, issueNumber },
      { action: "orchestrator.released", release: { version, tag } },
      handOffId(input.deliveryId, issueNumber),
    );
  }
}

/** The issue's PR merged: the stage, and the merge commit a release is checked against. */
export async function prMerged(deps: Deps, input: CoordinateInput, currentLabels: string[]): Promise<CoordinateResult> {
  const result = await applyEvent(deps, input, EVENTS.PR_MERGED, currentLabels);
  if (result.outcome === "applied" && input.payload.shipped) await deps.setShipped(input.payload.shipped);
  return result;
}

/** A release was published: closed only if its tag contains this issue's
 * merge. A merge after the release branch was cut waits for the next. */
export async function released(deps: Deps, input: CoordinateInput, currentLabels: string[]): Promise<CoordinateResult> {
  const tag = input.payload.release?.tag;
  const shipped = await deps.getShipped();
  const contained = !!tag && !!shipped && (await deps.commitInRef(input.owner, input.repo, shipped.sha, tag));
  if (!contained) return { outcome: "ignored", from: stateOf(currentLabels), event: EVENTS.RELEASED };
  return applyEvent(deps, input, EVENTS.RELEASED, currentLabels);
}

const stateOf = (labels: string[]) => {
  const state = deriveState(labels);
  return state === "ambiguous" ? "none" : state;
};
