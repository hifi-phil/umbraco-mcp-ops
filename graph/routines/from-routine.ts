// Processes data arriving directly from a routine — not via a GitHub
// webhook, via a separate channel the routine calls straight away (see
// docs/agent-orchestration/11-outcome-artifact.md). Two shapes, matching
// the two kinds of thing a routine has to say:
//
// - "process" — a heartbeat: "I'm currently at step X." Never authoritative,
//   never produces anything reduce() would act on. Matches the heartbeat
//   design in 03-components.md §3.4/§3.6: losing one costs nothing but
//   detail, so it's allowed to be a direct callback where an outcome isn't.
//
// - "completion" — a fast-path echo of the same outcome fact the GitHub
//   comment carries (see ../outcomes.ts for the shared shape). This is
//   NOT the authoritative signal — §4 of the design is explicit that "the
//   routine does not call us back with its outcome," specifically because
//   a direct call can be lost if the session dies mid-call, and GitHub
//   webhook delivery can't. This exists purely so the watchdog can cancel
//   its alarm promptly and the dashboard can show "done" sooner, without
//   waiting on GitHub's webhook to arrive. The real state transition only
//   ever comes from github/from-github.ts reading the real artifact.
//
// No "to-routine" file exists alongside this one: nothing sends data back
// to a routine today — there's no way to nudge a running session (see
// 05-technical-elements.md's "no way to nudge a running session"
// constraint) — so there's nothing to write there yet.
//
// The mechanism for a routine to make this call is resolved: a PostToolUse
// hook (plugins/agent-outcomes/hooks/report-completion.sh), not the model
// calling out mid-turn — see 08-open-questions.md. Verified locally;
// unconfirmed against a real cloud routine. This file is still the same
// "no infrastructure yet, pure logic" prototype as everything else in
// graph/: nothing here talks to a real DO, and the hook has nothing real
// to POST to yet.

import { parseOutcomeShape, type Outcome } from "../outcomes";
import type { Routine } from "../constants/routines";

export type RoutineSignal =
  | { kind: "process"; routine: Routine; issue: number; step: string }
  | { kind: "completion"; routine: Routine; issue: number; outcome: unknown };

export type RoutineUpdate =
  | { kind: "process"; routine: Routine; issue: number; step: string }
  | { kind: "completion"; routine: Routine; issue: number; outcome: Outcome };

export function parseRoutineSignal(signal: RoutineSignal): RoutineUpdate | null {
  if (signal.kind === "process") {
    if (!signal.step) return null;
    return { kind: "process", routine: signal.routine, issue: signal.issue, step: signal.step };
  }

  const outcome = parseOutcomeShape(signal.outcome);
  if (!outcome) return null;
  return { kind: "completion", routine: signal.routine, issue: signal.issue, outcome };
}
