// The core dispatch logic, as a dependency-injected pure(ish) function --
// no ctx.storage, no real fetch, nothing DO-specific. Tested with plain
// vitest (coordinate.test.ts), same as everything in graph/. The DO class
// (issue-coordinator.ts) is a thin wrapper that wires this to real
// storage/D1/GitHub calls; that wiring itself is NOT covered by these
// tests (no Miniflare/vitest-pool-workers in this pass — see
// issue-coordinator.ts's header for what that leaves unverified).

import { ALL_LABELS, LABELS, type Label } from "../../graph/constants/labels";
import { CONTEXTUAL_EVENTS, isWatched, reduce, type Rule, type State } from "../../graph/graph";
import { ROUTINES } from "../../graph/constants/routines";
import { translate, type WebhookPayload } from "../../graph/github/from-github";
import { labelOps } from "../../graph/github/to-github";
import { deriveMergeGateOutcome, type MergeGateFacts } from "../../graph/github/merge-gate";
import { EVENTS, type Event } from "../../graph/constants/events";
import { parseRoutineSignal, type RoutineSignal } from "../../graph/routines/from-routine";

// A GitHub label-add webhook is only delivered *after* the label already
// exists on the issue/PR — so a fresh getLabels() read for a "labelled_X"
// event always shows X already present. reduce()'s rules for these events
// are keyed on the state *before* X was added ("none"), so the label that
// this specific event just added has to be excluded before deriving
// `current`, or the rule with `from: "none"` never matches its own
// trigger. Must stay in sync with the label-name switches in
// graph/github/from-github.ts's translate() — completeness is checked in
// coordinate.test.ts.
export const LABEL_JUST_ADDED_BY: Partial<Record<Event, Label>> = {
  [EVENTS.LABELLED_AI_READY]: LABELS.AI_READY,
  [EVENTS.LABELLED_AUTO_RELEASING]: LABELS.AUTO_RELEASING,
  [EVENTS.LABELLED_AI_DISCUSSING]: LABELS.AI_DISCUSSING,
  [EVENTS.LABELLED_AUTO_REWORKING]: LABELS.AUTO_REWORKING,
  [EVENTS.LABELLED_AUTO_MERGING]: LABELS.AUTO_MERGING,
};

export type TransitionRow = {
  owner: string;
  repo: string;
  issueNumber: number;
  fromState: string;
  event: string;
  toEffect: string | null; // JSON.stringify(rule.to), or null if nothing fired
  run: string | null;
  droppedReason: string | null; // null only when a rule actually fired
};

export type PendingFire = {
  owner: string;
  repo: string;
  issueNumber: number;
  run: string;
  // The last "process" heartbeat for this attempt (03-components.md §3.4),
  // so a watchdog expiry can say where the run got to, not just "timed out".
  lastStep?: string;
  lastStepAt?: string; // ISO timestamp
};

export type Deps = {
  getLabels(owner: string, repo: string, issueNumber: number): Promise<string[]>;
  addLabel(owner: string, repo: string, issueNumber: number, label: string): Promise<void>;
  removeLabel(owner: string, repo: string, issueNumber: number, label: string): Promise<void>;
  closeIssue(owner: string, repo: string, issueNumber: number): Promise<void>;
  commentOnIssue(owner: string, repo: string, issueNumber: number, body: string): Promise<void>;
  // Fires the repo's loop-dispatch routine with this route (routines-client.ts).
  fireRoutine(owner: string, repo: string, issueNumber: number, routine: string): Promise<void>;
  logTransition(row: TransitionRow): Promise<void>;
  hasSeenDelivery(deliveryId: string): Promise<boolean>;
  markSeenDelivery(deliveryId: string): Promise<void>;
  setPendingFire(info: PendingFire): Promise<void>;
  clearPendingFire(): Promise<void>;
  getPendingFire(): Promise<PendingFire | null>;
  // The real, independently-fetched facts behind MERGE_GATE_FAILED_SOFT/
  // HARD — see graph/github/merge-gate.ts's header for why this needs to
  // be a Dep (I/O) rather than living in translate() (pure).
  getMergeGateFacts(owner: string, repo: string, prNumber: number): Promise<MergeGateFacts>;
};

