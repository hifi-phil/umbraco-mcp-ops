// The transition table and reducer for the agent-orchestration state machine.
// Derived from the real behaviour of loop-dispatch and the five loop skills
// it fires — see the design doc's 09-phase-1-real-graph.md for the audit
// this table is built from. Not the abstract sketch from the original draft.

export type State =
  // issue lifecycle
  | "backlog"
  | "building"
  | "generated-by-ai"
  | "ai-blocked"
  | "releasing"
  | "discussing"
  // PR lifecycle
  | "pr-none"
  | "reworking"
  | "merge-pending";

export type Event =
  // issue lifecycle
  | "labelled_ready_for_ai"
  | "build_succeeded"
  | "build_blocked"
  | "labelled_auto_release"
  | "release_blocked"
  | "release_published"
  | "labelled_ai_discuss"
  // PR lifecycle
  | "labelled_auto_rework"
  | "rework_pushed"
  | "labelled_auto_merge"
  | "merge_gate_failed_soft"
  | "merge_gate_failed_hard"
  | "merged";

export type Effect =
  | { kind: "label"; value: State }
  | { kind: "unlabel"; value: State }
  | { kind: "close" }; // native GitHub close, not a label — see auto-release-loop precedent

export function label(value: State): Effect {
  return { kind: "label", value };
}
export function unlabel(value: State): Effect {
  return { kind: "unlabel", value };
}
export const close: Effect = { kind: "close" };

export type Rule = {
  from: State;
  on: Event;
  to: Effect;
  run?: string; // which loop/routine to fire, if any
  verifiedBy: "deterministic" | "external-judgment"; // see 02-design-principles.md
};

export const rules: Rule[] = [
  // --- issue lifecycle ---
  {
    from: "backlog",
    on: "labelled_ready_for_ai",
    to: label("building"),
    run: "issue-build-loop",
    verifiedBy: "external-judgment", // a human decided this issue is ready
  },
  {
    from: "building",
    on: "build_succeeded",
    to: label("generated-by-ai"),
    verifiedBy: "external-judgment", // composite fact includes mcp-review's judgment, not just CI
  },
  {
    from: "building",
    on: "build_blocked",
    to: label("ai-blocked"),
    verifiedBy: "external-judgment", // the agent decided the issue was ambiguous / capped out
  },
  {
    from: "backlog",
    on: "labelled_auto_release",
    to: label("releasing"),
    run: "auto-release-loop",
    verifiedBy: "external-judgment", // a human decided to release
  },
  {
    from: "releasing",
    on: "release_blocked",
    to: unlabel("releasing"),
    verifiedBy: "external-judgment", // release-reviewer's BLOCK verdict — an independent agent's judgment
  },
  {
    from: "releasing",
    on: "release_published",
    to: close,
    verifiedBy: "deterministic", // merge + tag + GitHub Release are all directly observable
  },
  {
    from: "backlog",
    on: "labelled_ai_discuss",
    to: label("discussing"),
    run: "issue-discuss-loop",
    verifiedBy: "external-judgment", // a human decided this needs discussion
  },
  // deliberately no outbound rules from "discussing" — see README:
  // this state is human-owned by design and doesn't need to enter the reducer at all.

  // --- PR lifecycle ---
  {
    from: "pr-none",
    on: "labelled_auto_rework",
    to: label("reworking"),
    run: "rework-loop",
    verifiedBy: "external-judgment", // a reviewer decided rework was needed
  },
  {
    from: "reworking",
    on: "rework_pushed",
    to: unlabel("reworking"),
    verifiedBy: "deterministic", // a git push is directly observable
  },
  {
    from: "pr-none",
    on: "labelled_auto_merge",
    to: label("merge-pending"),
    run: "merge-flow",
    verifiedBy: "external-judgment", // the auto-merge label IS the human approval signal
  },
  {
    from: "merge-pending",
    on: "merge_gate_failed_soft",
    to: label("merge-pending"), // stays — the reconciliation sweep re-fires it later
    verifiedBy: "deterministic",
  },
  {
    from: "merge-pending",
    on: "merge_gate_failed_hard",
    to: unlabel("merge-pending"), // needs a human; matches merge-flow's real Step 4
    verifiedBy: "deterministic",
  },
  {
    from: "merge-pending",
    on: "merged",
    to: close,
    verifiedBy: "deterministic",
  },
];

export function reduce(current: State, event: Event): Rule | null {
  return rules.find((r) => r.from === current && r.on === event) ?? null;
}
