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
  | { kind: "unlabel" }
  | { kind: "close" } // native GitHub close, not a label — see auto-release-loop precedent
  | { kind: "noop" }; // no GitHub write at all — e.g. a soft merge-gate failure leaves the label exactly as-is

export function label(value: State): Effect {
  return { kind: "label", value };
}
export const unlabel: Effect = { kind: "unlabel" };
export const close: Effect = { kind: "close" };
export const noop: Effect = { kind: "noop" };

// The literal GitHub label that represents each State while it's current.
// null means "no tracking label" — backlog and pr-none are the absence of
// one, not a label literally named "backlog"/"pr-none". This mapping is what
// was missing before: without it, an "unlabel" effect has no way to know
// *which* real label to remove.
export const githubLabel: Record<State, string | null> = {
  backlog: null,
  building: "ready-for-ai",
  "generated-by-ai": "generated-by-ai",
  "ai-blocked": "ai-blocked",
  releasing: "auto-release",
  discussing: "ai-discuss",
  "pr-none": null,
  reworking: "auto-rework",
  "merge-pending": "auto-merge",
};

export type LabelOp =
  | { op: "add"; label: string }
  | { op: "remove"; label: string }
  | { op: "close" };

/**
 * The concrete GitHub calls a fired rule requires, given the labels actually
 * present right now — re-read fresh from the API per §3.4, never cached.
 * Diffing against the real current labels (not just assuming `rule.from`'s
 * label is still there) means a label a human already removed by hand isn't
 * redundantly removed again, and a label the *triggering* webhook itself
 * just added (e.g. a human labelling `ready-for-ai`) is never redundantly
 * re-added — it's already in `currentLabels` by the time this runs.
 */
export function labelOps(currentLabels: readonly string[], rule: Rule): LabelOp[] {
  if (rule.to.kind === "noop") return [];
  if (rule.to.kind === "close") return [{ op: "close" }];

  const fromLabel = githubLabel[rule.from];
  const toLabel = rule.to.kind === "label" ? githubLabel[rule.to.value] : null;
  const ops: LabelOp[] = [];

  if (fromLabel && fromLabel !== toLabel && currentLabels.includes(fromLabel)) {
    ops.push({ op: "remove", label: fromLabel });
  }
  if (toLabel && toLabel !== fromLabel && !currentLabels.includes(toLabel)) {
    ops.push({ op: "add", label: toLabel });
  }
  return ops;
}

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
    to: unlabel,
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
    to: unlabel,
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
    to: noop, // matches merge-flow's real Step 4: "by default leave the auto-merge label on" — no GitHub write, not a redundant remove+re-add; the reconciliation sweep re-fires it later
    verifiedBy: "deterministic",
  },
  {
    from: "merge-pending",
    on: "merge_gate_failed_hard",
    to: unlabel, // needs a human; matches merge-flow's real Step 4
    verifiedBy: "deterministic",
  },
  {
    from: "merge-pending",
    on: "merged",
    to: close, // idempotent: merge-flow's own merge call already closes the PR natively; this just confirms it
    verifiedBy: "deterministic",
  },
];

export function reduce(current: State, event: Event): Rule | null {
  return rules.find((r) => r.from === current && r.on === event) ?? null;
}