/**
 * Phase 3 (07-build-phases.md): "shadow" runs the exact same decision path
 * but turns every GitHub/routines write into a no-op, so the only lasting
 * effect is the D1 row saying what the reducer *would* have done. Reads
 * (labels, merge-gate facts) and DO-internal storage (dedupe, pendingFire)
 * stay real, so the watchdog still measures whether the routine the
 * existing dispatch fired actually reports back. Anything other than
 * exactly "enforce" means shadow: a missing or typo'd MODE must never
 * start writing labels next to loops that still swap their own.
 */
export type Mode = "shadow" | "enforce";

export function resolveMode(raw: string | undefined): Mode {
  return raw === "enforce" ? "enforce" : "shadow";
}

export function shadowDeps(deps: Deps): Deps {
  const skip = async () => {};
  return {
    ...deps,
    addLabel: skip,
    removeLabel: skip,
    closeIssue: skip,
    commentOnIssue: skip,
    fireRoutine: skip,
  };
}

/** How long a watched routine gets to report an outcome (or a heartbeat,
 * which re-arms it) before the watchdog moves the issue to ai-stuck. */
export const WATCHDOG_MINUTES = 30;

// Per-routine overrides. Shadow run 1's release was still working at 36
// minutes (13-shadow-results.md); builds on the MCP repos run full test
// suites. First guesses from one run each; tune from the D1 log.
const WATCHDOG_MINUTES_BY_ROUTINE: Partial<Record<string, number>> = {
  [ROUTINES.AUTO_RELEASE_LOOP]: 120,
  [ROUTINES.ISSUE_BUILD_LOOP]: 60,
};

export function watchdogMinutesFor(routine: string): number {
  return WATCHDOG_MINUTES_BY_ROUTINE[routine] ?? WATCHDOG_MINUTES;
}

export type CoordinateInput = {
  deliveryId: string;
  owner: string;
  repo: string;
  issueNumber: number;
  payload: WebhookPayload;
};

export type IssueRef = Pick<CoordinateInput, "owner" | "repo" | "issueNumber">;

export type CoordinateResult =
  | { outcome: "deduped" }
  | { outcome: "no_event" }
  | { outcome: "ambiguous_state" }
  | { outcome: "dropped_no_rule"; from: State; event: Event }
  | { outcome: "ignored"; from: State; event: Event } // a CONTEXTUAL_EVENT outside its states; not logged
  | { outcome: "applied"; from: State; event: Event; rule: Rule };

/**
 * The literal implementation of translate() -> reduce() -> labelOps() +
 * fire, given the labels actually present right now (re-read fresh every
 * time via deps.getLabels — see graph/github/to-github.ts's labelOps()
 * doc comment for why that matters). This function IS the reducer's real
 * decision path; everything graph/ built is exercised here for real.
 *
 * check_suite.completed is special-cased before translate() ever runs:
 * deciding MERGE_GATE_FAILED_SOFT/HARD needs facts translate() can't see
 * (the full check-run list, review state, mergeability — not just the one
 * check_suite payload) — that's I/O, so it can't live in the deliberately
 * pure translate(). See graph/github/merge-gate.ts.
 */
export async function coordinateWebhook(
  deps: Deps,
  input: CoordinateInput,
): Promise<CoordinateResult> {
  if (input.deliveryId) {
    if (await deps.hasSeenDelivery(input.deliveryId)) return { outcome: "deduped" };
    await deps.markSeenDelivery(input.deliveryId);
  }

  if (input.payload.action === "check_suite.completed") {
    return handleCheckSuiteCompleted(deps, input);
  }

  const event = translate(input.payload);
  if (!event) return { outcome: "no_event" };

  // Fresh, per §3.4/to-github.ts's "never cache" principle -- and the one
  // set labelOps() below must see in full (including a label this event
  // itself just added), even though deriveState() below needs it filtered.
  const currentLabels = await deps.getLabels(input.owner, input.repo, input.issueNumber);

  return applyEvent(deps, input, event, currentLabels);
}

/**
 * check_suite.completed's own real aggregation path: only matters for a
 * PR currently in `auto-merge` (mirrors merge-flow's own gate — nothing
 * else watches CI this way), and only once the suite has actually
 * finished (a mid-flight `status: "in_progress"` webhook has nothing to
 * decide yet).
 */
