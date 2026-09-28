// The absolute list of every domain event the reducer understands.
//
// Unlike LABELS, this one isn't closing a safety gap — translate()'s return
// type is already declared `Event | null`, so the compiler already rejects
// a typo'd event name at the return statement. It exists anyway so every
// fixed-vocabulary string in this system is named once, not just the ones
// the type checker happened to leave exposed — a readability choice, not a
// correctness one.

export const EVENTS = {
  // issue lifecycle
  LABELLED_AI_READY: "labelled_ai_ready",
  BUILD_SUCCEEDED: "build_succeeded",
  BUILD_BLOCKED: "build_blocked",
  LABELLED_AUTO_RELEASING: "labelled_auto_releasing",
  RELEASE_BLOCKED: "release_blocked",
  RELEASE_PUBLISHED: "release_published",
  LABELLED_AI_DISCUSSING: "labelled_ai_discussing",
  // PR lifecycle
  LABELLED_AUTO_REWORKING: "labelled_auto_reworking",
  REWORK_PUSHED: "rework_pushed",
  LABELLED_AUTO_MERGING: "labelled_auto_merging",
  MERGE_GATE_FAILED_SOFT: "merge_gate_failed_soft",
  MERGE_GATE_FAILED_HARD: "merge_gate_failed_hard",
  MERGED: "merged",
  // the watchdog — the one event NOT sourced from GitHub. The DO raises it
  // itself when a routine it fired hasn't produced an outcome within the
  // watchdog window (worker/src/coordinate.ts's coordinateWatchdogExpired).
  // Still a directly-observed fact, not a guess: "no outcome seen for
  // attempt X by time T" is exactly what the DO knows first-hand.
  WATCHDOG_EXPIRED: "watchdog_expired",
} as const;

export type Event = (typeof EVENTS)[keyof typeof EVENTS];

export const ALL_EVENTS: readonly Event[] = Object.values(EVENTS);
