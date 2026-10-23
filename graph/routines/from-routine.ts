// Processes data arriving directly from a routine — not via a GitHub
// webhook, via a separate channel the routine calls straight away (see
// docs/agent-orchestration/11-outcome-artifact.md). Five shapes, matching
// the kinds of thing a routine has to say:
//
// - "process" — a heartbeat: "I'm currently at step X." Never authoritative,
//   never produces anything reduce() would act on. Matches the heartbeat
//   design in 03-components.md §3.4/§3.6: losing one costs nothing but
//   detail, so it's allowed to be a direct callback where an outcome isn't.
//
// - "completion" — timing only: the PostToolUse hook's echo of an outcome
//   artifact it saw go by (see ../outcomes.ts for the shared shape). It is
//   sniffed from tool-call text, so it is NOT authoritative and never
//   applied: it only lets the watchdog cancel its alarm promptly and the
//   dashboard show "done" sooner. The state change comes from the outcome's
//   comment (github/from-github.ts) or from an explicit "outcome".
//
// - "outcome" — authoritative: the run's outcome, reported deliberately
//   (post-outcome.sh, when a skill reports), never inferred. The Worker
//   applies it like the outcome's comment, through the same translate() ->
//   reduce() path, and whichever of the two arrives second is a logged
//   no-op ("deduped"). Either alone is enough.
//
// - "blocked" — the run is waiting on a permission it can't get unattended:
//   said once on the item, recorded as its step, no label change.
//
// - "ended" — the session ended without reporting an outcome: an expiry at
//   once, as the watchdog's alarm would apply it, instead of waiting it out.
//
// No "to-routine" file exists alongside this one: nothing sends data back
// to a routine today — there's no way to nudge a running session (see
// 05-technical-elements.md's "no way to nudge a running session"
// constraint) — so there's nothing to write there yet.
//
// The heartbeat and completion come from a PostToolUse hook
// (plugins/agent-outcomes/hooks/report-completion.sh), not the model
// calling out mid-turn — see 08-open-questions.md. This file is pure logic
// like everything in graph/: the Worker's coordinate/routine-signal.ts acts
// on what it returns.

import { parseOutcomeShape, type Outcome } from "../outcomes";
import type { Routine } from "../constants/routines";

export type RoutineSignal =
  | { kind: "process"; routine: Routine; issue: number; step: string }
  | { kind: "completion"; routine: Routine; issue: number; outcome: unknown }
  | { kind: "outcome"; routine: Routine; issue: number; outcome: unknown }
  | { kind: "blocked"; routine: Routine; issue: number; detail: string }
  | { kind: "ended"; routine: Routine; issue: number; detail: string };

export type RoutineUpdate =
  | { kind: "process"; routine: Routine; issue: number; step: string }
  | { kind: "completion"; routine: Routine; issue: number; outcome: Outcome }
  | { kind: "outcome"; routine: Routine; issue: number; outcome: Outcome }
  | { kind: "blocked"; routine: Routine; issue: number; detail: string }
  | { kind: "ended"; routine: Routine; issue: number; detail: string };

export function parseRoutineSignal(signal: RoutineSignal): RoutineUpdate | null {
  switch (signal.kind) {
    case "process":
      if (!signal.step) return null;
      return { kind: "process", routine: signal.routine, issue: signal.issue, step: signal.step };
    case "completion":
    case "outcome": {
      const outcome = parseOutcomeShape(signal.outcome);
      if (!outcome) return null;
      return { kind: signal.kind, routine: signal.routine, issue: signal.issue, outcome };
    }
    case "blocked":
    case "ended":
      if (typeof signal.detail !== "string" || !signal.detail) return null;
      return { kind: signal.kind, routine: signal.routine, issue: signal.issue, detail: signal.detail };
    default:
      return null;
  }
}
