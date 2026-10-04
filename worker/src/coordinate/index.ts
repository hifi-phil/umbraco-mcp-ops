// coordinate/: the core dispatch logic, dependency-injected (Deps) and
// tested with plain vitest. One file per job:
//
//   types.ts           Deps, rows, results, the shadow/enforce switches
//   apply.ts           the shared reduce -> labels -> fire -> log tail
//   webhook.ts         a GitHub webhook (and manual_override, check_suite)
//   merge-gate.ts      auto-merging's hard block and CI-fix hand-off
//   review-gate.ts     ai-reviewing's CI gate, and the review's caps
//   routine-signal.ts  a routine's heartbeat or completion
//   watchdog.ts        the watchdog's expiry
//   reconcile.ts       the sweep's left-behind check
//
// The DO (issue-coordinator.ts) wires Deps to real storage, D1 and GitHub.

export * from "./types";
export { deriveState } from "./apply";
export { coordinateWebhook } from "./webhook";
export { MERGEABLE_RETRIES, MERGEABLE_RETRY_MS } from "./merge-gate";
export * from "./routine-signal";
export * from "./watchdog";
export * from "./reconcile";
