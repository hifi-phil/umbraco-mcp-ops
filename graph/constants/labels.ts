// The absolute list of every label this system tracks. This is the one
// place a label's spelling is written down — graph.ts's State, its rules
// table, and github/from-github.ts's webhook matching all import from here rather
// than retyping the string, so a rename is a one-line change in this file,
// not a grep-and-hope across three files. The same goes for all of the
// TypeScript: code and tests use LABELS, comments write LABELS.AUTO_MERGING
// (doc comments {@link LABELS.AUTO_MERGING}, so a rename-symbol updates them
// too), and worker/test/label-spellings.test.ts fails on a label spelled out
// anywhere else. Only what can't import this (the skills,
// loop-dispatch's route-event.sh, the docs, SQL, the .mjs scripts) spells
// them.
//
// These are the live GitHub spellings since the label rename
// (10-label-rename.md): every tracked label names a state, not a command
// (auto-merging, not auto-merge), and the issue's labels name its stage
// (ai-ready -> pr-open). A spelling change is one cutover: the live labels
// on each repo, this file and the skills together, never this file alone.
//
// ai-stuck has no older spelling: it's written by the DO's watchdog, never
// by a human or a loop ("an AI routine was fired on this and never reported
// an outcome"), see 03-components.md §3.4.
//
// merge-blocked marks a PR that can't merge without a human: a merge conflict
// or requested changes, found when auto-merging is added or while it waits.
// Separate from ai-blocked, which means the build loop gave up on an issue
// (or, on a PR, that the review blocked it: the approach needs a person).
//
// ai-reviewing is on a PR while it waits for, or is under, the review-loop's
// adversarial review (15-agent-splits.md): added by the build (or a person,
// to re-run it), it fires the review once CI is green.

export const LABELS = {
  AI_READY: "ai-ready",
  PR_OPEN: "pr-open",
  AI_BLOCKED: "ai-blocked",
  AUTO_RELEASING: "auto-releasing",
  AI_DISCUSSING: "ai-discussing",
  AUTO_REWORKING: "auto-reworking",
  AUTO_MERGING: "auto-merging",
  AI_STUCK: "ai-stuck",
  MERGE_BLOCKED: "merge-blocked",
  AI_REVIEWING: "ai-reviewing",
  // The issue's stage after pr-open: its PR merged into dev, waiting for a
  // release. Set from the PR's "Closes #N" when it merges; the release that
  // contains the merge closes the issue.
  READY_FOR_RELEASE: "ready-for-release",
} as const;

export type Label = (typeof LABELS)[keyof typeof LABELS];

/** Same eleven values as LABELS, as an array — for anything that needs to
 * iterate all of them (a dashboard, a check against a live repo's actual
 * label set, a "does this string name a tracked label" guard). */
export const ALL_LABELS: readonly Label[] = Object.values(LABELS);
