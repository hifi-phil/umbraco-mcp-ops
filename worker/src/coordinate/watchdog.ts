// The watchdog's expiry, as a real event through the same path as a
// webhook.

import { LABELS } from "@orchestrator/graph/constants/labels";
import { reduce } from "@orchestrator/graph/graph";
import { EVENTS } from "@orchestrator/graph/constants/events";
import { depsFor, type CoordinateResult, type Deps, type PendingFire } from "./types";
import { applyEvent, deriveState, fireUnwatched, fireWatched } from "./apply";

export type WatchdogResult =
  | { outcome: "no_pending_fire" }
  | { outcome: "not_due"; dueAt: number }
  | { outcome: "retried"; run: string }
  | { outcome: "deferred_fire_sent"; run: string }
  | CoordinateResult;

// An alarm can be invoked a little before its time is reached; a pending
// fire due within this margin counts as due. Capped at half the timeout, so
// a short (e2e) watchdog still tells a just-replaced fire from a due one.
const WATCHDOG_DUE_MARGIN_MS = 60_000;
/**
 * The watchdog's expiry, as a real event through the same reduce() ->
 * labelOps() -> log path as any webhook — so a dead routine moves the issue
 * to {@link LABELS.AI_STUCK} and leaves a D1 row, instead of only a comment.
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

  // A fire the routines API rate-limited (apply.ts's deferFire): send it now.
  // Rate-limited again, it defers itself again. Any other refusal has already
  // cleared the pending fire (so the alarm's retry finds nothing to send): it's
  // said on the issue, where a person looks, and rethrown.
  if (pending.deferUntil !== undefined) {
    const { deferUntil: _deferred, unwatched, dueAt: _due, ...ref } = pending;
    try {
      if (unwatched) await fireUnwatched(deps, ref, ref.run);
      else await fireWatched(deps, ref, ref.run, ref.retried ? { retried: true } : {});
    } catch (e) {
      await reportDeferredFireFailed(deps, pending, e);
      throw e;
    }
    return { outcome: "deferred_fire_sent", run: pending.run };
  }

  // Once, a run that never reported a single step is fired again instead of
  // going to LABELS.AI_STUCK: it died before doing anything (a session that
  // was refused or never started), so a second run can't duplicate its work,
  // and a one-off failure costs minutes, not a person. A run that reported
  // progress may have pushed half its work: that goes to a person, as before.
  // Only for a repo that turned it on (deps.watchdogRetry): "never reported a
  // step" only means "never started" where the routines send heartbeats.
  if (deps.watchdogRetry && !pending.retried && !pending.lastStep && deps.enforced(EVENTS.WATCHDOG_EXPIRED)) {
    const labels = await deps.getLabels(pending.owner, pending.repo, pending.issueNumber);
    const state = deriveState(labels);
    if (state !== "ambiguous" && reduce(state, EVENTS.WATCHDOG_EXPIRED) !== null) {
      const retried = await retryOnce(deps, pending);
      if (retried) return retried;
    }
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

/** The one re-fire (see coordinateWatchdogExpired): watched again, marked so
 * a second silent expiry goes to LABELS.AI_STUCK. Null if the fire itself is
 * refused, so the expiry carries on as usual. */
async function retryOnce(deps: Deps, pending: PendingFire): Promise<WatchdogResult | null> {
  const minutes = deps.watchdogMinutes(pending.run);
  try {
    await fireWatched(deps, pending, pending.run, { retried: true });
  } catch (e) {
    console.error("watchdog retry fire failed:", e instanceof Error ? e.message : e);
    return null;
  }
  await deps.commentOnIssue(
    pending.owner,
    pending.repo,
    pending.issueNumber,
    `🔁 The \`${pending.run}\` routine didn't report anything within ${minutes} minutes, so it never got started. ` +
      `Firing it once more; if that run is silent too, this moves to \`${LABELS.AI_STUCK}\`. (Automatic, from the orchestrator.)`,
  );
  await deps.logTransition({
    deliveryId: null,
    owner: pending.owner,
    repo: pending.repo,
    issueNumber: pending.issueNumber,
    fromState: "none",
    event: "watchdog_retried",
    actor: "watchdog",
    toEffect: JSON.stringify({ kind: "noop" }),
    run: pending.run,
    droppedReason: null,
    mode: "enforce",
  });
  await deps.recordStatus(pending, { kind: "transition", state: "none", run: pending.run, running: true });
  return { outcome: "retried", run: pending.run };
}

/** A deferred fire refused at its alarm for any reason but the rate limit:
 * nothing is running and nothing is armed, so tell the person who was told
 * "nothing to do". Reporting never masks the refusal: its own errors are only logged. */
async function reportDeferredFireFailed(deps: Deps, pending: PendingFire, e: unknown): Promise<void> {
  const reason = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  try {
    await deps.commentOnIssue(
      pending.owner,
      pending.repo,
      pending.issueNumber,
      `⚠️ The \`${pending.run}\` routine was waiting out a rate limit, but couldn't start when its time came: the routines API refused it (\`${reason}\`). ` +
        `Nothing is running for this. Re-add the label that started it to try again. (Automatic, from the orchestrator.)`,
    );
  } catch (report) {
    console.error("deferred-fire failure comment failed:", report instanceof Error ? report.message : report);
  }
}
