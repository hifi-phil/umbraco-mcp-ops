// The core dispatch logic, as a dependency-injected pure(ish) function --
// no ctx.storage, no real fetch, nothing DO-specific. Tested with plain
// vitest (coordinate.test.ts), same as everything in graph/. The DO class
// (issue-coordinator.ts) is a thin wrapper that wires this to real
// storage/D1/GitHub calls; that wiring itself is NOT covered by these
// tests (no Miniflare/vitest-pool-workers in this pass — see
// issue-coordinator.ts's header for what that leaves unverified).

// This file: the shared vocabulary of coordinate/: the Deps every handler
// takes, the row and result types, and the mode switches (shadow/enforce).

import { LABELS, type Label } from "@orchestrator/graph/constants/labels";
import { type Rule, type State } from "@orchestrator/graph/graph";
import { ROUTINES } from "@orchestrator/graph/constants/routines";
import { type WebhookPayload } from "@orchestrator/graph/github/from-github";
import { type MergeGateFacts } from "@orchestrator/graph/github/merge-gate";
import { EVENTS, type Event } from "@orchestrator/graph/constants/events";

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
  [EVENTS.LABELLED_AI_REVIEWING]: LABELS.AI_REVIEWING,
};

export type TransitionRow = {
  // The GitHub delivery (X-GitHub-Delivery) that caused this row; null for
  // a row nothing delivered: the watchdog's own expiry, and the sweep's rows
  // (`sweep`, `reconcile_refire`, and what a re-fire or its gate applies).
  deliveryId: string | null;
  owner: string;
  repo: string;
  issueNumber: number;
  fromState: string;
  event: string;
  toEffect: string | null; // JSON.stringify(rule.to), or null if nothing fired
  run: string | null;
  droppedReason: string | null; // null only when a rule actually fired
  mode: Mode; // whether this event's writes were real (see Deps.enforced)
  // Who caused it: the webhook's sender, or "watchdog" / "sweep" for the
  // Worker's own; null when unknown.
  actor?: string | null;
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
  // When its watchdog is due (epoch ms), set by the DO's setPendingFire. A
  // watchdog alarm that started before a newer fire (or heartbeat) replaced
  // this one finds it not yet due, and leaves it to that fire's own alarm.
  dueAt?: number;
};

// returnTo: where the fix's push goes back to, AUTO_MERGING (the default) or
// AI_REVIEWING (CI red before the review).
export type CiFix = { attempts: number; pending: boolean; returnTo?: Label };

// The review's own rounds on this PR: how many times review-loop has asked
// for changes, and whether rework-loop is out fixing them now.
export type ReviewLoop = { botRounds: number; fixPending: boolean };

/**
 * A change to the issue's live-status row (03-components.md §3.6, the
 * dashboard's table). Side effect only: nothing reads it back to decide.
 * - transition: an enforced rule applied (or a sweep re-fire); `run` is the
 *   routine it fired, if any, and `running` whether that run is watched
 * - step: a heartbeat; done: the run reported completion
 * - rework: a CI-fix rework was handed out (its new count)
 * - gone: the issue closed, or has nothing left to show; reopened: it can
 *   show again
 */
export type StatusUpdate =
  | { kind: "transition"; state: string; run: string | null; running: boolean }
  | { kind: "step"; step: string; at: string }
  | { kind: "done" }
  | { kind: "rework"; count: number }
  // closed: it was closed on GitHub, so nothing re-creates its row until a
  // reopened clears that
  | { kind: "gone"; closed?: boolean }
  | { kind: "reopened" };

/** After this many CI-fix reworks on one PR, stop and ask a human. */
export const MAX_CI_FIX_ATTEMPTS = 3;

/** After this many review rework rounds on one PR (AUTO_REWORKING added by a
 * reviewer outside the orchestrator: a person, or another bot), the next
 * goes to AI_STUCK instead of looping (Phase 9, 05-technical-elements.md's
 * default). Tune from real data. */
export const MAX_REVIEW_REWORKS = 3;

/** The same cap for review-loop's own findings, counted separately so the
 * bot can't use up a person's rounds (15-agent-splits.md). */
export const MAX_BOT_REVIEW_REWORKS = 3;

/** The loop caps in force for one repo (Deps.caps): the defaults above,
 * unless CAP_OVERRIDES_JSON sets them for it (capsFor). */
export type Caps = { ciFixAttempts: number; reviewReworks: number; botReviewReworks: number };

