// The shared tail every handler ends in: an Event against the live labels ->
// reduce() -> labelOps() -> fire and watch -> log -> live-status row. And
// deriveState, reading the tracked state from the labels.

import { ALL_LABELS, LABELS, type Label } from "@orchestrator/graph/constants/labels";
import { CONTEXTUAL_EVENTS, isWatched, reduce, type Rule, type State } from "@orchestrator/graph/graph";
import { labelOps } from "@orchestrator/graph/github/to-github";
import { type Event } from "@orchestrator/graph/constants/events";
import {
  LABEL_JUST_ADDED_BY,
  actorOf,
  depsFor,
  type Acting,
  type CoordinateInput,
  type CoordinateResult,
  type Deps,
  type IssueRef,
  type StatusUpdate,
} from "./types";

/** The shared reduce() -> labelOps() -> fire/log tail, once an Event has
 * been decided (however it was decided) and the current labels are
 * already in hand. */
export async function applyEvent(
  allDeps: Deps,
  input: IssueRef & Acting,
  event: Event,
  currentLabels: string[],
): Promise<CoordinateResult> {
  const { io: deps, mode } = depsFor(allDeps, event);
  // Present when a webhook caused this; the watchdog passes its pending fire.
  const deliveryId = (input as Partial<CoordinateInput>).deliveryId || null;
  const actor = actorOf(input);
  const justAdded = LABEL_JUST_ADDED_BY[event];
  const labelsBeforeThisEvent = justAdded
    ? currentLabels.filter((l) => l !== justAdded)
    : currentLabels;
  const current = deriveState(labelsBeforeThisEvent);
  if (current === "ambiguous") {
    await deps.logTransition({
      deliveryId,
      actor,
      owner: input.owner,
      repo: input.repo,
      issueNumber: input.issueNumber,
      fromState: "ambiguous",
      event,
      toEffect: null,
      run: null,
      droppedReason: "ambiguous current state — multiple tracked labels present",
      mode,
    });
    return { outcome: "ambiguous_state" };
  }

  const rule = reduce(current, event);
  if (!rule && CONTEXTUAL_EVENTS.has(event)) return { outcome: "ignored", from: current, event };
  if (!rule) {
    await deps.logTransition({
      deliveryId,
      actor,
      owner: input.owner,
      repo: input.repo,
      issueNumber: input.issueNumber,
      fromState: current,
      event,
      toEffect: null,
      run: null,
      droppedReason: "no matching rule for this (state, event) pair",
      mode,
    });
    return { outcome: "dropped_no_rule", from: current, event };
  }

  for (const op of labelOps(currentLabels, rule)) {
    if (op.op === "add") await deps.addLabel(input.owner, input.repo, input.issueNumber, op.label);
    else if (op.op === "remove") {
      await deps.removeLabel(input.owner, input.repo, input.issueNumber, op.label);
    } else {
      await deps.closeIssue(input.owner, input.repo, input.issueNumber);
    }
  }

  if (rule.run) {
    // Only arm the watchdog where the table says what an expiry means —
    // see graph.ts's watchdog section (issue-discuss-loop never reports an
    // outcome, so watching it would only ever raise false alarms).
    const target = rule.to.kind === "label" ? rule.to.value : current;
    const watched = isWatched(target);
    // Armed before the fire (Phase 9): a crash between deciding to fire and
    // firing leaves the watchdog to notice, never a silent lost attempt.
    if (watched) {
      await deps.setPendingFire({
        owner: input.owner,
        repo: input.repo,
        issueNumber: input.issueNumber,
        run: rule.run,
      });
    } else {
      await deps.clearPendingFire();
    }
    try {
      await deps.fireRoutine(input.owner, input.repo, input.issueNumber, rule.run);
    } catch (e) {
      // The fire was refused, not lost: nothing's running, so disarm (the
      // sweep re-fires a trigger left with nothing watching it), and fail.
      if (watched) await deps.clearPendingFire();
      throw e;
    }
  } else {
    await deps.clearPendingFire();
  }

  await deps.logTransition({
    deliveryId,
    actor,
    owner: input.owner,
    repo: input.repo,
    issueNumber: input.issueNumber,
    fromState: current,
    event,
    toEffect: JSON.stringify(rule.to),
    run: rule.run ?? null,
    droppedReason: null,
    mode,
  });

  // Only what really happened: a shadow event's labels never moved.
  if (mode === "enforce") await allDeps.recordStatus(input, statusAfter(current, rule));

  return { outcome: "applied", from: current, event, rule };
}

/** The live-status change an applied rule makes. */
function statusAfter(current: State, rule: Rule): StatusUpdate {
  if (rule.to.kind === "close") return { kind: "gone" };
  const state = rule.to.kind === "label" ? rule.to.value : rule.to.kind === "unlabel" ? "none" : current;
  const running = !!rule.run && isWatched(rule.to.kind === "label" ? rule.to.value : current);
  // Untracked, and nothing out for it: nothing to show.
  if (state === "none" && !rule.run) return { kind: "gone" };
  return { kind: "transition", state, run: rule.run ?? null, running };
}


/**
 * The real label set (freshly read) -> our tracked State. "none" means no
 * tracked label is present. Deliberately doesn't guess when more than one
 * tracked label is present at once — that's a real anomaly (nothing in
 * this system's design expects it), not something to silently resolve by
 * picking one.
 */
export function deriveState(labels: readonly string[]): State | "ambiguous" {
  const trackedSet: readonly string[] = ALL_LABELS;
  const tracked = labels.filter((l) => trackedSet.includes(l)) as Label[];
  if (tracked.length === 0) return "none";
  if (tracked.length === 1) return tracked[0]!;
  // The one expected pairing: ai-stuck plus a label a late routine swapped
  // in itself after the watchdog had already fired (e.g. ai-stuck +
  // pr-open, just before its outcome comment arrives). A known race
  // with a defined answer — the issue is still ai-stuck, and graph.ts's
  // "leaving ai-stuck" rules decide what the late outcome does with it.
  if (tracked.length === 2 && tracked.includes(LABELS.AI_STUCK)) return LABELS.AI_STUCK;
  // A human re-added auto-merging to a merge-blocked PR that's still blocked:
  // read it as auto-merging, so the hard-block rule swaps it back to
  // merge-blocked (which is already there, so only auto-merging comes off).
  if (tracked.length === 2 && tracked.includes(LABELS.MERGE_BLOCKED) && tracked.includes(LABELS.AUTO_MERGING)) {
    return LABELS.AUTO_MERGING;
  }
  return "ambiguous";
}
