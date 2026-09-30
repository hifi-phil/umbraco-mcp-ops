// The transition table and reducer for the agent-orchestration state machine.
// Derived from the real behaviour of loop-dispatch and the five loop skills
// it fires — see the design doc's 09-phase-1-real-graph.md for the audit
// this table is built from. Not the abstract sketch from the original draft.
//
// State is deliberately the literal GitHub label string (via LABELS in
// constants/labels.ts), not a separate renamed internal concept — one
// vocabulary throughout, not a translation at every layer. A separate
// "building" name for the "ready-for-ai" label bought nothing but a mapping
// table to keep in sync, and keeping two names for one thing is exactly
// what let "remove ready-for-ai" go missing silently. See constants/labels.ts
// for the spelling (today's live labels) and 10-label-rename.md for the
// deferred rename.
//
// Event (constants/events.ts) and Routine (constants/routines.ts) are the
// same idea applied to the rest of this table's vocabulary — every fixed
// string spelled once, not retyped per file. Event still earns its own
// distinct vocabulary from State/Label, though: build_succeeded,
// build_blocked and the merge_gate_* events are synthesized from several
// real signals (CI status, mcp-review's verdict, github-ops' gate checks) —
// there's no single webhook that means any of them. See github/from-github.ts.
//
// This file is deliberately just the state machine — deciding which rule
// fired. Turning that rule's effect into concrete GitHub calls is a
// separate stage with a different input (the labels actually present right
// now) and output; see github/to-github.ts.

import { EVENTS, type Event } from "./constants/events";
import { LABELS, type Label } from "./constants/labels";
import { ROUTINES, type Routine } from "./constants/routines";
import { close, label, noop, unlabel, type Effect } from "./github/to-github";

export type State = "none" | Label; // "none" = no tracking label, not a real GitHub label

export type Rule = {
  from: State;
  on: Event;
  to: Effect;
  run?: Routine; // which loop/routine to fire, if any
  verifiedBy: "deterministic" | "external-judgment"; // see 02-design-principles.md
};

