// A routine's direct signal: a heartbeat extends the watchdog; a completion
// is its outcome, applied like the outcome's comment; blocked is said once
// on the item; ended is an expiry, at once.

import { parseRoutineSignal, type RoutineSignal, type RoutineUpdate } from "@orchestrator/graph/routines/from-routine";
import { type Event } from "@orchestrator/graph/constants/events";
import { depsFor, type CoordinateResult, type Deps, type PendingFire } from "./types";
import { coordinateWebhook } from "./webhook";
import { alreadyApplied, logDeduped } from "./outcome-dedupe";
import { blockedKey, expirePendingFire, recoverOrRetry, type WatchdogResult } from "./watchdog";

// tokenId: the id of the fire token the signal came with (index.ts), checked
// by the DO against the latest fire's; absent for a heartbeat on the shared secret.
export type RoutineSignalInput = { owner: string; repo: string; signal: RoutineSignal; tokenId?: string };

export type RoutineSignalResult =
  | { outcome: "stale_fire" } // from an earlier run's token: not this fire's, so not acted on
  | { outcome: "invalid_signal" }
  | { outcome: "no_pending_fire" } // nothing running for this issue right now — a stray/late signal, harmless
  | { outcome: "mismatched_routine"; expected: string; got: string } // a different routine currently owns this issue
  | { outcome: "heartbeat_extended" }
  // The completion went through the webhook path: `result` is what it did
  // there (applied, deduped by its comment, dropped, …).
  | { outcome: "completion_acknowledged"; result: CoordinateResult }
  | { outcome: "deduped" } // its comment already applied this outcome, and the fire is over
  | { outcome: "blocked_noted" }
  | { outcome: "blocked_already_noted" } // said once per fire
  | { outcome: "ended_expired"; result: CoordinateResult }
  // ended, but the watchdog's own first steps took it: an outcome comment
  // recovered, or the run fired once more.
  | { outcome: "ended_handled"; result: WatchdogResult };

/**
 * The direct routine-to-DO channel — see graph/routines/from-routine.ts's
 * header for the four kinds. A completion is applied through the same
 * translate() -> reduce() path as the outcome's comment (it goes through
 * coordinateWebhook, as a comment the routine itself reported), and
 * whichever of the two comes second is a logged no-op (outcome-dedupe.ts).
 * Either alone is enough, so losing one costs nothing.
 */
export async function coordinateRoutineSignal(
  deps: Deps,
  input: RoutineSignalInput,
): Promise<RoutineSignalResult> {
  const update = parseRoutineSignal(input.signal);
  if (!update) {
    if (input.signal?.kind === "completion") await logInvalidCompletion(deps, input);
    return { outcome: "invalid_signal" };
  }

  const pending = await deps.getPendingFire();
  // A fire waiting out a rate limit has no run yet: a signal can only be from
  // an earlier run of the same routine, and must not clear or extend it.
  const live = pending && pending.deferUntil === undefined ? pending : null;
  if (!live || live.run !== update.routine) {
    if (update.kind === "completion") {
      const reported = { routine: update.routine, outcome: update.outcome.outcome };
      // Its comment got here first and the fire is over (or the next run's).
      if (await alreadyApplied(deps, reported, live)) {
        await logDeduped(deps, { owner: input.owner, repo: input.repo, issueNumber: update.issue, actor: "routine-signal" }, reported);
        return { outcome: "deduped" };
      }
      // A rule ended the fire first (the loop unlabels before it reports):
      // the completion is still this run's, and applies against that fire.
      const ended = live ? null : await deps.getEndedFire();
      if (ended && ended.run === update.routine) return applyCompletion(deps, ended, update, false);
    }
    const result = live
      ? ({ outcome: "mismatched_routine", expected: live.run, got: update.routine } as const)
      : ({ outcome: "no_pending_fire" } as const);
    // Dropped for good if the comment's webhook is lost too: leave a row.
    if (update.kind === "completion") {
      await logNotApplied(
        deps,
        { owner: input.owner, repo: input.repo, issueNumber: update.issue, run: update.routine },
        update.outcome.outcome,
        live ? `mismatched_routine: ${live.run}` : "no_pending_fire",
      );
    }
    return result;
  }

  switch (update.kind) {
    case "process": {
      // Records the step (so an expiry can quote it) and, because the DO's
      // setPendingFire always re-schedules the alarm, extends the watchdog.
      const at = new Date().toISOString();
      await deps.setPendingFire({ ...live, lastStep: update.step, lastStepAt: at });
      await deps.recordStatus(live, { kind: "step", step: update.step, at });
      return { outcome: "heartbeat_extended" };
    }
    case "completion":
      return applyCompletion(deps, live, update, true);
    case "blocked":
      return noteBlocked(deps, live, update.detail);
    case "ended": {
      // As at the watchdog's expiry: an outcome comment posted whose webhook
      // was lost is applied, and a run that never started is fired once more.
      const handled = await recoverOrRetry(deps, live);
      if (handled) return { outcome: "ended_handled", result: handled };
      return {
        outcome: "ended_expired",
        result: await expirePendingFire(
          deps,
          live,
          (next) =>
            `⚠️ The \`${live.run}\` routine's session ended without reporting an outcome: \`${quote(update.detail)}\`.${next} ` +
            `(Automatic, from the orchestrator.)`,
          "routine-signal",
        ),
      };
    }
  }
}

/**
 * The completion, as the comment it stands for: an outcome comment the
 * routine reported, through coordinateWebhook (so every outcome's own
 * handling applies: the review hand-off, the release merge, the caps). Its
 * delivery id is the fire and the outcome, so a resent signal is a
 * duplicate delivery. Applied, and the fire still this one (its rule fired
 * nothing new), the watch ends here; not applied, the watchdog stays armed.
 */
