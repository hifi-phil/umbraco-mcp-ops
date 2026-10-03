import { describe, expect, it, vi } from "vitest";
import { LABELS } from "@orchestrator/graph/constants/labels";
import { EVENTS } from "@orchestrator/graph/constants/events";
import { ROUTINES } from "@orchestrator/graph/constants/routines";
import { coordinateWatchdogExpired, type PendingFire } from "../../src/coordinate";
import { fakeDeps } from "./helpers";

describe("coordinateWatchdogExpired — the watchdog as a real event", () => {
  const pending: PendingFire = {
    owner: "hifi-phil",
    repo: "umbraco-mcp-ops",
    issueNumber: 412,
    run: ROUTINES.ISSUE_BUILD_LOOP,
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

  it("in-flight ready-for-ai -> comments, swaps ready-for-ai -> ai-stuck, logs a watchdog_expired row, then clears pendingFire", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]) });
    await deps.setPendingFire(pending);

    const result = await coordinateWatchdogExpired(deps);

    expect(result).toMatchObject({ outcome: "applied", from: LABELS.AI_READY, event: EVENTS.WATCHDOG_EXPIRED });
    expect(deps.commentOnIssue).toHaveBeenCalledWith(
      "hifi-phil",
      "umbraco-mcp-ops",
      412,
      expect.stringMatching(/issue-build-loop.*60 minutes.*No progress step.*Moving this to `ai-stuck`/),
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

  it("a build that already swapped to generated-by-ai is finished, never moved to ai-stuck (shadow run 1, #116)", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_GENERATED]) });
    await deps.setPendingFire(pending);
    const result = await coordinateWatchdogExpired(deps);
    expect(result).toMatchObject({ outcome: "dropped_no_rule", from: LABELS.AI_GENERATED });
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