export const rules: Rule[] = [
  // --- issue lifecycle ---
  {
    from: "none",
    on: EVENTS.LABELLED_AI_READY,
    to: label(LABELS.AI_READY),
    run: ROUTINES.ISSUE_BUILD_LOOP,
    verifiedBy: "external-judgment", // a human decided this issue is ready
  },
  {
    // Keyed on the POST-swap state, not AI_READY: issue-build-loop's own
    // Step 3 always swaps the label before posting this outcome comment,
    // so by the time this event reaches the reducer, AI_READY is already
    // gone — a rule keyed on AI_READY can never fire. `to: noop` because
    // there's nothing left to write; this rule exists to confirm the swap
    // already happened, same idempotent-confirm shape as MERGED below.
    from: LABELS.AI_GENERATED,
    on: EVENTS.BUILD_SUCCEEDED,
    to: noop,
    verifiedBy: "external-judgment", // composite fact includes mcp-review's judgment, not just CI
  },
  {
    // Same reasoning as BUILD_SUCCEEDED above — issue-build-loop swaps to
    // AI_BLOCKED before commenting, so key on the post-swap state.
    from: LABELS.AI_BLOCKED,
    on: EVENTS.BUILD_BLOCKED,
    to: noop,
    verifiedBy: "external-judgment", // the agent decided the issue was ambiguous / capped out
  },
  // --- Phase 5: the orchestrator owns the swap ---
  // On a repo the Worker dispatches, the fire text tells the loop the
  // orchestrator owns labels (routines-client.ts's dispatchText), so the loop
  // posts its outcome marker and does NOT swap. The outcome then arrives while
  // the trigger label is still on, and these pre-swap rules make the Worker do
  // the swap. The post-swap rules above stay for repos whose loops still swap.
  {
    from: LABELS.AI_READY,
    on: EVENTS.BUILD_SUCCEEDED,
    to: label(LABELS.AI_GENERATED),
    verifiedBy: "external-judgment",
  },
  {
    from: LABELS.AI_READY,
    on: EVENTS.BUILD_BLOCKED,
    to: label(LABELS.AI_BLOCKED),
    verifiedBy: "external-judgment",
  },
  {
    from: LABELS.AUTO_RELEASING,
    on: EVENTS.RELEASE_BLOCKED,
    to: unlabel,
    verifiedBy: "external-judgment",
  },
  {
    from: "none",
    on: EVENTS.LABELLED_AUTO_RELEASING,
    to: label(LABELS.AUTO_RELEASING),
    run: ROUTINES.AUTO_RELEASE_LOOP,
    verifiedBy: "external-judgment", // a human decided to release
  },
  {
    // Keyed on the POST-swap state, not AUTO_RELEASING: auto-release-loop's
    // Step 2.5 removes AUTO_RELEASING before posting this outcome comment
    // (creating a separate new issue for the block, which isn't a tracked
    // label on the triggering issue) — so by the time this event reaches
    // the reducer, state has already moved to "none". Same reasoning as
    // BUILD_SUCCEEDED/BUILD_BLOCKED above.
    from: "none",
    on: EVENTS.RELEASE_BLOCKED,
    to: noop,
    verifiedBy: "external-judgment", // release-reviewer's BLOCK verdict — an independent agent's judgment
  },
  {
    // Unlike the three rules above, auto-release-loop's Step 4 does NOT
    // remove AUTO_RELEASING before commenting + closing — it just closes.
    // So this is the one outcome-artifact rule that was already correctly
    // keyed on the pre-comment state; kept as-is, and it's the reference
    // shape the other three now match.
    from: LABELS.AUTO_RELEASING,
    on: EVENTS.RELEASE_PUBLISHED,
    to: close,
    // The underlying facts (merged, tagged, GitHub Release created, dev
    // synced) ARE deterministic — but as implemented, translate() sources
    // this from auto-release-loop's self-reported outcome comment (see
    // 11-outcome-artifact.md), not by independently correlating those
    // native signals. Tagged external-judgment to be honest about what's
    // actually verified today, not what could be. A future implementation
    // that watches for the real merge+tag+release chain directly would
    // earn "deterministic" back.
    verifiedBy: "external-judgment",
  },
  {
    from: "none",
    on: EVENTS.LABELLED_AI_DISCUSSING,
    to: label(LABELS.AI_DISCUSSING),
    run: ROUTINES.ISSUE_DISCUSS_LOOP,
    verifiedBy: "external-judgment", // a human decided this needs discussion
  },
  {
    // Each trusted reply fires the next round; the state doesn't change.
    // Leaving ai-discuss stays human-owned: no outbound rule for that.
    from: LABELS.AI_DISCUSSING,
    on: EVENTS.DISCUSSION_REPLY,
    to: noop,
    run: ROUTINES.ISSUE_DISCUSS_LOOP,
    verifiedBy: "external-judgment", // a human wrote the reply
  },
  {
    // auto-release-loop's Step 4 closes the issue on publish, with the
    // label still on. The native close is enough to know the run ended,
    // with or without the release_published comment.
    from: LABELS.AUTO_RELEASING,
    on: EVENTS.ISSUE_CLOSED,
    to: noop,
    verifiedBy: "deterministic",
  },

  // --- PR lifecycle ---
  {
    from: "none",
    on: EVENTS.LABELLED_AUTO_REWORKING,
    to: label(LABELS.AUTO_REWORKING),
    run: ROUTINES.REWORK_LOOP,
    verifiedBy: "external-judgment", // a reviewer decided rework was needed
  },
  {
    from: LABELS.AUTO_REWORKING,
    on: EVENTS.REWORK_PUSHED,
    to: unlabel,
    verifiedBy: "deterministic", // a git push is directly observable
  },
  {
    from: "none",
    on: EVENTS.LABELLED_AUTO_MERGING,
    to: label(LABELS.AUTO_MERGING),
    run: ROUTINES.MERGE_FLOW,
    verifiedBy: "external-judgment", // the auto-merge label IS the human approval signal
  },
  {
    from: LABELS.AUTO_MERGING,
    on: EVENTS.MERGE_GATE_FAILED_SOFT,
    to: noop, // matches merge-flow's real Step 4: "by default leave the auto-merge label on" — no GitHub write, not a redundant remove+re-add; the reconciliation sweep re-fires it later
    // Genuinely earned, not aspirational: worker/src/coordinate.ts's
    // handleCheckSuiteCompleted independently fetches the full check-run
    // list, review state, and mergeability (github/merge-gate.ts's
    // deriveMergeGateOutcome) rather than trusting a self-report — see
    // worker/README.md.
    verifiedBy: "deterministic",
  },
  {
    from: LABELS.AUTO_MERGING,
    on: EVENTS.MERGE_GATE_FAILED_HARD,
    to: unlabel, // needs a human; matches merge-flow's real Step 4
    verifiedBy: "deterministic", // same real aggregation as MERGE_GATE_FAILED_SOFT above
  },
  {
    from: LABELS.AUTO_MERGING,
    on: EVENTS.MERGED,
    to: close, // idempotent: merge-flow's own merge call already closes the PR natively; this just confirms it
    verifiedBy: "deterministic",
  },

  // --- a loop taking its own trigger label off ---
  // Native and reliable: in shadow run 1 every build and release removed its
  // trigger label, but only 1 of 4 posted the outcome comment. So removal is
  // what ends a run as far as the watchdog is concerned. to: noop (the label
  // is already gone); no `run`, so applying the rule clears pendingFire.
  // Keyed on every state the removal can leave behind: "none", the build's
  // outcome labels (if they landed first), and ai-stuck (a late loop).
  ...(
    [
      [EVENTS.UNLABELLED_AI_READY, ["none", LABELS.AI_GENERATED, LABELS.AI_BLOCKED, LABELS.AI_STUCK]],
      [EVENTS.UNLABELLED_AUTO_RELEASING, ["none", LABELS.AI_STUCK]],
      [EVENTS.UNLABELLED_AUTO_REWORKING, ["none", LABELS.AI_STUCK]],
      [EVENTS.UNLABELLED_AUTO_MERGING, ["none", LABELS.AI_STUCK]],
    ] as const
  ).flatMap(([on, froms]) =>
    froms.map((from): Rule => ({ from, on, to: noop, verifiedBy: "deterministic" })),
  ),

  // --- the watchdog: a fired routine that never reported back ---
  // 03-components.md §3.4: "Alarm fires instead, the agent died — move to
  // state:stuck." Keyed on the in-flight trigger labels only. Not
  // generated-by-ai / ai-blocked: a build that swapped to those has
  // finished, whether or not it posted its outcome comment (shadow run 1
  // would have marked finished build #116 stuck). The table doubles as the
  // watch list — coordinate.ts only arms the watchdog for a fired routine
  // whose target state has a watchdog_expired rule here, so ai-discuss
  // (issue-discuss-loop posts no outcome artifact, ever) is deliberately
  // absent rather than raising a false alarm on every discussion.
  ...(
    [LABELS.AI_READY, LABELS.AUTO_RELEASING, LABELS.AUTO_REWORKING, LABELS.AUTO_MERGING] as const
  ).map(
    (from): Rule => ({
      from,
      on: EVENTS.WATCHDOG_EXPIRED,
      to: label(LABELS.AI_STUCK),
      // The DO observed this itself: no outcome for the attempt it fired,
      // within the window. Not a guess about *why* — only that it didn't
      // arrive, which is all this transition claims.
      verifiedBy: "deterministic",
    }),
  ),

  // --- leaving ai-stuck ---
  // Two ways out. (1) A late outcome: the routine was slow, not dead, and
  // its authoritative outcome still wins — same verifiedBy as the normal
  // rule for that outcome. The routine's own label swap will usually have
  // landed first, leaving e.g. ai-stuck + generated-by-ai together;
  // coordinate.ts's deriveState() reads that specific pair as ai-stuck, and
  // labelOps() then just removes ai-stuck. (2) A human retry: re-adding the
  // trigger label on a stuck issue re-fires its loop, exactly as from "none".
  {
    from: LABELS.AI_STUCK,
    on: EVENTS.BUILD_SUCCEEDED,
    to: label(LABELS.AI_GENERATED),
    verifiedBy: "external-judgment",
  },
  {
    from: LABELS.AI_STUCK,
    on: EVENTS.BUILD_BLOCKED,
    to: label(LABELS.AI_BLOCKED),
    verifiedBy: "external-judgment",
  },
  { from: LABELS.AI_STUCK, on: EVENTS.RELEASE_BLOCKED, to: unlabel, verifiedBy: "external-judgment" },
  { from: LABELS.AI_STUCK, on: EVENTS.RELEASE_PUBLISHED, to: close, verifiedBy: "external-judgment" },
  { from: LABELS.AI_STUCK, on: EVENTS.REWORK_PUSHED, to: unlabel, verifiedBy: "deterministic" },
  { from: LABELS.AI_STUCK, on: EVENTS.MERGED, to: close, verifiedBy: "deterministic" },
  {
    from: LABELS.AI_STUCK,
    on: EVENTS.LABELLED_AI_READY,
    to: label(LABELS.AI_READY),
    run: ROUTINES.ISSUE_BUILD_LOOP,
    verifiedBy: "external-judgment", // a human decided to retry
  },
  {
    from: LABELS.AI_STUCK,
    on: EVENTS.LABELLED_AUTO_RELEASING,
    to: label(LABELS.AUTO_RELEASING),
    run: ROUTINES.AUTO_RELEASE_LOOP,
    verifiedBy: "external-judgment",
  },
  {
    from: LABELS.AI_STUCK,
    on: EVENTS.LABELLED_AUTO_REWORKING,
    to: label(LABELS.AUTO_REWORKING),
    run: ROUTINES.REWORK_LOOP,
    verifiedBy: "external-judgment",
  },
  {
    from: LABELS.AI_STUCK,
    on: EVENTS.LABELLED_AUTO_MERGING,
    to: label(LABELS.AUTO_MERGING),
    run: ROUTINES.MERGE_FLOW,
    verifiedBy: "external-judgment",
  },
];