async function applyCompletion(
  deps: Deps,
  pending: PendingFire,
  update: Extract<RoutineUpdate, { kind: "completion" }>,
  stillPending: boolean,
): Promise<RoutineSignalResult> {
  const body = `<!-- agent-outcome:${pending.run} -->\n\`\`\`json\n${JSON.stringify(update.outcome)}\n\`\`\``;
  const result = await coordinateWebhook(deps, {
    deliveryId: `routine-signal:${pending.run}:${pending.firedAt ?? "unknown"}:${update.outcome.outcome}`,
    owner: pending.owner,
    repo: pending.repo,
    issueNumber: pending.issueNumber,
    actor: "routine-signal",
    payload: {
      action: "issue_comment.created",
      sender: { login: "routine-signal", type: "Bot" },
      comment: { body, user_type: "Bot" },
      issue: { state: "open", is_pr: false },
    },
  });
  // Not applied (dropped, …): nothing moved on, so the watchdog stays armed
  // and still decides, and the outcome's comment can still apply. The
  // rejection is a row, so an expiry later isn't read as a run that died.
  if (result.outcome !== "applied") {
    if (result.outcome !== "deduped") await logNotApplied(deps, pending, update.outcome.outcome, result.outcome);
    return { outcome: "completion_acknowledged", result };
  }
  // Applied: the rule has usually cleared or replaced the fire already (and
  // written the status row for it, which "done" would overwrite, and for a
  // new run, wrongly). Only a fire still this one is cleared here, and shown
  // done. The run is marked completed unless the rule fired a new one: a new
  // fire clears the mark, and re-setting it would hide that run from the sweep.
  let now = await deps.getPendingFire();
  if (stillPending && now && now.run === pending.run && now.dueAt === pending.dueAt && now.firedAt === pending.firedAt) {
    await deps.clearPendingFire();
    await deps.recordStatus(pending, { kind: "done" });
    now = null;
  }
  if (!now) await deps.markCompleted(new Date().toISOString());
  return { outcome: "completion_acknowledged", result };
}

/**
 * The run is waiting on a permission prompt nobody is there to answer. Said
 * once per fire, on the item; the step is recorded on its status row. No
 * label moves and the watchdog is left as it is: it still decides.
 */
async function noteBlocked(deps: Deps, pending: PendingFire, detail: string): Promise<RoutineSignalResult> {
  const key = blockedKey(pending);
  if (await deps.hasSeenDelivery(key)) return { outcome: "blocked_already_noted" };
  // The record first (it is also what stops a retry of a run that started):
  // a comment that fails to post must not leave no trace of the block.
  await deps.markSeenDelivery(key);
  await deps.recordStatus(pending, { kind: "step", step: `blocked: ${quote(detail)}`, at: new Date().toISOString() });
  const { io, mode } = depsFor(deps, "routine_blocked" as Event);
  await deps.logTransition({
    deliveryId: null,
    actor: "routine-signal",
    owner: pending.owner,
    repo: pending.repo,
    issueNumber: pending.issueNumber,
    fromState: "none",
    event: "routine_blocked",
    toEffect: JSON.stringify({ kind: "noop", detail: quote(detail) }),
    run: pending.run,
    droppedReason: null,
    mode,
  });
  try {
    await io.commentOnIssue(
      pending.owner,
      pending.repo,
      pending.issueNumber,
      `⏸️ \`${pending.run}\` is waiting for a permission it can't get unattended: \`${quote(detail)}\`. ` +
        `Approve it in the session, or add an allow rule. (Automatic, from the orchestrator.)`,
    );
  } catch (e) {
    console.error("blocked comment failed:", e instanceof Error ? e.message : e);
  }
  return { outcome: "blocked_noted" };
}

/** A completion the webhook path didn't apply: durable, so it shows on the
 * dashboard and in the audit rather than only in a console. */
async function logNotApplied(
  deps: Deps,
  pending: Pick<PendingFire, "owner" | "repo" | "issueNumber" | "run">,
  outcome: string,
  result: string,
): Promise<void> {
  await deps.logTransition({
    deliveryId: null,
    actor: "routine-signal",
    owner: pending.owner,
    repo: pending.repo,
    issueNumber: pending.issueNumber,
    fromState: "none",
    event: outcome,
    toEffect: null,
    run: pending.run,
    droppedReason: `completion not applied: ${result}`,
    mode: depsFor(deps, outcome as Event).mode,
  });
}

/** A completion whose outcome isn't one the catalog knows: logged, nothing
 * else. The outcome's comment, if it's valid, can still apply. */
async function logInvalidCompletion(deps: Deps, input: RoutineSignalInput): Promise<void> {
  const signal = input.signal as Extract<RoutineSignal, { kind: "completion" }>;
  if (typeof signal.issue !== "number") return;
  const shown = JSON.stringify(signal.outcome ?? null) ?? "undefined";
  await deps.logTransition({
    deliveryId: null,
    actor: "routine-signal",
    owner: input.owner,
    repo: input.repo,
    issueNumber: signal.issue,
    fromState: "none",
    event: "completion_invalid",
    toEffect: null,
    run: typeof signal.routine === "string" ? signal.routine : null,
    droppedReason: `completion's outcome failed validation: ${shown.slice(0, 300)}`,
    mode: depsFor(deps, "completion_invalid" as Event).mode,
  });
}

/** A routine's own text, one line in backticks: no backticks of its own, and short. */
function quote(text: string): string {
  return text.replace(/[`\r\n]+/g, " ").trim().slice(0, 300);
}
