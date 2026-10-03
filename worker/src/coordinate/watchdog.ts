// The watchdog's expiry, as a real event through the same path as a
// webhook.

import { LABELS } from "@orchestrator/graph/constants/labels";
import { reduce } from "@orchestrator/graph/graph";
import { EVENTS } from "@orchestrator/graph/constants/events";
import { depsFor, type CoordinateResult, type Deps } from "./types";
import { applyEvent, deriveState } from "./apply";

export type WatchdogResult = { outcome: "no_pending_fire" } | { outcome: "not_due"; dueAt: number } | CoordinateResult;

// An alarm can be invoked a little before its time is reached; a pending
// fire due within this margin counts as due. Capped at half the timeout, so
// a short (e2e) watchdog still tells a just-replaced fire from a due one.
const WATCHDOG_DUE_MARGIN_MS = 60_000;
/**
 * The watchdog's expiry, as a real event through the same reduce() ->
 * labelOps() -> log path as any webhook — so a dead routine moves the issue
 * to ai-stuck and leaves a D1 row, instead of only a comment.
 *
 * Ordering is for the DO's at-least-once alarm retries (a throwing alarm()
 * is retried with backoff): pendingFire is cleared LAST, so a failure
 * anywhere before it leaves the retry something to act on. The cost is a
 * possible duplicate comment on a retry, never a silently lost alert.
 */
export async function coordinateWatchdogExpired(deps: Deps, now = Date.now()): Promise<WatchdogResult> {
  const pending = await deps.getPendingFire();
  if (!pending) return { outcome: "no_pending_fire" };
  // The alarm started, then something queued ahead of it (a heartbeat, or
  // the sweep re-firing a run it took for lost) replaced the pending fire
  // and armed a new alarm: this one isn't for it. Leave that alarm alone.
  const margin = Math.min(WATCHDOG_DUE_MARGIN_MS, (deps.watchdogMinutes(pending.run) * 60_000) / 2);
  if (pending.dueAt !== undefined && now < pending.dueAt - margin) {
    return { outcome: "not_due", dueAt: pending.dueAt };
  }

  const lastStep = pending.lastStep
    ? ` Last reported step: \`${pending.lastStep}\` (${pending.lastStepAt ?? "time unknown"}).`
    : " No progress step was ever reported.";
  const currentLabels = await deps.getLabels(pending.owner, pending.repo, pending.issueNumber);
  const state = deriveState(currentLabels);
  const willStick = state !== "ambiguous" && reduce(state, EVENTS.WATCHDOG_EXPIRED) !== null;
  const next = willStick
    ? ` Moving this to \`${LABELS.AI_STUCK}\`; re-add the trigger label to retry.`
    : ` Its current labels don't allow an automatic move to \`${LABELS.AI_STUCK}\` — needs a human look.`;
  // The alert is a write too: only real when watchdog_expired is enforced.
  await depsFor(deps, EVENTS.WATCHDOG_EXPIRED).io.commentOnIssue(
    pending.owner,
    pending.repo,
    pending.issueNumber,
    `⚠️ The \`${pending.run}\` routine hasn't reported back within ${deps.watchdogMinutes(pending.run)} minutes — it may have died mid-run.${lastStep}${next} ` +
      `This comment is automatic; see docs/agent-orchestration/03-components.md §3.4.`,
  );

  const result = await applyEvent(deps, { ...pending, actor: "watchdog" }, EVENTS.WATCHDOG_EXPIRED, currentLabels);
  await deps.clearPendingFire();
  // The watch is over either way: a shadow watchdog or labels with no expiry
  // rule leave the row alone above, and nothing else would stop it reading
  // "running" (a late completion finds no pending fire).
  await deps.recordStatus(pending, { kind: "done" });
  return result;
}
