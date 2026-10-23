// One outcome, two carriers: a routine's explicit outcome signal
// (routine-signal.ts) and its outcome comment's webhook. The first to apply
// is remembered against the fire it ended (Deps.setAppliedOutcome); the
// second finds that and is a logged no-op ("deduped"), not a rule miss.

import { parseOutcomeArtifact, type WebhookPayload } from "@orchestrator/graph/github/from-github";
import { type Event } from "@orchestrator/graph/constants/events";
import { actorOf, depsFor, type Acting, type CoordinateInput, type CoordinateResult, type Deps, type IssueRef, type PendingFire } from "./types";
import { deriveState } from "./apply";

/** The routine an outcome comment names (plugins/agent-outcomes's marker). */
export const OUTCOME_ROUTINE_PATTERN = /<!-- agent-outcome:([a-zA-Z0-9_-]+) -->/;

/** An outcome a routine reported: which routine, and the outcome's name. */
export type ReportedOutcome = { routine: string; outcome: string };

/** The outcome an outcome comment's webhook carries, or null for any other payload. */
export function reportedOutcome(payload: WebhookPayload): ReportedOutcome | null {
  if (payload.action !== "issue_comment.created") return null;
  const outcome = parseOutcomeArtifact(payload.comment?.body);
  const routine = payload.comment?.body.match(OUTCOME_ROUTINE_PATTERN)?.[1];
  return outcome && routine ? { routine, outcome: outcome.outcome } : null;
}

/** Whether this routine's outcome was already applied for its fire. The fire
 * ended with its outcome, so it has no pending fire any more; if the routine
 * has one, it is a newer fire, and its outcome is its own. */
export async function alreadyApplied(deps: Deps, reported: ReportedOutcome): Promise<boolean> {
  const applied = await deps.getAppliedOutcome(reported.routine);
  if (!applied || applied.outcome !== reported.outcome) return false;
  const pending = await deps.getPendingFire();
  return !(pending?.run === reported.routine && (pending.firedAt ?? null) !== applied.firedAt);
}

/** Remembers an applied outcome against `pending`, the fire it ended (read
 * before it applied). An outcome with no fire of its routine running (a
 * late one, after the watchdog) has no fire to key on, so isn't remembered.
 * Nor is it when applying it started a newer fire of the same routine. */
export async function rememberApplied(deps: Deps, reported: ReportedOutcome, pending: PendingFire | null): Promise<void> {
  if (!pending || pending.run !== reported.routine || pending.deferUntil !== undefined) return;
  const now = await deps.getPendingFire();
  if (now?.run === reported.routine && (now.firedAt ?? null) !== (pending.firedAt ?? null)) return;
  await deps.setAppliedOutcome(pending.run, { run: pending.run, firedAt: pending.firedAt ?? null, outcome: reported.outcome });
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
