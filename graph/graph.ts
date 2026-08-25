// The transition table and reducer for the agent-orchestration state machine.
// Derived from the real behaviour of loop-dispatch and the five loop skills
// it fires — see the design doc's 09-phase-1-real-graph.md for the audit
// this table is built from. Not the abstract sketch from the original draft.
//
// State is deliberately the literal GitHub label string (via LABELS in
// constants/labels.ts), not a separate renamed internal concept — one
// vocabulary throughout, not a translation at every layer. A separate
// "building" name for the "ai-ready" label bought nothing but a mapping
// table to keep in sync, and keeping two names for one thing is exactly
// what let "remove ai-ready" go missing silently. See constants/labels.ts
// for the naming rationale and 10-label-rename.md for what it means for the
// real, currently-live labels — nothing here renames them yet; this
// describes the proposed target, not today's exact strings.
//
// Event (constants/events.ts) and Routine (constants/routines.ts) are the
// same idea applied to the rest of this table's vocabulary — every fixed
// string spelled once, not retyped per file. Event still earns its own
// distinct vocabulary from State/Label, though: build_succeeded,
// build_blocked and the merge_gate_* events are synthesized from several
// real signals (CI status, mcp-review's verdict, github-ops' gate checks) —
// there's no single webhook that means any of them. See translate.ts.
//
// This file is deliberately just the state machine — deciding which rule
// fired. Turning that rule's effect into concrete GitHub calls is a
// separate stage with a different input (the labels actually present right
// now) and output; see effects.ts.

import { EVENTS, type Event } from "./constants/events";
import { LABELS, type Label } from "./constants/labels";
import { ROUTINES, type Routine } from "./constants/routines";
import { close, label, noop, unlabel, type Effect } from "./effects";

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
    from: LABELS.AI_READY,
    on: EVENTS.BUILD_SUCCEEDED,
    to: label(LABELS.AI_GENERATED),
    verifiedBy: "external-judgment", // composite fact includes mcp-review's judgment, not just CI
  },
  {
    from: LABELS.AI_READY,
    on: EVENTS.BUILD_BLOCKED,
    to: label(LABELS.AI_BLOCKED),
    verifiedBy: "external-judgment", // the agent decided the issue was ambiguous / capped out
  },
  {
    from: "none",
    on: EVENTS.LABELLED_AUTO_RELEASING,
    to: label(LABELS.AUTO_RELEASING),
    run: ROUTINES.AUTO_RELEASE_LOOP,
    verifiedBy: "external-judgment", // a human decided to release
  },
  {
    from: LABELS.AUTO_RELEASING,
    on: EVENTS.RELEASE_BLOCKED,
    to: unlabel,
    verifiedBy: "external-judgment", // release-reviewer's BLOCK verdict — an independent agent's judgment
  },
  {
    from: LABELS.AUTO_RELEASING,
    on: EVENTS.RELEASE_PUBLISHED,
    to: close,
    verifiedBy: "deterministic", // merge + tag + GitHub Release are all directly observable
  },
  {
    from: "none",
    on: EVENTS.LABELLED_AI_DISCUSSING,
    to: label(LABELS.AI_DISCUSSING),
    run: ROUTINES.ISSUE_DISCUSS_LOOP,
    verifiedBy: "external-judgment", // a human decided this needs discussion
  },
  // deliberately no outbound rules from LABELS.AI_DISCUSSING — see README:
  // this state is human-owned by design and doesn't need to enter the reducer at all.

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
    verifiedBy: "deterministic",
  },
  {
    from: LABELS.AUTO_MERGING,
    on: EVENTS.MERGE_GATE_FAILED_HARD,
    to: unlabel, // needs a human; matches merge-flow's real Step 4
    verifiedBy: "deterministic",
  },
  {
    from: LABELS.AUTO_MERGING,
    on: EVENTS.MERGED,
    to: close, // idempotent: merge-flow's own merge call already closes the PR natively; this just confirms it
    verifiedBy: "deterministic",
  },
];

export function reduce(current: State, event: Event): Rule | null {
  return rules.find((r) => r.from === current && r.on === event) ?? null;
}
