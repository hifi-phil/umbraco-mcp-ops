// The watchdog's expiry, as a real event through the same path as a
// webhook.

import { LABELS } from "@orchestrator/graph/constants/labels";
import { reduce, rules } from "@orchestrator/graph/graph";
import { EVENTS } from "@orchestrator/graph/constants/events";
import { ROUTINES } from "@orchestrator/graph/constants/routines";
import { depsFor, type CoordinateResult, type Deps, type PendingFire } from "./types";
import { coordinateWebhook } from "./webhook";
import { applyEvent, deriveState, fireUnwatched, fireWatched, type FireOutcome } from "./apply";

export type WatchdogResult =
  | { outcome: "no_pending_fire" }
  | { outcome: "not_due"; dueAt: number }
  | { outcome: "retried"; run: string }
  | { outcome: "deferred_fire_sent"; run: string }
  | { outcome: "deferred_fire_dropped"; run: string }
  | { outcome: "deferred_again"; run: string }
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
    const { deferUntil: _deferred, unwatched, dueAt: _due, firedAt: _fired, ...ref } = pending;
    // A person may have taken the issue out of the flow while it waited
    // (removing a label like the discussion one raises no event). A closed issue clears the
    // pending fire in the webhook, so only the labels are checked here.
    // If the labels can't be read, send anyway (as for an ambiguous state):
    // a late run is better than a fire left pending with no alarm behind it.
    let state: ReturnType<typeof deriveState> = "ambiguous";
    try {
      state = deriveState(await deps.getLabels(pending.owner, pending.repo, pending.issueNumber));
    } catch (e) {
      console.error("deferred-fire label check failed:", e instanceof Error ? e.message : e);
    }
    if (!stillWanted(state, pending.run)) {
      try {
        await deps.logTransition({
          deliveryId: null,
          owner: pending.owner,
          repo: pending.repo,
          issueNumber: pending.issueNumber,
          fromState: state,
          event: "deferred_fire_dropped",
          actor: "watchdog",
          toEffect: JSON.stringify({ kind: "noop" }),
          run: pending.run,
          droppedReason: "deferred fire no longer wanted: the issue's labels no longer lead to this run",
          mode: "enforce",
        });
        await deps.commentOnIssue(
          pending.owner,
          pending.repo,
          pending.issueNumber,
          `ℹ️ The \`${pending.run}\` routine was waiting out a rate limit, but isn't being started: this no longer carries the label that asked for it. (Automatic, from the orchestrator.)`,
        );
      } catch (report) {
        console.error("deferred-fire drop report failed:", report instanceof Error ? report.message : report);
      }
      await deps.clearPendingFire();
      await deps.recordStatus(pending, { kind: "done" });
      return { outcome: "deferred_fire_dropped", run: pending.run };
    }
    let fired: FireOutcome;
    try {
      fired = unwatched
        ? await fireUnwatched(deps, ref, ref.run, true)
        : await fireWatched(deps, ref, ref.run, ref.retried ? { retried: true } : {}, true);
    } catch (e) {
      await reportDeferredFireFailed(deps, pending, e);
      // Nothing is running now: end the status row the deferral left waiting.
      try {
        await deps.recordStatus(pending, { kind: "done" });
      } catch (status) {
        console.error("deferred-fire status write failed:", status instanceof Error ? status.message : status);
      }
      throw e;
    }
    if (fired === "deferred") return { outcome: "deferred_again", run: pending.run };
    // Sent: the deferral wrote the row as not running; a watched run now is.
    if (!unwatched && state !== "ambiguous") {
      await deps.recordStatus(pending, { kind: "transition", state, run: pending.run, running: true });
    }
    return { outcome: "deferred_fire_sent", run: pending.run };
  }

  // The run may have finished and posted its outcome, with only the webhook
  // for it lost (#335, #345): apply that before calling the run dead.
  // Only where the watchdog is enforced: recovery writes labels and may fire
  // the next run, which a shadow watchdog must not do.
  if (deps.enforced(EVENTS.WATCHDOG_EXPIRED)) {
    const recovered = await recoverOutcome(deps, pending);
    if (recovered) return recovered;
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

  // A rework started straight from a label has no CI-fix or review state to
  // say its push is still wanted, so the expiry itself is recorded. Before the
  // label write, so a retry after a failure in between still finds it; a
  // shadow or refused expiry moves no label and so takes it back.
  const recordExpiry = pending.run === ROUTINES.REWORK_LOOP && deps.enforced(EVENTS.WATCHDOG_EXPIRED);
  if (recordExpiry) await deps.setReworkExpired(true);
  const result = await applyEvent(deps, { ...pending, actor: "watchdog" }, EVENTS.WATCHDOG_EXPIRED, currentLabels);
  if (recordExpiry && result.outcome !== "applied") await deps.setReworkExpired(false);
  await deps.clearPendingFire();
  // The watch is over either way: a shadow watchdog or labels with no expiry
  // rule leave the row alone above, and nothing else would stop it reading
  // "running" (a late completion finds no pending fire).
  await deps.recordStatus(pending, { kind: "done" });
  return result;
}

const OUTCOME_ROUTINE_PATTERN = /<!-- agent-outcome:([a-zA-Z0-9_-]+) -->/;

