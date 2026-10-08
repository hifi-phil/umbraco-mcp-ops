import { describe, expect, it, vi } from "vitest";
import { LABELS } from "@orchestrator/graph/constants/labels";
import { EVENTS } from "@orchestrator/graph/constants/events";
import { ROUTINES } from "@orchestrator/graph/constants/routines";
import { coordinateWatchdogExpired, type PendingFire } from "../../src/coordinate";
import { fakeDeps } from "./helpers";

describe("coordinateWatchdogExpired — the watchdog as a real event", () => {
  // Already fired once more: the expiry that moves to LABELS.AI_STUCK (a first,
  // silent one is retried; see "the one retry" below).
  const pending: PendingFire = {
    owner: "hifi-phil",
    repo: "umbraco-mcp-ops",
    issueNumber: 412,
    run: ROUTINES.ISSUE_BUILD_LOOP,
    retried: true,
  };

  it("a pending fire not yet due (a newer fire or heartbeat replaced it after this alarm started) -> not_due, nothing touched", async () => {
    const now = Date.parse("2026-10-02T10:00:00Z");
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]) });
    await deps.setPendingFire({ ...pending, dueAt: now + 60 * 60_000 });
    expect(await coordinateWatchdogExpired(deps, now)).toEqual({ outcome: "not_due", dueAt: now + 60 * 60_000 });
    expect(deps.commentOnIssue).not.toHaveBeenCalled();
    expect(deps.clearPendingFire).not.toHaveBeenCalled();
  });

  it("a 1-minute watchdog still tells a just-replaced fire (due in a minute) from a due one", async () => {
    const now = Date.parse("2026-10-02T10:00:00Z");
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]), watchdogMinutes: () => 1 });
    await deps.setPendingFire({ ...pending, dueAt: now + 60_000 });
    expect(await coordinateWatchdogExpired(deps, now)).toMatchObject({ outcome: "not_due" });
    expect(await coordinateWatchdogExpired(deps, now + 59_000)).toMatchObject({ outcome: "applied" });
  });

  it("a pending fire due now (or within a minute: an early alarm) -> expires as usual", async () => {
    const now = Date.parse("2026-10-02T10:00:00Z");
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]) });
    await deps.setPendingFire({ ...pending, dueAt: now + 30_000 });
    expect(await coordinateWatchdogExpired(deps, now)).toMatchObject({ outcome: "applied", event: EVENTS.WATCHDOG_EXPIRED });
  });

  it("nothing pending -> no_pending_fire, no GitHub calls (a harmless race, or a retry after a full success)", async () => {
    const deps = fakeDeps();
    expect(await coordinateWatchdogExpired(deps)).toEqual({ outcome: "no_pending_fire" });
    expect(deps.getLabels).not.toHaveBeenCalled();
    expect(deps.commentOnIssue).not.toHaveBeenCalled();
  });

  it(`in-flight ${LABELS.AI_READY} -> comments, swaps ${LABELS.AI_READY} -> ${LABELS.AI_STUCK}, logs a watchdog_expired row, then clears pendingFire`, async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]) });
    await deps.setPendingFire(pending);

    const result = await coordinateWatchdogExpired(deps);

    expect(result).toMatchObject({ outcome: "applied", from: LABELS.AI_READY, event: EVENTS.WATCHDOG_EXPIRED });
    expect(deps.commentOnIssue).toHaveBeenCalledWith(
      "hifi-phil",
      "umbraco-mcp-ops",
      412,
      expect.stringMatching(new RegExp(`issue-build-loop.*60 minutes.*No progress step.*Moving this to \`${LABELS.AI_STUCK}\``)),
    );
    expect(deps.removeLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AI_READY);
    expect(deps.addLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AI_STUCK);
    expect(deps.logTransition).toHaveBeenCalledWith(
      expect.objectContaining({ fromState: LABELS.AI_READY, event: EVENTS.WATCHDOG_EXPIRED, droppedReason: null }),
    );
    expect(await deps.getPendingFire()).toBeNull();
  });

  it("quotes the last heartbeat step in the comment", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]) });
    await deps.setPendingFire({ ...pending, lastStep: "running tests", lastStepAt: "2026-09-28T10:00:00.000Z" });
    await coordinateWatchdogExpired(deps);
    expect(deps.commentOnIssue).toHaveBeenCalledWith(
      "hifi-phil",
      "umbraco-mcp-ops",
      412,
      expect.stringContaining("Last reported step: `running tests` (2026-09-28T10:00:00.000Z)"),
    );
  });

  it(`a build that already swapped to ${LABELS.PR_OPEN} is finished, never moved to ${LABELS.AI_STUCK} (shadow run 1, #116)`, async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.PR_OPEN]) });
    await deps.setPendingFire(pending);
    const result = await coordinateWatchdogExpired(deps);
    expect(result).toMatchObject({ outcome: "dropped_no_rule", from: LABELS.PR_OPEN });
    expect(deps.addLabel).not.toHaveBeenCalled();
  });

  it("no rule from the current state (e.g. a human already cleared the labels) -> still alerts, logged as dropped, pendingFire cleared", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => []) });
    await deps.setPendingFire(pending);
    const result = await coordinateWatchdogExpired(deps);
    expect(result).toEqual({ outcome: "dropped_no_rule", from: "none", event: EVENTS.WATCHDOG_EXPIRED });
    expect(deps.commentOnIssue).toHaveBeenCalledWith(
      "hifi-phil",
      "umbraco-mcp-ops",
      412,
      expect.stringContaining("needs a human look"),
    );
    expect(deps.addLabel).not.toHaveBeenCalled();
    expect(await deps.getPendingFire()).toBeNull();
  });

  it("the comment call failing leaves pendingFire in place, so the DO's alarm retry still has something to act on", async () => {
    const deps = fakeDeps({
      getLabels: vi.fn(async () => [LABELS.AI_READY]),
      commentOnIssue: vi.fn(async () => {
        throw new Error("GitHub 502");
      }),
    });
    await deps.setPendingFire(pending);
    await expect(coordinateWatchdogExpired(deps)).rejects.toThrow("GitHub 502");
    expect(await deps.getPendingFire()).toEqual(pending);
  });
});

