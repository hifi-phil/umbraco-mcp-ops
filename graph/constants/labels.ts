// The absolute list of every label this system tracks. This is the one
// place a label's spelling is written down — graph.ts's State, its rules
// table, and github/from-github.ts's webhook matching all import from here rather
// than retyping the string, so a rename is a one-line change in this file,
// not a grep-and-hope across three files. See 10-label-rename.md for the
// full mapping from today's live label spelling to the proposed one used
// here — nothing here renames a live GitHub label yet.
//
// Naming rationale for the seven values:
//
// 1. Command-form vs. state-form. Three of today's live labels already
//    read as a *state* (ready-for-ai, generated-by-ai, ai-blocked —
//    adjectival, describing a condition) while four read as a *command*
//    (auto-release, ai-discuss, auto-rework, auto-merge — imperative,
//    "please do this"). A tracked State has to describe an ongoing
//    condition, not an instruction, so the four command-form labels use
//    the gerund here: auto-releasing, ai-discussing, auto-reworking,
//    auto-merging.
//
// 2. `ai` as suffix vs. prefix. Within the family of labels describing an
//    issue's relationship to AI-authored work, two put `ai` at the end
//    (ready-for-ai, generated-by-ai) and two put it at the front
//    (ai-blocked, ai-discussing). Renamed the suffix pair to prefix form:
//    ai-ready, ai-generated.
//
// Deliberately NOT folded into the "ai-*" family: auto-releasing,
// auto-reworking, auto-merging. Those aren't a statement about AI
// authorship of the issue — they're a request for a specific automated git
// action (release/rework/merge). That's a real semantic line, not a
// spelling accident, so "auto-*" stays its own namespace.

export const LABELS = {
  AI_READY: "ai-ready",
  AI_GENERATED: "ai-generated",
  AI_BLOCKED: "ai-blocked",
  AUTO_RELEASING: "auto-releasing",
  AI_DISCUSSING: "ai-discussing",
  AUTO_REWORKING: "auto-reworking",
  AUTO_MERGING: "auto-merging",
} as const;

export type Label = (typeof LABELS)[keyof typeof LABELS];

/** Same seven values as LABELS, as an array — for anything that needs to
 * iterate all of them (a dashboard, a check against a live repo's actual
 * label set, a "does this string name a tracked label" guard). */
export const ALL_LABELS: readonly Label[] = Object.values(LABELS);