/**
 * The watched routine's outcome comment, posted since the fire, whose
 * webhook never got processed: read the comments, newest first, and apply
 * the first one the webhook path would have (same translate and rules), as
 * the watchdog's own event. Null if there is none, or the read fails (the
 * expiry then carries on as before). An outcome from before the fire, or
 * from another routine, is not this run's.
 */
async function recoverOutcome(deps: Deps, pending: PendingFire): Promise<WatchdogResult | null> {
  if (pending.firedAt === undefined) return null;
  const since = new Date(pending.firedAt).toISOString();
  let comments;
  try {
    comments = await deps.commentsSince(pending.owner, pending.repo, pending.issueNumber, since);
  } catch (e) {
    console.error("watchdog outcome recovery read failed:", e instanceof Error ? e.message : e);
    return null;
  }
  for (const comment of [...comments].reverse()) {
    if (Date.parse(comment.createdAt) < pending.firedAt) continue;
    if (comment.body.match(OUTCOME_ROUTINE_PATTERN)?.[1] !== pending.run) continue;
    let result;
    try {
      result = await coordinateWebhook(deps, {
        // Not empty: a refused fire of the next run is only said on the issue
        // (apply.ts's reportRefusedFire) for an event that has a delivery id.
        // Per comment: the webhook path remembers a delivery id it has seen, so
        // one shared id would hand every older outcome back as a duplicate.
        deliveryId: `watchdog-recover:${pending.run}:${pending.firedAt}:${comment.createdAt}`,
        owner: pending.owner,
        repo: pending.repo,
        issueNumber: pending.issueNumber,
        actor: "watchdog",
        payload: {
          action: "issue_comment.created",
          sender: { login: comment.login, type: comment.userType },
          comment: { body: comment.body, author_association: comment.authorAssociation, user_type: comment.userType },
          issue: { state: "open", is_pr: false },
        },
      });
    } catch (e) {
      console.error(
        `watchdog recovery replay failed for ${pending.owner}/${pending.repo}#${pending.issueNumber} (${pending.run}):`,
        e instanceof Error ? e.message : e,
      );
      // Still this fire: nothing took effect, so the expiry carries on as it did
      // before recovery existed (a throw must not skip the stuck alert). Moved
      // on (e.g. the next run's fire was refused and cleared it): the outcome
      // was applied, and expiring or re-firing this finished run would be wrong.
      const now = await deps.getPendingFire();
      if (now?.run === pending.run && now.dueAt === pending.dueAt) return null;
      throw e;
    }
    if (result.outcome !== "applied") {
      console.warn(`watchdog recovery: ${pending.run} outcome comment on #${pending.issueNumber} not applied (${result.outcome})`);
      continue;
    }
    await deps.logTransition({
      deliveryId: null,
      owner: pending.owner,
      repo: pending.repo,
      issueNumber: pending.issueNumber,
      fromState: result.from,
      event: "watchdog_recovered",
      actor: "watchdog",
      toEffect: JSON.stringify({ kind: "noop" }),
      run: pending.run,
      droppedReason: null,
      mode: depsFor(deps, EVENTS.WATCHDOG_EXPIRED).mode,
    });
    // The recovered event may have started the next run: that fire is its own.
    const now = await deps.getPendingFire();
    if (now?.run === pending.run && now.dueAt === pending.dueAt) {
      await deps.clearPendingFire();
      await deps.recordStatus(pending, { kind: "done" });
    }
    return result;
  }
  return null;
}

/** Whether the issue's tracked label is still one that fires `run`: the
 * target of a rule that runs it (or, for a rule that stays put, its source). */
function stillWanted(state: ReturnType<typeof deriveState>, run: string): boolean {
  // Ambiguous is no reason to drop it: nothing would re-fire it later.
  if (state === "ambiguous") return true;
  return rules.some((r) => r.run === run && (r.to.kind === "label" ? r.to.value : r.from) === state);
}

/** The one re-fire (see coordinateWatchdogExpired): watched again, marked so
 * a second silent expiry goes to LABELS.AI_STUCK. Null if the fire itself is
 * refused, so the expiry carries on as usual. */
async function retryOnce(deps: Deps, pending: PendingFire): Promise<WatchdogResult | null> {
  const minutes = deps.watchdogMinutes(pending.run);
  try {
    // Rate-limited: it's pending with its alarm, and already said on the issue.
    if ((await fireWatched(deps, pending, pending.run, { retried: true })) === "deferred") {
      return { outcome: "deferred_again", run: pending.run };
    }
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
    await deps.logTransition({
      deliveryId: null,
      owner: pending.owner,
      repo: pending.repo,
      issueNumber: pending.issueNumber,
      fromState: "none",
      event: "deferred_fire_refused",
      actor: "watchdog",
      toEffect: JSON.stringify({ kind: "noop" }),
      run: pending.run,
      droppedReason: `fire refused: ${reason}`,
      mode: "enforce",
    });
  } catch (report) {
    console.error("deferred-fire log failed:", report instanceof Error ? report.message : report);
  }
  try {
    await deps.commentOnIssue(
      pending.owner,
      pending.repo,
      pending.issueNumber,
      `⚠️ The \`${pending.run}\` routine was waiting out a rate limit, but couldn't start when its time came: the routines API refused it (\`${reason}\`). ` +
        `Nothing is running for this; a person needs to restart it. (Automatic, from the orchestrator.)`,
    );
  } catch (report) {
    console.error("deferred-fire failure comment failed:", report instanceof Error ? report.message : report);
  }
}
