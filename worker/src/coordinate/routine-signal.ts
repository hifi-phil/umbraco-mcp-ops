// A routine's direct signal (heartbeat or completion): extends or ends the
// watchdog. Never a label write: that's the webhook path's.

import { parseRoutineSignal,type RoutineSignal } from "../../../graph/routines/from-routine";
import {
type Deps
} from "./types";

export type RoutineSignalInput = { owner: string; repo: string; signal: RoutineSignal };

export type RoutineSignalResult =
  | { outcome: "invalid_signal" }
  | { outcome: "no_pending_fire" } // nothing running for this issue right now — a stray/late signal, harmless
  | { outcome: "mismatched_routine"; expected: string; got: string } // a different routine currently owns this issue
  | { outcome: "heartbeat_extended" }
  | { outcome: "completion_acknowledged" };

/**
 * The direct routine-to-DO channel — see graph/routines/from-routine.ts's
 * header for why this exists and what it deliberately doesn't do. Neither
 * kind ever calls reduce() or writes a label/close — this is purely a
 * watchdog-timing optimization (extend the alarm on "process", cancel it
 * early on "completion") layered on top of the one authoritative path,
 * coordinateWebhook(). Losing a call here costs a slightly-later alarm
 * or a duplicate cancel a moment later when the real GitHub webhook
 * arrives — never a wrong state.
 */
export async function coordinateRoutineSignal(
  deps: Deps,
  input: RoutineSignalInput,
): Promise<RoutineSignalResult> {
  const update = parseRoutineSignal(input.signal);
  if (!update) return { outcome: "invalid_signal" };

  const pending = await deps.getPendingFire();
  if (!pending) return { outcome: "no_pending_fire" };
  if (pending.run !== update.routine) {
    return { outcome: "mismatched_routine", expected: pending.run, got: update.routine };
  }

  if (update.kind === "process") {
    // Records the step (so an expiry can quote it) and, because the DO's
    // setPendingFire always re-schedules the alarm, extends the watchdog.
    const at = new Date().toISOString();
    await deps.setPendingFire({ ...pending, lastStep: update.step, lastStepAt: at });
    await deps.recordStatus(pending, { kind: "step", step: update.step, at });
    return { outcome: "heartbeat_extended" };
  }

  await deps.clearPendingFire();
  await deps.markCompleted(new Date().toISOString());
  await deps.recordStatus(pending, { kind: "done" });
  return { outcome: "completion_acknowledged" };
}
