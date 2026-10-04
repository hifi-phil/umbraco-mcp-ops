// The absolute list of every label this system tracks. This is the one
// place a label's spelling is written down — graph.ts's State, its rules
// table, and github/from-github.ts's webhook matching all import from here rather
// than retyping the string, so a rename is a one-line change in this file,
// not a grep-and-hope across three files. The same goes for all of the
// TypeScript: code and tests use LABELS, comments name the key
// (AUTO_MERGING), and worker/test/label-spellings.test.ts fails on a label
// spelled out anywhere else. Only what can't import this (the skills,
// loop-dispatch's route-event.sh, the docs, SQL, the .mjs scripts) spells
// them.
//
// These are today's LIVE GitHub spellings, on purpose. A cleaner naming
// scheme is proposed in 10-label-rename.md (ai-ready, ai-generated, and
// gerunds for the command-form ones: auto-releasing, ai-discussing,
// auto-reworking, auto-merging). It was briefly applied to this text while
// the live labels stayed old, which broke real loop runs, so it's deferred
// until the basic lane works under the reducer, then done as one cutover
// (live labels + routine triggers + this file + the skills together).
//
// The keys (AI_READY, AUTO_MERGING, …) already use the proposed names and
// stay as they are, so the eventual rename only changes the values below.
//
// ai-stuck has no older spelling: it's written by the DO's watchdog, never
// by a human or a loop ("an AI routine was fired on this and never reported
// an outcome"), see 03-components.md §3.4.
//
// merge-blocked marks a PR that can't merge without a human: a merge conflict
// or requested changes, found when auto-merge is added or while it waits.
// Separate from ai-blocked, which means the build loop gave up on an issue
// (or, on a PR, that the review blocked it: the approach needs a person).
//
// ai-review is on a PR while it waits for, or is under, the review-loop's
// adversarial review (15-agent-splits.md): added by the build (or a person,
// to re-run it), it fires the review once CI is green.

export const LABELS = {
  AI_READY: "ready-for-ai",
  AI_GENERATED: "generated-by-ai",
  AI_BLOCKED: "ai-blocked",
  AUTO_RELEASING: "auto-release",
  AI_DISCUSSING: "ai-discuss",
  AUTO_REWORKING: "auto-rework",
  AUTO_MERGING: "auto-merge",
  AI_STUCK: "ai-stuck",
  MERGE_BLOCKED: "merge-blocked",
  AI_REVIEWING: "ai-review",
} as const;

export type Label = (typeof LABELS)[keyof typeof LABELS];

/** Same ten values as LABELS, as an array — for anything that needs to
 * iterate all of them (a dashboard, a check against a live repo's actual
 * label set, a "does this string name a tracked label" guard). */
export const ALL_LABELS: readonly Label[] = Object.values(LABELS);
