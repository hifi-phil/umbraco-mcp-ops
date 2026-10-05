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
  // A trusted human's reply on an open LABELS.AI_DISCUSSING issue: loop-dispatch fires
  // the next discussion round on it (route-event.sh's issue_comment case).
  DISCUSSION_REPLY: "discussion_reply",
  // The loop (or a human) taking its trigger label off. Native, and the
  // loops do it every time, unlike the outcome comment (shadow run 1, see
  // 13-shadow-results.md), so it's what tells the watchdog a run is over.
  UNLABELLED_AI_READY: "unlabelled_ai_ready",
  UNLABELLED_AUTO_RELEASING: "unlabelled_auto_releasing",
  // auto-release-loop's Step 4 closes the issue on publish.
  ISSUE_CLOSED: "issue_closed",
  // PR lifecycle
  LABELLED_AUTO_REWORKING: "labelled_auto_reworking",
  REWORK_PUSHED: "rework_pushed",
  // A push by a rework the Worker started because CI failed under
  // LABELS.AUTO_MERGING (coordinate/ tells it apart from a review rework).
  CI_FIX_PUSHED: "ci_fix_pushed",
  UNLABELLED_AUTO_REWORKING: "unlabelled_auto_reworking",
  // A PR asked for review rework once more than the cap allows (Phase 9):
  // raised by the Worker from its own count of rounds, not by GitHub.
  REWORK_CAP_REACHED: "rework_cap_reached",
  LABELLED_AUTO_MERGING: "labelled_auto_merging",
  MERGE_GATE_FAILED_SOFT: "merge_gate_failed_soft",
  MERGE_GATE_FAILED_HARD: "merge_gate_failed_hard",
  UNLABELLED_AUTO_MERGING: "unlabelled_auto_merging",
  MERGED: "merged",
  // The review (15-agent-splits.md). LABELS.AI_REVIEWING added (by the build or a
  // person) or removed; then the Worker's own reading of the PR's CI:
  // green fires review-loop, red hands the PR to rework-loop first.
  LABELLED_AI_REVIEWING: "labelled_ai_reviewing",
  UNLABELLED_AI_REVIEWING: "unlabelled_ai_reviewing",
  REVIEW_CI_PASSED: "review_ci_passed",
  REVIEW_CI_FAILED: "review_ci_failed",
  // A push by a rework started from LABELS.AI_REVIEWING (a CI fix or the review's
  // findings): back to LABELS.AI_REVIEWING, to wait for CI and be reviewed again.
  REVIEW_FIX_PUSHED: "review_fix_pushed",
  // review-loop's outcomes (agent-outcomes artifacts).
  REVIEW_PASSED: "review_passed",
  REVIEW_FINDINGS: "review_findings",
  REVIEW_BLOCKED: "review_blocked",
  // the watchdog — the one event NOT sourced from GitHub. The DO raises it
  // itself when a routine it fired hasn't produced an outcome within the
  // watchdog window (worker/src/coordinate/watchdog.ts's coordinateWatchdogExpired).
  // Still a directly-observed fact, not a guess: "no outcome seen for
  // attempt X by time T" is exactly what the DO knows first-hand.
  WATCHDOG_EXPIRED: "watchdog_expired",
} as const;

export type Event = (typeof EVENTS)[keyof typeof EVENTS];

export const ALL_EVENTS: readonly Event[] = Object.values(EVENTS);