export const DEFAULT_CAPS: Caps = {
  ciFixAttempts: MAX_CI_FIX_ATTEMPTS,
  reviewReworks: MAX_REVIEW_REWORKS,
  botReviewReworks: MAX_BOT_REVIEW_REWORKS,
};

/**
 * Per-repo caps, keyed "owner/repo" (any case), from CAP_OVERRIDES_JSON,
 * over DEFAULT_CAPS. Only the e2e sandbox uses it today: a cap of 1 lets a
 * cap scenario run one round instead of three. Only whole numbers of 1 or
 * more count; anything else keeps the default. Unset or `{}` means none.
 */
export function capsFor(raw: string | undefined, owner: string, repo: string): Caps {
  if (!raw) return DEFAULT_CAPS;
  let map: Record<string, Partial<Caps>>;
  try {
    map = JSON.parse(raw);
  } catch {
    throw new Error("CAP_OVERRIDES_JSON is not valid JSON");
  }
  const want = `${owner}/${repo}`.toLowerCase();
  const override = Object.entries(map).find(([key]) => key.toLowerCase() === want)?.[1] ?? {};
  const pick = (v: unknown, fallback: number) => (Number.isInteger(v) && (v as number) >= 1 ? (v as number) : fallback);
  return {
    ciFixAttempts: pick(override.ciFixAttempts, DEFAULT_CAPS.ciFixAttempts),
    reviewReworks: pick(override.reviewReworks, DEFAULT_CAPS.reviewReworks),
    botReviewReworks: pick(override.botReviewReworks, DEFAULT_CAPS.botReviewReworks),
  };
}

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
  unmarkSeenDelivery(deliveryId: string): Promise<void>;
  setPendingFire(info: PendingFire): Promise<void>;
  clearPendingFire(): Promise<void>;
  getPendingFire(): Promise<PendingFire | null>;
  // Whether the watchdog alarm behind a pending fire is still armed. A
  // watchdog whose alarm gave up after its retries (GitHub down when it
  // fired) leaves the pending fire with nothing behind it.
  watchdogArmed(): Promise<boolean>;
  // The real, independently-fetched facts behind MERGE_GATE_FAILED_SOFT/
  // HARD — see graph/github/merge-gate.ts's header for why this needs to
  // be a Dep (I/O) rather than living in translate() (pure).
  getMergeGateFacts(owner: string, repo: string, prNumber: number): Promise<MergeGateFacts>;
  // The CI-fix cycle for this PR (DO storage): how many times CI failure
  // has been handed to rework-loop, and whether one is running now.
  getCiFix(): Promise<CiFix | null>;
  setCiFix(state: CiFix | null): Promise<void>;
  // How many review rework rounds this PR has had (DO storage).
  getReviewReworks(): Promise<number>;
  setReviewReworks(rounds: number): Promise<void>;
  // review-loop's own rounds on this PR (DO storage).
  getReviewLoop(): Promise<ReviewLoop | null>;
  setReviewLoop(state: ReviewLoop | null): Promise<void>;
  // The CI-fix and review-round caps for this issue's repo (capsFor).
  caps: Caps;
  // Phase 4: whether this event's writes and fire are real. Everything not
  // enforced runs in shadow (see resolveEnforced).
  enforced(event: Event): boolean;
  // The Worker's own GitHub identity (its App's `<slug>[bot]`), so
  // translate() drops the label changes it made itself; null without an App.
  botLogin(): Promise<string | null>;
  // When this issue last had a row in the D1 log (its created_at), or null
  // if it never has: how long it's been idle, for the reconciliation sweep.
  lastActivityAt(): Promise<string | null>;
  // The last activity a shadow sweep already logged a "would re-fire" for
  // (DO storage), so an issue that stays left behind is logged once, not
  // every sweep.
  getReconcileReported(): Promise<string | null>;
  setReconcileReported(lastActivity: string): Promise<void>;
  // When the running routine last reported completion (routine-signal); any
  // new fire (setPendingFire) clears it. A run that reported its outcome but
  // whose trigger label is still on (the outcome's label change lost) isn't
  // left behind, as long as nothing happened since (coordinateReconcile).
  markCompleted(at: string): Promise<void>;
  completedAt(): Promise<string | null>;
  // How long a fired routine has before the watchdog expires, for this
  // issue's repo (watchdogMinutesFor, unless the repo overrides it).
  watchdogMinutes(routine: string): number;
  // The live-status row (StatusUpdate). Never throws: a failed write is
  // logged and the transition goes on.
  recordStatus(ref: IssueRef, update: StatusUpdate): Promise<void>;
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

