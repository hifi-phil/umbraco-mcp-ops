// The absolute list of every label this system tracks. This is the one
// place a label's spelling is written down — graph.ts's State, its rules
// table, and github/from-github.ts's webhook matching all import from here rather
// than retyping the string, so a rename is a one-line change in this file,
// not a grep-and-hope across three files.
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

export const LABELS = {
  AI_READY: "ready-for-ai",
  AI_GENERATED: "generated-by-ai",
  AI_BLOCKED: "ai-blocked",
  AUTO_RELEASING: "auto-release",
  AI_DISCUSSING: "ai-discuss",
  AUTO_REWORKING: "auto-rework",
  AUTO_MERGING: "auto-merge",
  AI_STUCK: "ai-stuck",
} as const;

export type Label = (typeof LABELS)[keyof typeof LABELS];

/** Same eight values as LABELS, as an array — for anything that needs to
 * iterate all of them (a dashboard, a check against a live repo's actual
 * label set, a "does this string name a tracked label" guard). */
export const ALL_LABELS: readonly Label[] = Object.values(LABELS);
