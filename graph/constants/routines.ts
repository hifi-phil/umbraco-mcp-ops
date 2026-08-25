// The absolute list of every loop/routine the reducer can fire. Real skill
// names from plugins/*/skills/*/SKILL.md, not invented — see
// 09-phase-1-real-graph.md for the audit each one comes from.
//
// Before this, `Rule.run` was typed as a bare `string`, so a typo
// ("issue-buld-loop") would compile cleanly and only fail at runtime,
// against the real routines API. Same category of gap LABELS closed.

export const ROUTINES = {
  ISSUE_BUILD_LOOP: "issue-build-loop",
  AUTO_RELEASE_LOOP: "auto-release-loop",
  ISSUE_DISCUSS_LOOP: "issue-discuss-loop",
  REWORK_LOOP: "rework-loop",
  MERGE_FLOW: "merge-flow",
} as const;

export type Routine = (typeof ROUTINES)[keyof typeof ROUTINES];

export const ALL_ROUTINES: readonly Routine[] = Object.values(ROUTINES);
