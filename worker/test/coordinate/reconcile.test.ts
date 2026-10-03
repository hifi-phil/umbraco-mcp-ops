import { describe, expect, it, vi } from "vitest";
import { LABELS } from "@orchestrator/graph/constants/labels";
import { EVENTS } from "@orchestrator/graph/constants/events";
import { ROUTINES } from "@orchestrator/graph/constants/routines";
import { coordinateReconcile, coordinateRoutineSignal } from "../../src/coordinate";
import { fakeDeps, gateFacts } from "./helpers";

describe("coordinateReconcile — the sweep's question: was this issue left behind?", () => {
  const ref = { owner: "hifi-phil", repo: "umbraco-mcp-ops", issueNumber: 412 };
  const now = Date.parse("2026-10-02T12:00:00Z");
  const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString().replace("T", " ").slice(0, 19);

  it("its last run reported completion and nothing happened since (its label change lost) -> completed, not re-fired", async () => {
    const deps = fakeDeps({
      completedAt: vi.fn(async () => new Date(now - 100 * 60_000).toISOString()),
      lastActivityAt: async () => minutesAgo(120), // its last row, before the completion
      getLabels: vi.fn(async () => [LABELS.AI_READY]),
    });
    expect(await coordinateReconcile(deps, ref, { enforced: true, now })).toEqual({ outcome: "completed" });
    expect(deps.fireRoutine).not.toHaveBeenCalled();
  });

  it("a stale completion (something happened after it: a later label whose webhook or fire was lost) -> swept as usual", async () => {
    const deps = fakeDeps({
      completedAt: vi.fn(async () => new Date(now - 300 * 60_000).toISOString()), // an earlier run, long done
      getLabels: vi.fn(async () => [LABELS.AI_READY]),
    });
    const updatedAt = new Date(now - 130 * 60_000).toISOString(); // the later label add
    expect(await coordinateReconcile(deps, ref, { enforced: true, now, updatedAt })).toMatchObject({ outcome: "refired" });
  });

  it("a completion signal is what marks it", async () => {
    const deps = fakeDeps({ getPendingFire: vi.fn(async () => ({ ...ref, run: ROUTINES.ISSUE_BUILD_LOOP })) });
    await coordinateRoutineSignal(deps, {
      owner: "hifi-phil",
      repo: "umbraco-mcp-ops",
      signal: { kind: "completion", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412, outcome: { outcome: "build_blocked", reason: "x" } },
    });
    expect(deps.markCompleted).toHaveBeenCalledOnce();
  });

  it("GitHub updated it a moment ago (a label whose webhook hasn't landed) -> recent, even with no log rows", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]) });
    const updatedAt = new Date(now - 30_000).toISOString();
    expect(await coordinateReconcile(deps, ref, { enforced: true, now, updatedAt })).toMatchObject({ outcome: "recent" });
    expect(deps.fireRoutine).not.toHaveBeenCalled();
  });

  it("a lost auto-merge fire is gated like a fresh label: a conflict -> merge-blocked, merge-flow not fired", async () => {
    const deps = fakeDeps({
      getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]),
      lastActivityAt: async () => minutesAgo(90),
      getMergeGateFacts: vi.fn(async () => gateFacts({ mergeable: false })),
    });
    const result = await coordinateReconcile(deps, ref, { enforced: true, now });
    expect(result).toMatchObject({ outcome: "gated", result: { outcome: "applied", event: EVENTS.MERGE_GATE_FAILED_HARD } });
    expect(deps.addLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.MERGE_BLOCKED);
    expect(deps.fireRoutine).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 412, ROUTINES.MERGE_FLOW);
  });

  it("a watchdog is running -> watched, nothing done", async () => {
    const deps = fakeDeps({
      getPendingFire: vi.fn(async () => ({ ...ref, run: ROUTINES.ISSUE_BUILD_LOOP })),
      watchdogArmed: vi.fn(async () => true),
    });
    expect(await coordinateReconcile(deps, ref, { enforced: true, now })).toEqual({ outcome: "watched" });
    expect(deps.getLabels).not.toHaveBeenCalled();
  });

  it("not in a trigger state (ai-blocked, ai-stuck, merge-blocked) -> not_triggered", async () => {
    for (const label of [LABELS.AI_BLOCKED, LABELS.AI_STUCK, LABELS.MERGE_BLOCKED]) {
      const deps = fakeDeps({ getLabels: vi.fn(async () => [label]) });
      expect(await coordinateReconcile(deps, ref, { enforced: true, now })).toMatchObject({ outcome: "not_triggered" });
      expect(deps.fireRoutine).not.toHaveBeenCalled();
    }
  });

  it("a trigger state, but active within twice its timeout -> recent, nothing done", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]), lastActivityAt: async () => minutesAgo(90) });
    expect(await coordinateReconcile(deps, ref, { enforced: true, now })).toEqual({ outcome: "recent", idleMinutes: 90 });
    expect(deps.fireRoutine).not.toHaveBeenCalled();
  });

  it("a lost watchdog (pending fire, but its alarm gave up) -> swept like any other: re-fired once idle", async () => {
    const deps = fakeDeps({
      getPendingFire: vi.fn(async () => ({ ...ref, run: ROUTINES.ISSUE_BUILD_LOOP })),
      watchdogArmed: vi.fn(async () => false),
      getLabels: vi.fn(async () => [LABELS.AI_READY]),
      lastActivityAt: async () => minutesAgo(125),
    });
    expect(await coordinateReconcile(deps, ref, { enforced: true, now })).toMatchObject({ outcome: "refired" });
    expect(deps.setPendingFire).toHaveBeenCalledWith({ ...ref, run: ROUTINES.ISSUE_BUILD_LOOP }); // re-arms the watchdog
  });

  it("no alarm, but only just due (its watchdog may be expiring right now) -> watched, not re-fired", async () => {
    const deps = fakeDeps({
      getPendingFire: vi.fn(async () => ({ ...ref, run: ROUTINES.ISSUE_BUILD_LOOP, dueAt: now - 2 * 60_000 })),
      watchdogArmed: vi.fn(async () => false),
      getLabels: vi.fn(async () => [LABELS.AI_READY]),
      lastActivityAt: async () => minutesAgo(125),
    });
    expect(await coordinateReconcile(deps, ref, { enforced: true, now })).toEqual({ outcome: "watched" });
    expect(deps.fireRoutine).not.toHaveBeenCalled();
  });

  it("no alarm, and long past due (its retries spent) -> lost, re-fired", async () => {
    const deps = fakeDeps({
      getPendingFire: vi.fn(async () => ({ ...ref, run: ROUTINES.ISSUE_BUILD_LOOP, dueAt: now - 30 * 60_000 })),
      watchdogArmed: vi.fn(async () => false),
      getLabels: vi.fn(async () => [LABELS.AI_READY]),
      lastActivityAt: async () => minutesAgo(125),
    });
    expect(await coordinateReconcile(deps, ref, { enforced: true, now })).toMatchObject({ outcome: "refired" });
  });

  it("left behind (trigger state, no watchdog, idle past twice its timeout) -> re-fired, watched, logged", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]), lastActivityAt: async () => minutesAgo(125) });
    expect(await coordinateReconcile(deps, ref, { enforced: true, now })).toEqual({
      outcome: "refired",
      run: ROUTINES.ISSUE_BUILD_LOOP,
      idleMinutes: 125,
    });
    expect(deps.fireRoutine).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, ROUTINES.ISSUE_BUILD_LOOP);
    expect(deps.setPendingFire).toHaveBeenCalledWith({ ...ref, run: ROUTINES.ISSUE_BUILD_LOOP });
    expect(deps.logTransition).toHaveBeenCalledWith(
      expect.objectContaining({ event: "reconcile_refire", fromState: LABELS.AI_READY, run: ROUTINES.ISSUE_BUILD_LOOP, mode: "enforce", deliveryId: null }),
    );
  });

  it("a lost retry of a merge-blocked PR (both labels on), gate passing -> the retry's rule: fresh CI count, merge-blocked off, merge-flow fired", async () => {
    const deps = fakeDeps({
      getLabels: vi.fn(async () => [LABELS.MERGE_BLOCKED, LABELS.AUTO_MERGING]),
      lastActivityAt: async () => minutesAgo(90),
    });
    const result = await coordinateReconcile(deps, ref, { enforced: true, now });
    expect(result).toMatchObject({ outcome: "gated", result: { outcome: "applied", event: EVENTS.LABELLED_AUTO_MERGING } });
    expect(deps.setCiFix).toHaveBeenCalledWith(null);
    expect(deps.removeLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.MERGE_BLOCKED);
    expect(deps.fireRoutine).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, ROUTINES.MERGE_FLOW);
    expect(deps.logTransition).toHaveBeenCalledWith(expect.objectContaining({ event: "reconcile_refire", mode: "enforce" }));
  });

  it("a lost retry of a merge-blocked PR with CI red -> rework, and merge-blocked comes off (not merge-blocked + auto-rework)", async () => {
    const deps = fakeDeps({
      getLabels: vi.fn(async () => [LABELS.MERGE_BLOCKED, LABELS.AUTO_MERGING]),
      lastActivityAt: async () => minutesAgo(90),
      getMergeGateFacts: vi.fn(async () => gateFacts({ checkRuns: [{ status: "completed", conclusion: "failure" }] })),
    });
    const result = await coordinateReconcile(deps, ref, { enforced: true, now });
    expect(result).toMatchObject({ outcome: "gated", result: { outcome: "applied", event: EVENTS.MERGE_GATE_FAILED_SOFT } });
    expect(deps.addLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AUTO_REWORKING);
    expect(deps.removeLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.MERGE_BLOCKED);
  });

  it("each trigger re-fires its own loop (auto-merge -> merge-flow)", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]), lastActivityAt: async () => minutesAgo(61) });
    expect(await coordinateReconcile(deps, ref, { enforced: true, now })).toMatchObject({ outcome: "refired", run: ROUTINES.MERGE_FLOW });
  });

  it("never logged (labelled before the Worker existed) -> left behind too", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AUTO_RELEASING]) });
    expect(await coordinateReconcile(deps, ref, { enforced: true, now })).toMatchObject({ outcome: "refired", idleMinutes: null });
  });

  it("shadow sweep -> logs what it would re-fire, fires nothing", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]), lastActivityAt: async () => minutesAgo(200) });
    expect(await coordinateReconcile(deps, ref, { enforced: false, now })).toMatchObject({ outcome: "would_refire" });
    expect(deps.fireRoutine).not.toHaveBeenCalled();
    expect(deps.setPendingFire).not.toHaveBeenCalled();
    expect(deps.logTransition).toHaveBeenCalledWith(expect.objectContaining({ event: "reconcile_refire", mode: "shadow" }));
  });

  it("a sweep asked to enforce, but this repo's watchdog is shadow -> held: logged, not fired (a second death wouldn't stop it)", async () => {
    const deps = fakeDeps({
      enforced: (e) => e !== EVENTS.WATCHDOG_EXPIRED,
      getLabels: vi.fn(async () => [LABELS.AI_READY]),
      lastActivityAt: async () => minutesAgo(200),
    });
    expect(await coordinateReconcile(deps, ref, { enforced: true, now })).toMatchObject({ outcome: "would_refire", held: "watchdog_shadow" });
    expect(deps.fireRoutine).not.toHaveBeenCalled();
    expect(deps.setPendingFire).not.toHaveBeenCalled();
    expect(deps.logTransition).toHaveBeenCalledWith(expect.objectContaining({ event: "reconcile_refire", mode: "shadow" }));
  });

  it("…and with MODE shadow (nothing fires for real) -> held too", async () => {
    const deps = fakeDeps({
      enforced: () => false,
      getLabels: vi.fn(async () => [LABELS.AI_READY]),
      lastActivityAt: async () => minutesAgo(200),
    });
    expect(await coordinateReconcile(deps, ref, { enforced: true, now })).toMatchObject({ outcome: "would_refire", held: "mode_shadow" });
    expect(deps.fireRoutine).not.toHaveBeenCalled();
  });

  it("shadow: the same idle stretch is logged once, not every sweep; new activity logs again", async () => {
    let last = minutesAgo(200);
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]), lastActivityAt: async () => last });
    await coordinateReconcile(deps, ref, { enforced: false, now });
    expect(await coordinateReconcile(deps, ref, { enforced: false, now: now + 15 * 60_000 })).toMatchObject({ alreadyLogged: true });
    expect(deps.logTransition).toHaveBeenCalledTimes(1);
    last = minutesAgo(130); // something happened, then it went quiet again
    await coordinateReconcile(deps, ref, { enforced: false, now });
    expect(deps.logTransition).toHaveBeenCalledTimes(2);
  });
});
