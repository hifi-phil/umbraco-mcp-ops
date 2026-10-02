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
import {
  deriveMergeGateOutcome,
  failedCheckNames,
  hardBlockReason,
  type MergeGateFacts,
} from "../../graph/github/merge-gate";
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
  // The GitHub delivery (X-GitHub-Delivery) that caused this row; null for
  // a row nothing delivered, i.e. the watchdog's own expiry.
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

export type CiFix = { attempts: number; pending: boolean };

/** After this many CI-fix reworks on one PR, stop and ask a human. */
export const MAX_CI_FIX_ATTEMPTS = 3;

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
  // The real, independently-fetched facts behind MERGE_GATE_FAILED_SOFT/
  // HARD — see graph/github/merge-gate.ts's header for why this needs to
  // be a Dep (I/O) rather than living in translate() (pure).
  getMergeGateFacts(owner: string, repo: string, prNumber: number): Promise<MergeGateFacts>;
  // The CI-fix cycle for this PR (DO storage): how many times CI failure
  // has been handed to rework-loop, and whether one is running now.
  getCiFix(): Promise<CiFix | null>;
  setCiFix(state: CiFix | null): Promise<void>;
  // Phase 4: whether this event's writes and fire are real. Everything not
  // enforced runs in shadow (see resolveEnforced).
  enforced(event: Event): boolean;
  // The Worker's own GitHub identity (its App's `<slug>[bot]`), so
  // translate() drops the label changes it made itself; null without an App.
  botLogin(): Promise<string | null>;
  // How long a fired routine has before the watchdog expires, for this
  // issue's repo (watchdogMinutesFor, unless the repo overrides it).
  watchdogMinutes(routine: string): number;
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
 * ai-stuck, so it goes live separately.
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
function depsFor(deps: Deps, event: Event): { io: Deps; mode: Mode } {
  return deps.enforced(event) ? { io: deps, mode: "enforce" } : { io: shadowDeps(deps), mode: "shadow" };
}

/** How long a watched routine gets to report an outcome (or a heartbeat,
 * which re-arms it) before the watchdog moves the issue to ai-stuck. */
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

export type CoordinateResult =
  | { outcome: "deduped" }
  | { outcome: "no_event" }
  | { outcome: "ambiguous_state" }
  | { outcome: "dropped_no_rule"; from: State; event: Event }
  | { outcome: "ignored"; from: State; event: Event } // a CONTEXTUAL_EVENT outside its states; not logged
  | { outcome: "stale_label"; event: Event } // the label was already gone when its webhook ran; not logged
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
  if (!input.deliveryId) return processWebhook(deps, input);

  // Claim the delivery before processing, so a duplicate arriving while
  // this one is mid-flight is dropped. But release the claim if processing
  // throws: GitHub redelivers with the SAME delivery id, and a claim left
  // behind by a failed attempt would dedupe that redelivery, losing the
  // event for good (found 30-09-2026: a redelivered 500 came back
  // "deduped").
  if (await deps.hasSeenDelivery(input.deliveryId)) return { outcome: "deduped" };
  await deps.markSeenDelivery(input.deliveryId);
  try {
    return await processWebhook(deps, input);
  } catch (e) {
    await deps.unmarkSeenDelivery(input.deliveryId);
    throw e;
  }
}