async function handleCheckSuiteCompleted(deps: Deps, input: CoordinateInput): Promise<CoordinateResult> {
  if (input.payload.check_suite?.status !== "completed") return { outcome: "no_event" };

  const currentLabels = await deps.getLabels(input.owner, input.repo, input.issueNumber);
  if (!currentLabels.includes(LABELS.AUTO_MERGING)) return { outcome: "no_event" };

  const facts = await deps.getMergeGateFacts(input.owner, input.repo, input.issueNumber);
  const gateOutcome = deriveMergeGateOutcome(facts);
  if (gateOutcome === "still_pending" || gateOutcome === null) return { outcome: "no_event" };

  const event = gateOutcome === "soft" ? EVENTS.MERGE_GATE_FAILED_SOFT : EVENTS.MERGE_GATE_FAILED_HARD;
  return applyEvent(deps, input, event, currentLabels);
}

/** The shared reduce() -> labelOps() -> fire/log tail, once an Event has
 * been decided (however it was decided) and the current labels are
 * already in hand. */
async function applyEvent(
  deps: Deps,
  input: IssueRef,
  event: Event,
  currentLabels: string[],
): Promise<CoordinateResult> {
  const justAdded = LABEL_JUST_ADDED_BY[event];
  const labelsBeforeThisEvent = justAdded
    ? currentLabels.filter((l) => l !== justAdded)
    : currentLabels;
  const current = deriveState(labelsBeforeThisEvent);
  if (current === "ambiguous") {
    await deps.logTransition({
      owner: input.owner,
      repo: input.repo,
      issueNumber: input.issueNumber,
      fromState: "ambiguous",
      event,
      toEffect: null,
      run: null,
      droppedReason: "ambiguous current state — multiple tracked labels present",
    });
    return { outcome: "ambiguous_state" };
  }

  const rule = reduce(current, event);
  if (!rule && CONTEXTUAL_EVENTS.has(event)) return { outcome: "ignored", from: current, event };
  if (!rule) {
    await deps.logTransition({
      owner: input.owner,
      repo: input.repo,
      issueNumber: input.issueNumber,
      fromState: current,
      event,
      toEffect: null,
      run: null,
      droppedReason: "no matching rule for this (state, event) pair",
    });
    return { outcome: "dropped_no_rule", from: current, event };
  }

  for (const op of labelOps(currentLabels, rule)) {
    if (op.op === "add") await deps.addLabel(input.owner, input.repo, input.issueNumber, op.label);
    else if (op.op === "remove") {
      await deps.removeLabel(input.owner, input.repo, input.issueNumber, op.label);
    } else {
      await deps.closeIssue(input.owner, input.repo, input.issueNumber);
    }
  }

  if (rule.run) {
    await deps.fireRoutine(input.owner, input.repo, input.issueNumber, rule.run);
    // Only arm the watchdog where the table says what an expiry means —
    // see graph.ts's watchdog section (issue-discuss-loop never reports an
    // outcome, so watching it would only ever raise false alarms).
    const target = rule.to.kind === "label" ? rule.to.value : current;
    if (isWatched(target)) {
      await deps.setPendingFire({
        owner: input.owner,
        repo: input.repo,
        issueNumber: input.issueNumber,
        run: rule.run,
      });
    } else {
      await deps.clearPendingFire();
    }
  } else {
    await deps.clearPendingFire();
  }

  await deps.logTransition({
    owner: input.owner,
    repo: input.repo,
    issueNumber: input.issueNumber,
    fromState: current,
    event,
    toEffect: JSON.stringify(rule.to),
    run: rule.run ?? null,
    droppedReason: null,
  });

  return { outcome: "applied", from: current, event, rule };
}

export type RoutineSignalInput = { owner: string; repo: string; signal: RoutineSignal };

export type RoutineSignalResult =
  | { outcome: "invalid_signal" }
  | { outcome: "no_pending_fire" } // nothing running for this issue right now — a stray/late signal, harmless
  | { outcome: "mismatched_routine"; expected: string; got: string } // a different routine currently owns this issue
  | { outcome: "heartbeat_extended" }
  | { outcome: "completion_acknowledged" };

