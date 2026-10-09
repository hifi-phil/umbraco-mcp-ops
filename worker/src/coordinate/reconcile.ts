// The reconciliation sweep's question for one issue: was it left behind?

import { LABELS, type Label } from "@orchestrator/graph/constants/labels";
import { ROUTINES } from "@orchestrator/graph/constants/routines";
import { reduce } from "@orchestrator/graph/graph";
import { deriveMergeGateOutcome, hardBlockReason } from "@orchestrator/graph/github/merge-gate";
import { EVENTS, type Event } from "@orchestrator/graph/constants/events";
import { type CoordinateResult, type Deps, type IssueRef } from "./types";
import { applyEvent, deriveState, fireWatched } from "./apply";
import { blockMerge, handToRework, settledGateFacts } from "./merge-gate";
import { reviewGate } from "./review-gate";

// getAlarm() is null from the moment the watchdog alarm is invoked (even
// while it waits its turn in serial()) and again once its retries are spent.
// Only the second is a lost watchdog, so a pending fire counts as lost only
// this long after it was due: well past Cloudflare's alarm retry budget.
const WATCHDOG_LOST_AFTER_MS = 15 * 60_000;
// --- Reconciliation (Phase 7): re-firing what was left behind --------------

/** The trigger labels, and the event a person adding each one would be. */
const TRIGGER_EVENTS: Partial<Record<Label, Event>> = {
  [LABELS.AI_READY]: EVENTS.LABELLED_AI_READY,
  [LABELS.AUTO_RELEASING]: EVENTS.LABELLED_AUTO_RELEASING,
  [LABELS.AUTO_REWORKING]: EVENTS.LABELLED_AUTO_REWORKING,
  [LABELS.AUTO_MERGING]: EVENTS.LABELLED_AUTO_MERGING,
  [LABELS.AI_REVIEWING]: EVENTS.LABELLED_AI_REVIEWING,
};
export const TRIGGER_LABELS = Object.keys(TRIGGER_EVENTS) as Label[];

export type ReconcileResult =
  | { outcome: "watched" }
  | { outcome: "completed" } // its last run reported done; it's waiting, not lost
  | { outcome: "gated"; result: CoordinateResult } // a lost LABELS.AUTO_MERGING fire, gated first like the webhook path
  | { outcome: "not_triggered"; state: string }
  | { outcome: "recent"; idleMinutes: number }
  | {
      outcome: "refired" | "would_refire";
      run: string;
      idleMinutes: number | null;
      alreadyLogged?: boolean;
      // Why a sweep asked to enforce only logged: the Worker (MODE) or this
      // repo's watchdog isn't enforcing.
      held?: "mode_shadow" | "watchdog_shadow";
    };

/** D1's created_at ("YYYY-MM-DD HH:MM:SS", UTC) as epoch ms. */
const d1Time = (s: string) => Date.parse(`${s.replace(" ", "T")}Z`);

/**
 * The sweep's question for one issue (scheduler.ts asks every open issue
 * with a trigger label): was it left behind? That's in a trigger state,
 * with no watchdog running (so nothing will notice), and nothing logged for
 * twice its routine's timeout: a fire that never got out, or a watchdog
 * that was lost. Then fire its routine again and watch it, as if the
 * trigger label had just been added. Bounded: if that run dies too, the
 * watchdog moves the issue to {@link LABELS.AI_STUCK}, which isn't a trigger state. That
 * bound only holds while this repo's watchdog enforces (a shadow one leaves
 * the label on, so the issue would be re-fired every sweep), and a real
 * fire needs MODE=enforce, so either one shadowed holds the re-fire to a
 * log row. `enforced` false (the sweep's shadow mode) only logs too.
 */