async function processWebhook(deps: Deps, input: CoordinateInput): Promise<CoordinateResult> {
  if (input.payload.action === "check_suite.completed") {
    return handleCheckSuiteCompleted(deps, input);
  }

  const botLogin = await deps.botLogin();
  let event = translate(input.payload, botLogin ? { botLogin } : {});
  if (!event) return { outcome: "no_event" };

  // Fresh, per §3.4/to-github.ts's "never cache" principle -- and the one
  // set labelOps() below must see in full (including a label this event
  // itself just added), even though deriveState() below needs it filtered.
  const currentLabels = await deps.getLabels(input.owner, input.repo, input.issueNumber);

  // A push by a rework this Worker started for failing CI: hand it back to
  // auto-merge instead of just clearing auto-rework (a review rework).
  if (event === EVENTS.REWORK_PUSHED || event === EVENTS.UNLABELLED_AUTO_REWORKING) {
    const ciFix = await deps.getCiFix();
    if (ciFix?.pending) {
      // auto-rework removed without a push (nothing to fix) ends the CI-fix
      // too, so a later review rework isn't mistaken for one.
      if (event === EVENTS.REWORK_PUSHED) event = EVENTS.CI_FIX_PUSHED;
      await deps.setCiFix({ ...ciFix, pending: false });
    }
  }

  // auto-merge added: check the PR before firing merge-flow. Reviews aren't
  // expected once the label is on, so this is where requested changes are
  // caught; conflicts are caught here and again each time CI finishes
  // (handleCheckSuiteCompleted). CI that has already failed goes straight
  // to rework.
  if (event === EVENTS.LABELLED_AUTO_MERGING) {
    // Run after auto-merge has already gone (swapped out by CI finishing red
    // a moment earlier, found by e2e on PR #246), there's no gate left to check.
    if (!currentLabels.includes(LABELS.AUTO_MERGING)) return { outcome: "stale_label", event };
    // A human re-adding auto-merge after merge-blocked starts a fresh count.
    if (currentLabels.includes(LABELS.MERGE_BLOCKED)) await deps.setCiFix(null);
    const facts = await settledGateFacts(deps, input);
    const reason = hardBlockReason(facts);
    if (reason) return blockMerge(deps, input, currentLabels, reason);
    if (deriveMergeGateOutcome(facts) === "soft") return handToRework(deps, input, currentLabels, facts);
  }

  return applyEvent(deps, input, event, currentLabels);
}

/** CI failed under auto-merge: swap auto-merge -> auto-rework so
 * rework-loop fixes it (its push swaps back to auto-merge), up to
 * MAX_CI_FIX_ATTEMPTS per PR, then merge-blocked. */
async function handToRework(
  deps: Deps,
  input: IssueRef,
  currentLabels: string[],
  facts: MergeGateFacts,
): Promise<CoordinateResult> {
  const failed = failedCheckNames(facts).join(", ") || "a required check";
  const attempts = (await deps.getCiFix())?.attempts ?? 0;
  if (attempts >= MAX_CI_FIX_ATTEMPTS) {
    return blockMerge(deps, input, currentLabels, `CI still failing after ${attempts} fix attempts (${failed})`);
  }
  const result = await applyEvent(deps, input, EVENTS.MERGE_GATE_FAILED_SOFT, currentLabels);
  if (result.outcome === "applied") {
    await deps.setCiFix({ attempts: attempts + 1, pending: true });
    await depsFor(deps, EVENTS.MERGE_GATE_FAILED_SOFT).io.commentOnIssue(
      input.owner,
      input.repo,
      input.issueNumber,
      `🔧 CI failing: ${failed}. Handing this to rework-loop to fix (attempt ${attempts + 1} of ` +
        `${MAX_CI_FIX_ATTEMPTS}); \`auto-merge\` comes back when it pushes the fix. ` +
        `(Automatic, from the orchestrator's merge gate.)`,
    );
  }
  return result;
}

/** GitHub computes `mergeable` in the background, so right after a push it
 * reads null. Re-read a couple of times before deciding; if it's still
 * null, hardBlockReason treats that as "no conflict known". */
async function settledGateFacts(deps: Deps, input: IssueRef): Promise<MergeGateFacts> {
  let facts = await deps.getMergeGateFacts(input.owner, input.repo, input.issueNumber);
  for (let i = 0; i < MERGEABLE_RETRIES && facts.mergeable === null; i++) {
    await new Promise((r) => setTimeout(r, MERGEABLE_RETRY_MS));
    facts = await deps.getMergeGateFacts(input.owner, input.repo, input.issueNumber);
  }
  return facts;
}

export const MERGEABLE_RETRIES = 2;
export const MERGEABLE_RETRY_MS = 1000;

/** auto-merge -> merge-blocked (the table's MERGE_GATE_FAILED_HARD rule),
 * plus a comment saying why, since the label alone doesn't. */