/**
 * Phase 4: MODE=enforce makes every event real except the watchdog, which
 * has its own WATCHDOG switch (shadow unless exactly "enforce"). Its
 * timeouts are still guesses, and a wrong expiry would move a live issue to
 * AI_STUCK, so it goes live separately.
 */
export function resolveEnforced(
  mode: string | undefined,
  watchdog: string | undefined,
): (event: Event) => boolean {
  const all = resolveMode(mode) === "enforce";
  const watchdogToo = all && resolveMode(watchdog) === "enforce";
  return (event) => (event === EVENTS.WATCHDOG_EXPIRED ? watchdogToo : all);
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
    enforced: () => false,
  };
}

/** The deps to use for one event: real writes if it's enforced, else shadow. */
export function depsFor(deps: Deps, event: Event): { io: Deps; mode: Mode } {
  return deps.enforced(event) ? { io: deps, mode: "enforce" } : { io: shadowDeps(deps), mode: "shadow" };
}

/** How long a watched routine gets to report an outcome (or a heartbeat,
 * which re-arms it) before the watchdog moves the issue to AI_STUCK. */
export const WATCHDOG_MINUTES = 30;

// Per-routine overrides, from umbraco-mcp-ops's D1 log (01-10-2026, via
// worker/queries/routine-durations.sql). Slowest real run per routine:
// build 23 min (most under 3), release 7 (run 1's, before the release
// loop's fixes, 36), rework 2.4, merge-flow 3.3. Each timeout keeps a wide
// margin over that; builds on the MCP repos run full test suites, so they
// may need more (per repo: WATCHDOG_OVERRIDES_JSON). Re-run the query as
// more runs land.
const WATCHDOG_MINUTES_BY_ROUTINE: Partial<Record<string, number>> = {
  [ROUTINES.AUTO_RELEASE_LOOP]: 60,
  [ROUTINES.ISSUE_BUILD_LOOP]: 60,
};

export function watchdogMinutesFor(routine: string): number {
  return WATCHDOG_MINUTES_BY_ROUTINE[routine] ?? WATCHDOG_MINUTES;
}

/**
 * Per-repo watchdog settings, keyed "owner/repo" (any case), from
 * WATCHDOG_OVERRIDES_JSON. Only the e2e sandbox uses it today: `mode` makes
 * its watchdog real while every other repo's stays on WATCHDOG, and
 * `minutes` shortens every routine's timeout so a scenario can watch an
 * expiry happen. Unset or `{}` means no overrides.
 */
export type WatchdogOverride = { mode?: string; minutes?: number };

export function watchdogOverrideFor(
  raw: string | undefined,
  owner: string,
  repo: string,
): WatchdogOverride | undefined {
  if (!raw) return undefined;
  let map: Record<string, WatchdogOverride>;
  try {
    map = JSON.parse(raw);
  } catch {
    throw new Error("WATCHDOG_OVERRIDES_JSON is not valid JSON");
  }
  const want = `${owner}/${repo}`.toLowerCase();
  return Object.entries(map).find(([key]) => key.toLowerCase() === want)?.[1];
}

export type CoordinateInput = {
  deliveryId: string;
  owner: string;
  repo: string;
  issueNumber: number;
  payload: WebhookPayload;
};

export type IssueRef = Pick<CoordinateInput, "owner" | "repo" | "issueNumber">;

/** What the Worker was doing when no webhook caused a row. */
export type Acting = { actor?: "watchdog" | "sweep" };

/** Who caused a row: the webhook's sender, else what the Worker was doing. */
export function actorOf(input: IssueRef & Acting): string | null {
  return (input as Partial<CoordinateInput>).payload?.sender?.login ?? input.actor ?? null;
}

export type CoordinateResult =
  | { outcome: "deduped" }
  | { outcome: "no_event" }
  | { outcome: "ambiguous_state" }
  | { outcome: "dropped_no_rule"; from: State; event: Event }
  | { outcome: "ignored"; from: State; event: Event } // a CONTEXTUAL_EVENT outside its states; not logged
  | { outcome: "stale_label"; event: Event } // the label was already gone when its webhook ran; not logged
  | { outcome: "manual_override"; change: string; by: string | null } // a person edited a tracked label; logged
  | { outcome: "applied"; from: State; event: Event; rule: Rule };

