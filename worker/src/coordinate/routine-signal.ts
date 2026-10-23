// A routine's direct signal: a heartbeat extends the watchdog and a
// completion ends it (timing only, never applied); an explicit outcome is
// applied like the outcome's comment; blocked is said once on the item;
// ended is the watchdog's expiry, at once.

import { parseRoutineSignal, type RoutineSignal, type RoutineUpdate } from "@orchestrator/graph/routines/from-routine";
import { EVENTS, type Event } from "@orchestrator/graph/constants/events";
import { depsFor, type CoordinateResult, type Deps, type PendingFire } from "./types";
import { coordinateWebhook } from "./webhook";
import { alreadyApplied, logDeduped } from "./outcome-dedupe";
import { expirePendingFire, recoverOutcome, type WatchdogResult } from "./watchdog";

export type RoutineSignalInput = { owner: string; repo: string; signal: RoutineSignal };

export type RoutineSignalResult =
  | { outcome: "invalid_signal" }
  | { outcome: "no_pending_fire" } // nothing running for this issue right now — a stray/late signal, harmless
  | { outcome: "mismatched_routine"; expected: string; got: string } // a different routine currently owns this issue
  | { outcome: "heartbeat_extended" }
  | { outcome: "completion_acknowledged" }
  // The explicit outcome went through the webhook path: `result` is what it
  // did there (applied, dropped, …).
  | { outcome: "outcome_reported"; result: CoordinateResult }
  | { outcome: "deduped" } // its comment already applied this outcome
  | { outcome: "blocked_noted" }
  | { outcome: "blocked_already_noted" } // said once per fire
  | { outcome: "ended_expired"; result: WatchdogResult }; // the expiry, or an outcome comment recovered first

/**
 * The direct routine-to-DO channel — see graph/routines/from-routine.ts's
 * header for the kinds. Only an explicit "outcome" changes state through
 * reduce(): it goes through coordinateWebhook as the outcome comment it
 * stands for, so every outcome's own handling applies (the review hand-off,
 * the release merge, the caps), and whichever of it and the real comment
 * comes second is a logged no-op (outcome-dedupe.ts). "completion" stays a
 * watchdog-timing optimization: losing one costs a slightly-later alarm.
 * "ended" applies {@link EVENTS.WATCHDOG_EXPIRED} at once, as the alarm would.
 */
export async function coordinateRoutineSignal(
  deps: Deps,
  input: RoutineSignalInput,
): Promise<RoutineSignalResult> {
  const update = parseRoutineSignal(input.signal);
  if (!update) {
    if (input.signal?.kind === "outcome") await logInvalidOutcome(deps, input);
    return { outcome: "invalid_signal" };
  }

  // Its comment got here first: the fire is already over.
  if (update.kind === "outcome") {
    const reported = { routine: update.routine, outcome: update.outcome.outcome };
    if (await alreadyApplied(deps, reported)) {
      await logDeduped(deps, { owner: input.owner, repo: input.repo, issueNumber: update.issue, actor: "routine-signal" }, reported);
      return { outcome: "deduped" };
    }
  }

  const pending = await deps.getPendingFire();
  // A fire waiting out a rate limit has no run yet: a signal can only be from
  // an earlier run of the same routine, and must not clear or extend it.
  const live = pending && pending.deferUntil === undefined ? pending : null;
  if (!live || live.run !== update.routine) {
    const refused = live
      ? ({ outcome: "mismatched_routine", expected: live.run, got: update.routine } as const)
      : ({ outcome: "no_pending_fire" } as const);
    // An authoritative report turned away: leave a row, not only a response.
    if (update.kind === "outcome") {
      await logOutcomeRefused(deps, input.owner, input.repo, update, live ? `a different routine is running: ${live.run}` : "no pending fire");
    }
    return refused;
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
      await deps.clearPendingFire();
      await deps.markCompleted(new Date().toISOString());
      await deps.recordStatus(live, { kind: "done" });
      return { outcome: "completion_acknowledged" };
    case "outcome":
      return applyOutcome(deps, live, update);
    case "blocked":
      return noteBlocked(deps, live, update.detail);
    case "ended":
      return { outcome: "ended_expired", result: await endFire(deps, live, update.detail) };
  }
}

/**
 * The explicit outcome, as the comment it stands for, through
 * coordinateWebhook (which also remembers it, so the real comment dedupes).
 * Its delivery id is the fire and the outcome, so a resent signal is a
 * duplicate delivery. Applied, the rule has cleared or replaced the fire;
 * one still this fire (a rule that left it) is ended here. Not applied
 * (dropped, …), the watchdog stays armed and still decides.
 */