async function blockMerge(
  deps: Deps,
  input: IssueRef,
  currentLabels: string[],
  reason: string,
): Promise<CoordinateResult> {
  const result = await applyEvent(deps, input, EVENTS.MERGE_GATE_FAILED_HARD, currentLabels);
  if (result.outcome === "applied") {
    await depsFor(deps, EVENTS.MERGE_GATE_FAILED_HARD).io.commentOnIssue(
      input.owner,
      input.repo,
      input.issueNumber,
      `🛑 Not merging: ${reason}. \`auto-merge\` is replaced by \`${LABELS.MERGE_BLOCKED}\`. ` +
        `Fix it, then re-add \`auto-merge\` to try again. (Automatic, from the orchestrator's merge gate.)`,
    );
  }
  return result;
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

  // Same reading as when auto-merge is added. CI often fails within seconds
  // of a push, before GitHub has computed `mergeable`; waiting on that here
  // dropped the red CI for good (nothing else re-checks it), so an unknown
  // `mergeable` counts as "no known conflict", as hardBlockReason reads it.
  const facts = await settledGateFacts(deps, input);
  if (facts.checkRuns.some((c) => c.status !== "completed")) return { outcome: "no_event" };

  const reason = hardBlockReason(facts);
  if (reason) return blockMerge(deps, input, currentLabels, reason);
  if (failedCheckNames(facts).length > 0) return handToRework(deps, input, currentLabels, facts);
  return { outcome: "no_event" };
}

/** The shared reduce() -> labelOps() -> fire/log tail, once an Event has
 * been decided (however it was decided) and the current labels are
 * already in hand. */
async function applyEvent(
  allDeps: Deps,
  input: IssueRef,
  event: Event,
  currentLabels: string[],
): Promise<CoordinateResult> {
  const { io: deps, mode } = depsFor(allDeps, event);
  // Present when a webhook caused this; the watchdog passes its pending fire.
  const deliveryId = (input as Partial<CoordinateInput>).deliveryId || null;
  const justAdded = LABEL_JUST_ADDED_BY[event];
  const labelsBeforeThisEvent = justAdded
    ? currentLabels.filter((l) => l !== justAdded)
    : currentLabels;
  const current = deriveState(labelsBeforeThisEvent);
  if (current === "ambiguous") {
    await deps.logTransition({
      deliveryId,
      owner: input.owner,
      repo: input.repo,
      issueNumber: input.issueNumber,
      fromState: "ambiguous",
      event,
      toEffect: null,
      run: null,
      droppedReason: "ambiguous current state — multiple tracked labels present",
      mode,
    });
    return { outcome: "ambiguous_state" };
  }

  const rule = reduce(current, event);
  if (!rule && CONTEXTUAL_EVENTS.has(event)) return { outcome: "ignored", from: current, event };
  if (!rule) {
    await deps.logTransition({
      deliveryId,
      owner: input.owner,
      repo: input.repo,
      issueNumber: input.issueNumber,
      fromState: current,
      event,
      toEffect: null,
      run: null,
      droppedReason: "no matching rule for this (state, event) pair",
      mode,
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
    deliveryId,
    owner: input.owner,
    repo: input.repo,
    issueNumber: input.issueNumber,
    fromState: current,
    event,
    toEffect: JSON.stringify(rule.to),
    run: rule.run ?? null,
    droppedReason: null,
    mode,
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
  // The alert is a write too: only real when watchdog_expired is enforced.
  await depsFor(deps, EVENTS.WATCHDOG_EXPIRED).io.commentOnIssue(
    pending.owner,
    pending.repo,
    pending.issueNumber,
    `⚠️ The \`${pending.run}\` routine hasn't reported back within ${deps.watchdogMinutes(pending.run)} minutes — it may have died mid-run.${lastStep}${next} ` +
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
  // A human re-added auto-merge to a merge-blocked PR that's still blocked:
  // read it as auto-merge, so the hard-block rule swaps it back to
  // merge-blocked (which is already there, so only auto-merge comes off).
  if (tracked.length === 2 && tracked.includes(LABELS.MERGE_BLOCKED) && tracked.includes(LABELS.AUTO_MERGING)) {
    return LABELS.AUTO_MERGING;
  }
  return "ambiguous";
}