export async function coordinateReconcile(
  deps: Deps,
  ref: IssueRef,
  { enforced, now = Date.now(), updatedAt }: { enforced: boolean; now?: number; updatedAt?: string },
): Promise<ReconcileResult> {
  // A pending fire with no alarm behind it, well after it was due, is a lost
  // watchdog: nothing will notice, so it's swept like any other (the idle
  // check still applies). One only just due may be expiring right now.
  const pending = await deps.getPendingFire();
  if (pending) {
    const expiring = pending.dueAt !== undefined && now < pending.dueAt + WATCHDOG_LOST_AFTER_MS;
    if (expiring || (await deps.watchdogArmed())) return { outcome: "watched" };
  }

  const labels = await deps.getLabels(ref.owner, ref.repo, ref.issueNumber);
  const state = deriveState(labels);
  const event = state === "ambiguous" || state === "none" ? undefined : TRIGGER_EVENTS[state as Label];
  // LABELS.AI_REVIEWING fires nothing itself (its CI gate does), so it's swept by the
  // routine the gate would fire.
  // LABELS.AUTO_RELEASING after the Worker merged the release PR: the after
  // part (release-publish) is what was lost, not the before part.
  const releaseMerged = state === LABELS.AUTO_RELEASING && (await deps.getReleaseMerged()) !== null;
  const run =
    state === LABELS.AI_REVIEWING
      ? ROUTINES.REVIEW_LOOP
      : releaseMerged
        ? ROUTINES.RELEASE_PUBLISH
        : event
          ? reduce("none", event)?.run
          : undefined;
  if (!run) return { outcome: "not_triggered", state };

  // Activity is the later of its last real log row and GitHub's updated_at:
  // a label added a moment ago (its webhook not handled yet) is recent, so
  // the sweep doesn't fire alongside it.
  const logged = await deps.lastActivityAt();
  const times = [logged === null ? NaN : d1Time(logged), updatedAt ? Date.parse(updatedAt) : NaN].filter(Number.isFinite);
  const lastMs = times.length > 0 ? Math.max(...times) : null;
  const last = lastMs === null ? null : new Date(lastMs).toISOString();
  const idleMinutes = lastMs === null ? null : Math.round((now - lastMs) / 6_000) / 10;
  if (idleMinutes !== null && idleMinutes < 2 * deps.watchdogMinutes(run)) return { outcome: "recent", idleMinutes };

  // Its last run reported its outcome and nothing has happened since (the
  // outcome's label change was lost, say): the run isn't lost, and re-firing
  // would only repeat finished work. Anything after the completion (a new label, a push, a comment:
  // a log row or GitHub's updated_at) makes the mark stale, so a trigger
  // whose webhook or fire was lost after an earlier run still gets swept.
  const completed = await deps.completedAt();
  if (completed !== null && (lastMs === null || Date.parse(completed) >= lastMs)) return { outcome: "completed" };

  const held = !enforced
    ? undefined
    : !deps.enforced(event!)
      ? ("mode_shadow" as const)
      : !deps.enforced(EVENTS.WATCHDOG_EXPIRED)
        ? ("watchdog_shadow" as const)
        : undefined;
  if (enforced && held) enforced = false;

  // A lost LABELS.AUTO_MERGING fire goes through the same gate as a fresh label: a
  // conflict or requested changes -> LABELS.MERGE_BLOCKED, red CI -> rework, else
  // merge-flow below.
  if (enforced && state === LABELS.AUTO_MERGING) {
    // A person's lost retry of a LABELS.MERGE_BLOCKED PR (LABELS.AUTO_MERGING re-added, both
    // labels on): a fresh CI-fix count, as the webhook path starts.
    const retry = labels.includes(LABELS.MERGE_BLOCKED);
    if (retry) await deps.setCiFix(null);
    const facts = await settledGateFacts(deps, ref);
    const reason = hardBlockReason(facts);
    const sweep = { ...ref, actor: "sweep" as const };
    if (reason) return { outcome: "gated", result: await blockMerge(deps, sweep, labels, reason) };
    if (deriveMergeGateOutcome(facts) === "soft") return { outcome: "gated", result: await handToRework(deps, sweep, labels, facts) };
    // Gate passed: the retry's own rule (LABELS.MERGE_BLOCKED comes off, merge-flow
    // fired and watched), not a bare re-fire that would leave LABELS.MERGE_BLOCKED on.
    if (retry) {
      const result = await applyEvent(deps, sweep, EVENTS.LABELLED_AUTO_MERGING, labels);
      if (result.outcome === "applied") {
        await deps.logTransition({
          deliveryId: null,
          owner: ref.owner,
          repo: ref.repo,
          issueNumber: ref.issueNumber,
          fromState: LABELS.MERGE_BLOCKED,
          event: "reconcile_refire",
          actor: "sweep",
          toEffect: JSON.stringify({ kind: "noop", idleMinutes, retry: true }),
          run,
          droppedReason: null,
          mode: "enforce",
        });
      }
      return { outcome: "gated", result };
    }
  }

  // A PR left in LABELS.AI_REVIEWING (a lost check_suite webhook, or a lost review
  // fire): the CI gate again, as when the label went on.
  if (enforced && state === LABELS.AI_REVIEWING) {
    return { outcome: "gated", result: await reviewGate(deps, { ...ref, actor: "sweep" }, labels) };
  }

  if (enforced) {
    await fireWatched(deps, ref, run);
    await deps.recordStatus(ref, { kind: "transition", state, run, running: true });
  } else {
    // Shadow: one row per idle stretch. Until the issue sees new activity,
    // a later sweep finds the same thing and has nothing new to say.
    const stretch = last ?? "never";
    if ((await deps.getReconcileReported()) === stretch) {
      return { outcome: "would_refire", run, idleMinutes, alreadyLogged: true, ...(held ? { held } : {}) };
    }
    await deps.setReconcileReported(stretch);
  }
  await deps.logTransition({
    deliveryId: null,
    owner: ref.owner,
    repo: ref.repo,
    issueNumber: ref.issueNumber,
    fromState: state,
    event: "reconcile_refire",
    actor: "sweep",
    toEffect: JSON.stringify({ kind: "noop", idleMinutes, ...(held ? { held } : {}) }),
    run,
    droppedReason: null,
    mode: enforced ? "enforce" : "shadow",
  });
  return { outcome: enforced ? "refired" : "would_refire", run, idleMinutes, ...(held ? { held } : {}) };
}
