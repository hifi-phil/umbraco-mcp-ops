// A routine's direct signal: a heartbeat extends the watchdog; a completion
// is its outcome, applied like the outcome's comment; blocked is said once
// on the item; ended is an expiry, at once.

import { parseRoutineSignal, type RoutineSignal, type RoutineUpdate } from "@orchestrator/graph/routines/from-routine";
import { type Event } from "@orchestrator/graph/constants/events";
import { depsFor, type CoordinateResult, type Deps, type PendingFire } from "./types";
import { coordinateWebhook } from "./webhook";
import { alreadyApplied, logDeduped } from "./outcome-dedupe";
import { expirePendingFire, recoverOrRetry, type WatchdogResult } from "./watchdog";

export type RoutineSignalInput = { owner: string; repo: string; signal: RoutineSignal };

export type RoutineSignalResult =
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
    // Its comment got here first and the fire is over (or the next run's).
    if (update.kind === "completion") {
      const reported = { routine: update.routine, outcome: update.outcome.outcome };
      if (await alreadyApplied(deps, reported, live)) {
        await logDeduped(deps, { owner: input.owner, repo: input.repo, issueNumber: update.issue, actor: "routine-signal" }, reported);
        return { outcome: "deduped" };
      }
    }
    if (!live) return { outcome: "no_pending_fire" };
    return { outcome: "mismatched_routine", expected: live.run, got: update.routine };
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
      return applyCompletion(deps, live, update);
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
  // Not applied (deduped, dropped, …): nothing moved on, so the watchdog stays
  // armed and still decides, and the outcome's comment can still apply.
  if (result.outcome !== "applied") {
    console.warn(`routine-signal: ${pending.run}'s ${update.outcome.outcome} on #${pending.issueNumber} not applied (${result.outcome})`);
    return { outcome: "completion_acknowledged", result };
  }
  const now = await deps.getPendingFire();
  if (now && now.run === pending.run && now.dueAt === pending.dueAt && now.firedAt === pending.firedAt) {
    await deps.clearPendingFire();
    await deps.markCompleted(new Date().toISOString());
    await deps.recordStatus(pending, { kind: "done" });
  }
  return { outcome: "completion_acknowledged", result };
}

/**
 * The run is waiting on a permission prompt nobody is there to answer. Said
 * once per fire, on the item; the step is recorded on its status row. No
 * label moves and the watchdog is left as it is: it still decides.
 */
async function noteBlocked(deps: Deps, pending: PendingFire, detail: string): Promise<RoutineSignalResult> {
  const key = `routine-blocked:${pending.run}:${pending.firedAt ?? "unknown"}`;
  if (await deps.hasSeenDelivery(key)) return { outcome: "blocked_already_noted" };
  const { io, mode } = depsFor(deps, "routine_blocked" as Event);
  await io.commentOnIssue(
    pending.owner,
    pending.repo,
    pending.issueNumber,
    `⏸️ \`${pending.run}\` is waiting for a permission it can't get unattended: \`${quote(detail)}\`. ` +
      `Approve it in the session, or add an allow rule. (Automatic, from the orchestrator.)`,
  );
  await deps.markSeenDelivery(key);
  await deps.recordStatus(pending, { kind: "step", step: `blocked: ${quote(detail)}`, at: new Date().toISOString() });
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
  return { outcome: "blocked_noted" };
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