/**
 * The direct routine-to-DO channel — see graph/routines/from-routine.ts's
 * header for why this exists and what it deliberately doesn't do. Neither
 * kind ever calls reduce() or writes a label/close — this is purely a
 * watchdog-timing optimization (extend the alarm on "process", cancel it
 * early on "completion") layered on top of the one authoritative path,
 * coordinateWebhook(). Losing a call here costs a slightly-later alarm
 * or a duplicate cancel a moment later when the real GitHub webhook
 * arrives — never a wrong state.
 */
export async function coordinateRoutineSignal(
  deps: Deps,
  input: RoutineSignalInput,
): Promise<RoutineSignalResult> {
  const update = parseRoutineSignal(input.signal);
  if (!update) return { outcome: "invalid_signal" };

  const pending = await deps.getPendingFire();
  if (!pending) return { outcome: "no_pending_fire" };
  if (pending.run !== update.routine) {
    return { outcome: "mismatched_routine", expected: pending.run, got: update.routine };
  }

  if (update.kind === "process") {
    // Records the step (so an expiry can quote it) and, because the DO's
    // setPendingFire always re-schedules the alarm, extends the watchdog.
    await deps.setPendingFire({ ...pending, lastStep: update.step, lastStepAt: new Date().toISOString() });
    return { outcome: "heartbeat_extended" };
  }

  await deps.clearPendingFire();
  return { outcome: "completion_acknowledged" };
}

export type WatchdogResult = { outcome: "no_pending_fire" } | CoordinateResult;

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
export async function coordinateWatchdogExpired(deps: Deps): Promise<WatchdogResult> {
  const pending = await deps.getPendingFire();
  if (!pending) return { outcome: "no_pending_fire" };

  const lastStep = pending.lastStep
    ? ` Last reported step: \`${pending.lastStep}\` (${pending.lastStepAt ?? "time unknown"}).`
    : " No progress step was ever reported.";
  const currentLabels = await deps.getLabels(pending.owner, pending.repo, pending.issueNumber);
  const state = deriveState(currentLabels);
  const willStick = state !== "ambiguous" && reduce(state, EVENTS.WATCHDOG_EXPIRED) !== null;
  const next = willStick
    ? ` Moving this to \`${LABELS.AI_STUCK}\`; re-add the trigger label to retry.`
    : ` Its current labels don't allow an automatic move to \`${LABELS.AI_STUCK}\` — needs a human look.`;
  await deps.commentOnIssue(
    pending.owner,
    pending.repo,
    pending.issueNumber,
    `⚠️ The \`${pending.run}\` routine hasn't reported back within ${watchdogMinutesFor(pending.run)} minutes — it may have died mid-run.${lastStep}${next} ` +
      `This comment is automatic; see docs/agent-orchestration/03-components.md §3.4.`,
  );

  const result = await applyEvent(deps, pending, EVENTS.WATCHDOG_EXPIRED, currentLabels);
  await deps.clearPendingFire();
  return result;
}

/**
 * The real label set (freshly read) -> our tracked State. "none" means no
 * tracked label is present. Deliberately doesn't guess when more than one
 * tracked label is present at once — that's a real anomaly (nothing in
 * this system's design expects it), not something to silently resolve by
 * picking one.
 */
export function deriveState(labels: readonly string[]): State | "ambiguous" {
  const trackedSet: readonly string[] = ALL_LABELS;
  const tracked = labels.filter((l) => trackedSet.includes(l)) as Label[];
  if (tracked.length === 0) return "none";
  if (tracked.length === 1) return tracked[0]!;
  // The one expected pairing: ai-stuck plus a label a late routine swapped
  // in itself after the watchdog had already fired (e.g. ai-stuck +
  // generated-by-ai, just before its outcome comment arrives). A known race
  // with a defined answer — the issue is still ai-stuck, and graph.ts's
  // "leaving ai-stuck" rules decide what the late outcome does with it.
  if (tracked.length === 2 && tracked.includes(LABELS.AI_STUCK)) return LABELS.AI_STUCK;
  return "ambiguous";
}