describe("coordinateWatchdogExpired — the one retry of a run that never started", () => {
  const silent: PendingFire = { owner: "hifi-phil", repo: "umbraco-mcp-ops", issueNumber: 412, run: ROUTINES.ISSUE_BUILD_LOOP };

  it("off unless the repo turns it on (no heartbeats, no way to tell 'never started' from 'went quiet'): straight to stuck", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]) });
    await deps.setPendingFire(silent);
    expect(await coordinateWatchdogExpired(deps)).toMatchObject({ outcome: "applied", event: EVENTS.WATCHDOG_EXPIRED });
    expect(deps.fireRoutine).not.toHaveBeenCalled();
  });

  it("a first expiry with no step ever reported -> fired once more, watched again and marked retried; labels untouched", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]), watchdogRetry: true });
    await deps.setPendingFire(silent);
    expect(await coordinateWatchdogExpired(deps)).toEqual({ outcome: "retried", run: ROUTINES.ISSUE_BUILD_LOOP });
    expect(deps.fireRoutine).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, ROUTINES.ISSUE_BUILD_LOOP);
    expect(await deps.getPendingFire()).toMatchObject({ run: ROUTINES.ISSUE_BUILD_LOOP, retried: true });
    expect(deps.commentOnIssue).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, expect.stringContaining("Firing it once more"));
    expect(deps.logTransition).toHaveBeenCalledWith(expect.objectContaining({ event: "watchdog_retried", actor: "watchdog", run: ROUTINES.ISSUE_BUILD_LOOP }));
    expect(deps.addLabel).not.toHaveBeenCalled();
    expect(deps.removeLabel).not.toHaveBeenCalled();
  });

  it(`then a second silent expiry -> ${LABELS.AI_STUCK}, as before`, async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]), watchdogRetry: true });
    await deps.setPendingFire(silent);
    await coordinateWatchdogExpired(deps);
    expect(await coordinateWatchdogExpired(deps)).toMatchObject({ outcome: "applied", event: EVENTS.WATCHDOG_EXPIRED });
    expect(deps.fireRoutine).toHaveBeenCalledTimes(1);
    expect(deps.addLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AI_STUCK);
  });

  it(`a run that reported progress is never retried (it may have pushed half its work): ${LABELS.AI_STUCK}, for a person`, async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]), watchdogRetry: true });
    await deps.setPendingFire({ ...silent, lastStep: "Bash: run the tests", lastStepAt: "2026-10-08T10:00:00Z" });
    expect(await coordinateWatchdogExpired(deps)).toMatchObject({ outcome: "applied", event: EVENTS.WATCHDOG_EXPIRED });
    expect(deps.fireRoutine).not.toHaveBeenCalled();
  });

  it("a heartbeat after the retry keeps it marked retried", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]), watchdogRetry: true });
    await deps.setPendingFire(silent);
    await coordinateWatchdogExpired(deps);
    const p = (await deps.getPendingFire())!;
    await deps.setPendingFire({ ...p, lastStep: "a step" });
    expect(await deps.getPendingFire()).toMatchObject({ retried: true });
  });

  it("shadow watchdog, or labels with no expiry rule (a person moved it on): no retry", async () => {
    const shadow = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]), enforced: () => false, watchdogRetry: true });
    await shadow.setPendingFire(silent);
    await coordinateWatchdogExpired(shadow);
    expect(shadow.fireRoutine).not.toHaveBeenCalled();
    const moved = fakeDeps({ getLabels: vi.fn(async () => [LABELS.PR_OPEN]), watchdogRetry: true });
    await moved.setPendingFire(silent);
    expect(await coordinateWatchdogExpired(moved)).not.toMatchObject({ outcome: "retried" });
    expect(moved.fireRoutine).not.toHaveBeenCalled();
  });

  it(`the re-fire itself refused -> the expiry carries on to ${LABELS.AI_STUCK}`, async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]), fireRoutine: vi.fn(async () => Promise.reject(new Error("503"))), watchdogRetry: true });
    await deps.setPendingFire(silent);
    expect(await coordinateWatchdogExpired(deps)).toMatchObject({ outcome: "applied", event: EVENTS.WATCHDOG_EXPIRED });
    expect(deps.addLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AI_STUCK);
  });
});
