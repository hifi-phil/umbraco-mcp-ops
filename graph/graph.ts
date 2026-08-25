// The transition table and reducer for the agent-orchestration state machine.
// Derived from the real behaviour of loop-dispatch and the five loop skills
// it fires — see the design doc's 09-phase-1-real-graph.md for the audit
// this table is built from. Not the abstract sketch from the original draft.
//
// State is deliberately the literal GitHub label string, not a renamed
// internal concept — one vocabulary throughout, not a translation at every
// layer. A separate "building" name for the "ai-ready" label bought nothing
// but a mapping table to keep in sync, and keeping two names for one thing
// is exactly what let "remove ai-ready" go missing silently.
//
// That collapse exposed two real inconsistencies in today's live labels:
//
// 1. Three read as a *state* (ready-for-ai, generated-by-ai, ai-blocked —
//    adjectival, describing a condition) while four read as a *command*
//    (auto-release, ai-discuss, auto-rework, auto-merge — imperative,
//    "please do this"). A State value has to describe an ongoing condition,
//    not an instruction, so this table uses the gerund form for those four —
//    auto-releasing, ai-discussing, auto-reworking, auto-merging.
//
// 2. Within the "this issue's relationship to AI work" family, two put `ai`
//    as a suffix (ready-for-ai, generated-by-ai) and two put it as a prefix
//    (ai-blocked, ai-discussing). Renamed the suffix pair to prefix form —
//    ai-ready, ai-generated — for one consistent shape.
//
// Deliberately NOT folded into the "ai-*" family: auto-releasing,
// auto-reworking, auto-merging. Those aren't a statement about AI authorship
// of the issue — they're a request for a specific automated git action
// (release/rework/merge). That's a real semantic line, not a spelling
// accident, so "auto-*" stays its own namespace.
//
// See 10-label-rename.md for what any of this means for the real,
// currently-live labels — nothing here renames them yet; this file
// describes the proposed target, not today's exact strings.
//
// Event still earns its own separate vocabulary: build_succeeded,
// build_blocked and the merge_gate_* events are synthesized from several
// real signals (CI status, mcp-review's verdict, github-ops' gate checks) —
// there's no single webhook that means any of them. See translate.ts.

export type State =
  | "none" // no tracking label — an issue in the backlog, or an untouched PR
  | "ai-ready"
  | "ai-generated"
  | "ai-blocked"
  | "auto-releasing"
  | "ai-discussing"
  | "auto-reworking"
  | "auto-merging";

export type Event =
  // issue lifecycle
  | "labelled_ai_ready"
  | "build_succeeded"
  | "build_blocked"
  | "labelled_auto_releasing"
  | "release_blocked"
  | "release_published"
  | "labelled_ai_discussing"
  // PR lifecycle
  | "labelled_auto_reworking"
  | "rework_pushed"
  | "labelled_auto_merging"
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
    from: "none",
    on: "labelled_ai_ready",
    to: label("ai-ready"),
    run: "issue-build-loop",
    verifiedBy: "external-judgment", // a human decided this issue is ready
  },
  {
    from: "ai-ready",
    on: "build_succeeded",
    to: label("ai-generated"),
    verifiedBy: "external-judgment", // composite fact includes mcp-review's judgment, not just CI
  },
  {
    from: "ai-ready",
    on: "build_blocked",
    to: label("ai-blocked"),
    verifiedBy: "external-judgment", // the agent decided the issue was ambiguous / capped out
  },
  {
    from: "none",
    on: "labelled_auto_releasing",
    to: label("auto-releasing"),
    run: "auto-release-loop",
    verifiedBy: "external-judgment", // a human decided to release
  },
  {
    from: "auto-releasing",
    on: "release_blocked",
    to: unlabel,
    verifiedBy: "external-judgment", // release-reviewer's BLOCK verdict — an independent agent's judgment
  },
  {
    from: "auto-releasing",
    on: "release_published",
    to: close,
    verifiedBy: "deterministic", // merge + tag + GitHub Release are all directly observable
  },
  {
    from: "none",
    on: "labelled_ai_discussing",
    to: label("ai-discussing"),
    run: "issue-discuss-loop",
    verifiedBy: "external-judgment", // a human decided this needs discussion
  },
  // deliberately no outbound rules from "ai-discussing" — see README:
  // this state is human-owned by design and doesn't need to enter the reducer at all.

  // --- PR lifecycle ---
  {
    from: "none",
    on: "labelled_auto_reworking",
    to: label("auto-reworking"),
    run: "rework-loop",
    verifiedBy: "external-judgment", // a reviewer decided rework was needed
  },
  {
    from: "auto-reworking",
    on: "rework_pushed",
    to: unlabel,
    verifiedBy: "deterministic", // a git push is directly observable
  },
  {
    from: "none",
    on: "labelled_auto_merging",
    to: label("auto-merging"),
    run: "merge-flow",
    verifiedBy: "external-judgment", // the auto-merge label IS the human approval signal
  },
  {
    from: "auto-merging",
    on: "merge_gate_failed_soft",
    to: noop, // matches merge-flow's real Step 4: "by default leave the auto-merge label on" — no GitHub write, not a redundant remove+re-add; the reconciliation sweep re-fires it later
    verifiedBy: "deterministic",
  },
  {
    from: "auto-merging",
    on: "merge_gate_failed_hard",
    to: unlabel, // needs a human; matches merge-flow's real Step 4
    verifiedBy: "deterministic",
  },
  {
    from: "auto-merging",
    on: "merged",
    to: close, // idempotent: merge-flow's own merge call already closes the PR natively; this just confirms it
    verifiedBy: "deterministic",
  },
];

export function reduce(current: State, event: Event): Rule | null {
  return rules.find((r) => r.from === current && r.on === event) ?? null;
}

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
 * just added (e.g. a human labelling `ai-ready`) is never redundantly
 * re-added — it's already in `currentLabels` by the time this runs.
 *
 * No mapping table needed here any more: `rule.from`/`rule.to.value` already
 * *are* the real label strings.
 */
export function labelOps(currentLabels: readonly string[], rule: Rule): LabelOp[] {
  if (rule.to.kind === "noop") return [];
  if (rule.to.kind === "close") return [{ op: "close" }];

  const fromLabel = rule.from === "none" ? null : rule.from;
  const toLabel = rule.to.kind === "label" ? rule.to.value : null;
  const ops: LabelOp[] = [];

  if (fromLabel && fromLabel !== toLabel && currentLabels.includes(fromLabel)) {
    ops.push({ op: "remove", label: fromLabel });
  }
  if (toLabel && toLabel !== fromLabel && !currentLabels.includes(toLabel)) {
    ops.push({ op: "add", label: toLabel });
  }
  return ops;
}
