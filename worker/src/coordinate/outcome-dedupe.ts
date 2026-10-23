// One outcome, two carriers: a routine's completion signal and its outcome
// comment's webhook. Whichever arrives first applies; the second finds the
// AppliedOutcome it left and is a logged no-op ("deduped"), not a rule miss.

import { parseOutcomeArtifact, type WebhookPayload } from "@orchestrator/graph/github/from-github";
import { type Event } from "@orchestrator/graph/constants/events";
import { actorOf, depsFor, type CoordinateInput, type CoordinateResult, type Deps, type IssueRef, type Acting, type PendingFire } from "./types";
import { deriveState } from "./apply";

/** The routine an outcome comment names (plugins/agent-outcomes's marker). */
export const OUTCOME_ROUTINE_PATTERN = /<!-- agent-outcome:([a-zA-Z0-9_-]+) -->/;

/** A routine's reported outcome: which routine, and the outcome's name. */
export type ReportedOutcome = { routine: string; outcome: string };

/** The outcome an outcome comment's webhook carries, or null for any other payload. */
export function reportedOutcome(payload: WebhookPayload): ReportedOutcome | null {
  if (payload.action !== "issue_comment.created") return null;
  const outcome = parseOutcomeArtifact(payload.comment?.body);
  const routine = payload.comment?.body.match(OUTCOME_ROUTINE_PATTERN)?.[1];
  return outcome && routine ? { routine, outcome: outcome.outcome } : null;
}

/**
 * Whether this outcome was already applied for the fire it belongs to: the
 * same routine and outcome, and no newer fire of that routine pending (a new
 * fire also clears the record: apply.ts's forgetAppliedOutcome).
 */
export async function alreadyApplied(deps: Deps, reported: ReportedOutcome, pending: PendingFire | null): Promise<boolean> {
  const applied = await deps.getAppliedOutcome();
  if (!applied || applied.run !== reported.routine || applied.outcome !== reported.outcome) return false;
  return !(pending && pending.run === reported.routine && (pending.firedAt ?? null) !== applied.firedAt);
}

/** Remembers an applied outcome against the fire it ended (the one pending
 * before it applied). An outcome with no fire of its routine pending (a late
 * one, after the watchdog) has nothing to key on and is not remembered. */
export async function rememberApplied(deps: Deps, reported: ReportedOutcome, pending: PendingFire | null): Promise<void> {
  if (!pending || pending.run !== reported.routine || pending.deferUntil !== undefined) return;
  await deps.setAppliedOutcome({ run: pending.run, firedAt: pending.firedAt ?? null, outcome: reported.outcome });
}

/** The second carrier of an applied outcome: a row saying so, nothing else. */
export async function logDeduped(
  deps: Deps,
  input: IssueRef & Acting & Partial<Pick<CoordinateInput, "deliveryId" | "payload">>,
  reported: ReportedOutcome,
): Promise<CoordinateResult> {
  const labels = await deps.getLabels(input.owner, input.repo, input.issueNumber);
  await deps.logTransition({
    deliveryId: input.deliveryId || null,
    actor: actorOf(input),
    owner: input.owner,
    repo: input.repo,
    issueNumber: input.issueNumber,
    fromState: deriveState(labels),
    event: reported.outcome,
    toEffect: null,
    run: reported.routine,
    droppedReason: `deduped: ${reported.routine}'s ${reported.outcome} was already applied for this run`,
    mode: depsFor(deps, reported.outcome as Event).mode,
  });
  return { outcome: "deduped" };
}
