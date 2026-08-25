// The core dispatch logic, as a dependency-injected pure(ish) function --
// no ctx.storage, no real fetch, nothing DO-specific. Tested with plain
// vitest (coordinate.test.ts), same as everything in graph/. The DO class
// (issue-coordinator.ts) is a thin wrapper that wires this to real
// storage/D1/GitHub calls; that wiring itself is NOT covered by these
// tests (no Miniflare/vitest-pool-workers in this pass — see
// issue-coordinator.ts's header for what that leaves unverified).

import { ALL_LABELS, LABELS, type Label } from "../../graph/constants/labels";
import { reduce, type Rule, type State } from "../../graph/graph";
import { translate, type WebhookPayload } from "../../graph/github/from-github";
import { labelOps } from "../../graph/github/to-github";
import { EVENTS, type Event } from "../../graph/constants/events";

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

export type PendingFire = { owner: string; repo: string; issueNumber: number; run: string };

export type Deps = {
  getLabels(owner: string, repo: string, issueNumber: number): Promise<string[]>;
  addLabel(owner: string, repo: string, issueNumber: number, label: string): Promise<void>;
  removeLabel(owner: string, repo: string, issueNumber: number, label: string): Promise<void>;
  closeIssue(owner: string, repo: string, issueNumber: number): Promise<void>;
  fireRoutine(routine: string, context: string): Promise<void>;
  logTransition(row: TransitionRow): Promise<void>;
  hasSeenDelivery(deliveryId: string): Promise<boolean>;
  markSeenDelivery(deliveryId: string): Promise<void>;
  setPendingFire(info: PendingFire): Promise<void>;
  clearPendingFire(): Promise<void>;
};

export type CoordinateInput = {
  deliveryId: string;
  owner: string;
  repo: string;
  issueNumber: number;
  payload: WebhookPayload;
};

export type CoordinateResult =
  | { outcome: "deduped" }
  | { outcome: "no_event" }
  | { outcome: "ambiguous_state" }
  | { outcome: "dropped_no_rule"; from: State; event: Event }
  | { outcome: "applied"; from: State; event: Event; rule: Rule };

/**
 * The literal implementation of translate() -> reduce() -> labelOps() +
 * fire, given the labels actually present right now (re-read fresh every
 * time via deps.getLabels — see graph/github/to-github.ts's labelOps()
 * doc comment for why that matters). This function IS the reducer's real
 * decision path; everything graph/ built is exercised here for real.
 */
export async function coordinateWebhook(
  deps: Deps,
  input: CoordinateInput,
): Promise<CoordinateResult> {
  if (input.deliveryId) {
    if (await deps.hasSeenDelivery(input.deliveryId)) return { outcome: "deduped" };
    await deps.markSeenDelivery(input.deliveryId);
  }

  const event = translate(input.payload);
  if (!event) return { outcome: "no_event" };

  // Fresh, per §3.4/to-github.ts's "never cache" principle -- and the one
  // set labelOps() below must see in full (including a label this event
  // itself just added), even though deriveState() below needs it filtered.
  const currentLabels = await deps.getLabels(input.owner, input.repo, input.issueNumber);

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
    await deps.fireRoutine(
      rule.run,
      `Issue #${input.issueNumber} in ${input.owner}/${input.repo}: ${event} -> firing ${rule.run}.`,
    );
    await deps.setPendingFire({
      owner: input.owner,
      repo: input.repo,
      issueNumber: input.issueNumber,
      run: rule.run,
    });
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
  return "ambiguous";
}