async function applyOutcome(
  deps: Deps,
  pending: PendingFire,
  update: Extract<RoutineUpdate, { kind: "outcome" }>,
): Promise<RoutineSignalResult> {
  // translate() reads the comment up to the first closing fence, so a backtick in a free-text field must not reach it raw; JSON.parse restores it.
  const json = JSON.stringify(update.outcome).replace(/`/g, "\\u0060");
  const body = `<!-- agent-outcome:${pending.run} -->\n\`\`\`json\n${json}\n\`\`\``;
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
  if (result.outcome !== "applied") return { outcome: "outcome_reported", result };
  const now = await deps.getPendingFire();
  if (now?.run === pending.run && now.firedAt === pending.firedAt && now.dueAt === pending.dueAt) {
    await deps.clearPendingFire();
    await deps.recordStatus(pending, { kind: "done" });
  }
  // Unless the rule fired a new run (which a mark would hide from the sweep).
  if (!(await deps.getPendingFire())) await deps.markCompleted(new Date().toISOString());
  return { outcome: "outcome_reported", result };
}

/**
 * The run is waiting on a permission prompt nobody is there to answer. Said
 * once per fire (the pending fire carries `blocked`), on the item; recorded
 * as its step. No label moves: the watchdog still decides.
 */
async function noteBlocked(deps: Deps, pending: PendingFire, detail: string): Promise<RoutineSignalResult> {
  const step = `blocked: ${quote(detail)}`;
  const at = new Date().toISOString();
  const already = pending.blocked === true;
  // The record first: a comment that fails to post isn't retried into a second.
  await deps.setPendingFire({ ...pending, lastStep: step, lastStepAt: at, blocked: true });
  await deps.recordStatus(pending, { kind: "step", step, at });
  if (already) return { outcome: "blocked_already_noted" };
  try {
    await depsFor(deps, "routine_blocked" as Event).io.commentOnIssue(
      pending.owner,
      pending.repo,
      pending.issueNumber,
      `⏸️ \`${pending.run}\` is waiting for a permission it can't get unattended: \`${quote(detail)}\`. (Automatic, from the orchestrator.)`,
    );
  } catch (e) {
    console.error("blocked comment failed:", e instanceof Error ? e.message : e);
  }
  return { outcome: "blocked_noted" };
}

/**
 * The session ended without an outcome: as the watchdog's alarm would, an
 * outcome comment whose webhook was lost is applied first; otherwise the
 * expiry now, its one comment naming what the routine said.
 */
async function endFire(deps: Deps, pending: PendingFire, detail: string): Promise<WatchdogResult> {
  // Only where the watchdog is enforced, as at the alarm: recovery writes labels.
  if (deps.enforced(EVENTS.WATCHDOG_EXPIRED)) {
    const recovered = await recoverOutcome(deps, pending);
    if (recovered) {
      // An earlier attempt may have recorded the expiry before its label write failed.
      await deps.setReworkExpired(false);
      return recovered;
    }
  }
  return expirePendingFire(
    deps,
    pending,
    (next) => `⚠️ The \`${pending.run}\` routine's session ended without reporting an outcome: \`${quote(detail)}\`.${next} (Automatic, from the orchestrator.)`,
    "routine-signal",
  );
}

/** An explicit outcome turned away (no fire, or another routine's): a row. */
async function logOutcomeRefused(
  deps: Deps,
  owner: string,
  repo: string,
  update: Extract<RoutineUpdate, { kind: "outcome" }>,
  reason: string,
): Promise<void> {
  await deps.logTransition({
    deliveryId: null,
    actor: "routine-signal",
    owner,
    repo,
    issueNumber: update.issue,
    fromState: "none",
    event: update.outcome.outcome,
    toEffect: null,
    run: update.routine,
    droppedReason: `outcome signal refused: ${reason}`,
    mode: depsFor(deps, update.outcome.outcome as Event).mode,
  });
}

/** An outcome signal whose outcome isn't one the catalog knows: a row,
 * nothing else. The outcome's comment, if valid, can still apply. */
async function logInvalidOutcome(deps: Deps, input: RoutineSignalInput): Promise<void> {
  const signal = input.signal as Extract<RoutineSignal, { kind: "outcome" }>;
  if (typeof signal.issue !== "number") return;
  const shown = JSON.stringify(signal.outcome ?? null) ?? "undefined";
  await deps.logTransition({
    deliveryId: null,
    actor: "routine-signal",
    owner: input.owner,
    repo: input.repo,
    issueNumber: signal.issue,
    fromState: "none",
    event: "outcome_invalid",
    toEffect: null,
    run: typeof signal.routine === "string" ? signal.routine : null,
    droppedReason: `outcome signal failed validation: ${shown.slice(0, 300)}`,
    mode: depsFor(deps, "outcome_invalid" as Event).mode,
  });
}

/** A routine's own text, one line in backticks: no backticks of its own, and short. */
function quote(text: string): string {
  return text.replace(/[`\r\n]+/g, " ").trim().slice(0, 300);
}
