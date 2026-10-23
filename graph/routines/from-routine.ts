// Processes data arriving directly from a routine — not via a GitHub
// webhook, via a separate channel the routine calls straight away (see
// docs/agent-orchestration/11-outcome-artifact.md). Four shapes, matching
// the kinds of thing a routine has to say:
//
// - "process" — a heartbeat: "I'm currently at step X." Never authoritative,
//   never produces anything reduce() would act on. Matches the heartbeat
//   design in 03-components.md §3.4/§3.6: losing one costs nothing but
//   detail, so it's allowed to be a direct callback where an outcome isn't.
//
// - "completion" — the run's outcome (see ../outcomes.ts for the shared
//   shape), the same fact its GitHub comment carries. Authoritative
//   alongside the comment: the Worker applies whichever of the two arrives
//   first, through the same translate() -> reduce() path, and the second is
//   a logged no-op ("deduped"). Either alone is enough: a direct call can be
//   lost if the session dies mid-call, and the comment's webhook can be
//   lost too (the watchdog's recovery reads the comments for that).
//
// - "blocked" — the session is waiting on a permission prompt it can't get
//   answered unattended; `detail` names it. Said once on the item; no label
//   moves, and the watchdog still decides.
//
// - "ended" — the session stopped without a completion; `detail` says how.
//   The Worker does at once what a watchdog expiry would.
//
// No "to-routine" file exists alongside this one: nothing sends data back
// to a routine today — there's no way to nudge a running session (see
// 05-technical-elements.md's "no way to nudge a running session"
// constraint) — so there's nothing to write there yet.
//
// The mechanism for a routine to make these calls is a hook
// (plugins/agent-outcomes/hooks/report-completion.sh for heartbeats and
// completions), not the model calling out mid-turn — see
// 08-open-questions.md. Nothing sends "blocked" or "ended" yet (#391,
// part 2). This file is pure logic, like everything in graph/: the Worker
// (worker/src/coordinate/routine-signal.ts) does the I/O.

import { parseOutcomeShape, type Outcome } from "../outcomes";
import type { Routine } from "../constants/routines";

export type RoutineSignal =
  | { kind: "process"; routine: Routine; issue: number; step: string }
  | { kind: "completion"; routine: Routine; issue: number; outcome: unknown }
  | { kind: "blocked"; routine: Routine; issue: number; detail: string }
  | { kind: "ended"; routine: Routine; issue: number; detail: string };

export type RoutineUpdate =
  | { kind: "process"; routine: Routine; issue: number; step: string }
  | { kind: "completion"; routine: Routine; issue: number; outcome: Outcome }
  | { kind: "blocked"; routine: Routine; issue: number; detail: string }
  | { kind: "ended"; routine: Routine; issue: number; detail: string };

export function parseRoutineSignal(signal: RoutineSignal): RoutineUpdate | null {
  if (signal.kind === "process") {
    if (!signal.step) return null;
    return { kind: "process", routine: signal.routine, issue: signal.issue, step: signal.step };
  }

  if (signal.kind === "blocked" || signal.kind === "ended") {
    if (typeof signal.detail !== "string" || !signal.detail.trim()) return null;
    return { kind: signal.kind, routine: signal.routine, issue: signal.issue, detail: signal.detail };
  }

  if (signal.kind !== "completion") return null; // an unknown kind (the body is JSON from outside)
  const outcome = parseOutcomeShape(signal.outcome);
  if (!outcome) return null;
  return { kind: "completion", routine: signal.routine, issue: signal.issue, outcome };
}