/**
 * Events that only mean something in a few states. A push is a rework only
 * on an auto-rework PR, a merge matters only under auto-merge, a comment
 * is a round only on an ai-discuss issue. Anywhere else they're ordinary
 * activity, not a missing rule, so coordinate.ts ignores them silently when
 * no rule matches instead of logging a "gap" (shadow run 1: 8 of 26 rows
 * were this noise).
 */
export const CONTEXTUAL_EVENTS: ReadonlySet<Event> = new Set([
  EVENTS.REWORK_PUSHED,
  EVENTS.MERGED,
  EVENTS.DISCUSSION_REPLY,
  EVENTS.ISSUE_CLOSED,
  EVENTS.UNLABELLED_AI_READY,
  EVENTS.UNLABELLED_AUTO_RELEASING,
  EVENTS.UNLABELLED_AUTO_REWORKING,
  EVENTS.UNLABELLED_AUTO_MERGING,
]);

/** Whether a routine fired into `state` should be watched: true exactly
 * when the table says what a watchdog expiry from that state means. */
export function isWatched(state: State): boolean {
  return reduce(state, EVENTS.WATCHDOG_EXPIRED) !== null;
}

export function reduce(current: State, event: Event): Rule | null {
  return rules.find((r) => r.from === current && r.on === event) ?? null;
}
