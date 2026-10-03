import { describe, expect, it, vi } from "vitest";
import { LABELS } from "../../../graph/constants/labels";
import { EVENTS } from "../../../graph/constants/events";
import { ROUTINES } from "../../../graph/constants/routines";
import {
  LABEL_JUST_ADDED_BY,
  coordinateWebhook,
  coordinateReconcile,
  coordinateRoutineSignal,
  coordinateWatchdogExpired,
  deriveState,
  MAX_CI_FIX_ATTEMPTS,
  resolveEnforced,
  resolveMode,
  shadowDeps,
  watchdogMinutesFor,
  type CiFix,
  type CoordinateInput,
  type Deps,
  type PendingFire,
} from "../../src/coordinate";
import type { RoutineSignal } from "../../../graph/routines/from-routine";
import type { MergeGateFacts } from "../../../graph/github/merge-gate";
import { fakeDeps, gateFacts, input } from "./helpers";

describe("coordinateWebhook — check_suite.completed, the real merge-gate aggregation", () => {
  const checkSuiteInput = (status: "completed" | "in_progress" = "completed") =>
    input({ payload: { action: "check_suite.completed", check_suite: { conclusion: null, status } } });

  it("check suite still in progress -> no_event, never even reads labels or fetches gate facts", async () => {
    const deps = fakeDeps();
    const result = await coordinateWebhook(deps, checkSuiteInput("in_progress"));
    expect(result).toEqual({ outcome: "no_event" });
    expect(deps.getLabels).not.toHaveBeenCalled();
    expect(deps.getMergeGateFacts).not.toHaveBeenCalled();
  });

  it("completed, but this PR isn't in auto-merge -> no_event, never fetches gate facts (nothing else watches CI this way)", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]) });
    const result = await coordinateWebhook(deps, checkSuiteInput());
    expect(result).toEqual({ outcome: "no_event" });
    expect(deps.getMergeGateFacts).not.toHaveBeenCalled();
  });

  it("completed, in auto-merge, gate genuinely passes -> no_event (merge-flow's own Step 3 does the actual merge, not the reducer)", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]) });
    const result = await coordinateWebhook(deps, checkSuiteInput());
    expect(result).toEqual({ outcome: "no_event" });
    expect(deps.getMergeGateFacts).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412);
  });

  it("completed, in auto-merge, CI green but mergeable still computing -> re-read, then no_event", async () => {
    vi.useFakeTimers();
    try {
      const getMergeGateFacts = vi.fn(async () => gateFacts({ mergeable: null }));
      const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]), getMergeGateFacts });
      const done = coordinateWebhook(deps, checkSuiteInput());
      await vi.runAllTimersAsync();
      expect(await done).toEqual({ outcome: "no_event" });
      expect(getMergeGateFacts).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("completed, in auto-merge, CI red while mergeable is still computing -> still handed to rework (found by e2e)", async () => {
    vi.useFakeTimers();
    try {
      const deps = fakeDeps({
        getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]),
        getMergeGateFacts: vi.fn(async () =>
          gateFacts({ mergeable: null, checkRuns: [{ name: "ci", status: "completed", conclusion: "failure" }] }),
        ),
      });
      const done = coordinateWebhook(deps, checkSuiteInput());
      await vi.runAllTimersAsync();
      expect(await done).toMatchObject({ outcome: "applied", event: EVENTS.MERGE_GATE_FAILED_SOFT });
      expect(deps.addLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AUTO_REWORKING);
    } finally {
      vi.useRealTimers();
    }
  });

  it("completed, in auto-merge, another suite still running -> no_event", async () => {
    const deps = fakeDeps({
      getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]),
      getMergeGateFacts: vi.fn(async () =>
        gateFacts({
          checkRuns: [
            { status: "completed", conclusion: "failure" },
            { status: "in_progress", conclusion: null },
          ],
        }),
      ),
    });
    expect(await coordinateWebhook(deps, checkSuiteInput())).toEqual({ outcome: "no_event" });
    expect(deps.addLabel).not.toHaveBeenCalled();
  });

  it("completed, in auto-merge, a required check genuinely failed -> auto-merge swapped for auto-rework, with a comment", async () => {
    const deps = fakeDeps({
      getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]),
      getMergeGateFacts: vi.fn(async () =>
        gateFacts({ checkRuns: [{ name: "build", status: "completed", conclusion: "failure" }] }),
      ),
    });
    const result = await coordinateWebhook(deps, checkSuiteInput());
    expect(result).toMatchObject({ outcome: "applied", event: EVENTS.MERGE_GATE_FAILED_SOFT });
    expect(deps.removeLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AUTO_MERGING);
    expect(deps.addLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AUTO_REWORKING);
    expect(deps.commentOnIssue).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, expect.stringContaining("CI failing: build"));
    expect(deps.setCiFix).toHaveBeenCalledWith({ attempts: 1, pending: true });
    // The rule fires rework-loop itself (no echo), so the watchdog moves to it.
    expect(deps.fireRoutine).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, ROUTINES.REWORK_LOOP);
    expect(deps.setPendingFire).toHaveBeenCalledWith(expect.objectContaining({ run: ROUTINES.REWORK_LOOP }));
  });

  it("completed, in auto-merge, unresolvable conflicts -> auto-merge swapped for merge-blocked, with a comment", async () => {
    const deps = fakeDeps({
      getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]),
      getMergeGateFacts: vi.fn(async () => gateFacts({ mergeable: false })),
    });
    const result = await coordinateWebhook(deps, checkSuiteInput());
    expect(result.outcome).toBe("applied");
    expect(deps.removeLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AUTO_MERGING);
    expect(deps.addLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.MERGE_BLOCKED);
    expect(deps.commentOnIssue).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, expect.stringContaining("merge conflict"));
  });

  it("completed, in auto-merge, changes requested -> merge-blocked, with a comment", async () => {
    const deps = fakeDeps({
      getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]),
      getMergeGateFacts: vi.fn(async () => gateFacts({ latestReviewState: "changes_requested" })),
    });
    const result = await coordinateWebhook(deps, checkSuiteInput());
    expect(result.outcome).toBe("applied");
    expect(deps.addLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.MERGE_BLOCKED);
    expect(deps.commentOnIssue).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, expect.stringContaining("changes requested"));
  });
});

describe("coordinateWebhook — the merge gate when auto-merge is added", () => {
  const autoMergeAdded = input({
    payload: { action: "pull_request.labeled", label: { name: LABELS.AUTO_MERGING }, sender: { login: "phil", type: "User" } },
  });
  const pending = [{ status: "in_progress" as const, conclusion: null }];

  it("clean (CI still running is fine) -> fires merge-flow as before, no block", async () => {
    const deps = fakeDeps({
      getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]),
      getMergeGateFacts: vi.fn(async () => gateFacts({ checkRuns: pending })),
    });
    const result = await coordinateWebhook(deps, autoMergeAdded);
    expect(result).toMatchObject({ outcome: "applied", event: EVENTS.LABELLED_AUTO_MERGING });
    expect(deps.fireRoutine).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, ROUTINES.MERGE_FLOW);
    expect(deps.addLabel).not.toHaveBeenCalled();
  });

  it.each([
    ["a merge conflict", { mergeable: false }, "merge conflict"],
    ["requested changes", { latestReviewState: "changes_requested" as const }, "changes requested"],
  ])("%s, even with CI still running -> merge-blocked, a comment, and merge-flow NOT fired", async (_name, facts, reason) => {
    const deps = fakeDeps({
      getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]),
      getMergeGateFacts: vi.fn(async () => gateFacts({ checkRuns: pending, ...facts })),
    });
    const result = await coordinateWebhook(deps, autoMergeAdded);
    expect(result).toMatchObject({ outcome: "applied", from: LABELS.AUTO_MERGING, event: EVENTS.MERGE_GATE_FAILED_HARD });
    expect(deps.removeLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AUTO_MERGING);
    expect(deps.addLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.MERGE_BLOCKED);
    expect(deps.commentOnIssue).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, expect.stringContaining(reason));
    expect(deps.fireRoutine).not.toHaveBeenCalled();
  });

  it("mergeable still being computed -> re-read before deciding", async () => {
    vi.useFakeTimers();
    try {
      const getMergeGateFacts = vi
        .fn()
        .mockResolvedValueOnce(gateFacts({ mergeable: null }))
        .mockResolvedValueOnce(gateFacts({ mergeable: false }));
      const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]), getMergeGateFacts });
      const done = coordinateWebhook(deps, autoMergeAdded);
      await vi.runAllTimersAsync();
      expect(await done).toMatchObject({ event: EVENTS.MERGE_GATE_FAILED_HARD });
      expect(getMergeGateFacts).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-added to a merge-blocked PR that's now fixed -> merge-blocked cleared, merge-flow fired", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.MERGE_BLOCKED, LABELS.AUTO_MERGING]) });
    const result = await coordinateWebhook(deps, autoMergeAdded);
    expect(result).toMatchObject({ outcome: "applied", from: LABELS.MERGE_BLOCKED, event: EVENTS.LABELLED_AUTO_MERGING });
    expect(deps.removeLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.MERGE_BLOCKED);
    expect(deps.fireRoutine).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, ROUTINES.MERGE_FLOW);
  });

  it("re-added while still blocked -> auto-merge comes off again, merge-blocked stays", async () => {
    const deps = fakeDeps({
      getLabels: vi.fn(async () => [LABELS.MERGE_BLOCKED, LABELS.AUTO_MERGING]),
      getMergeGateFacts: vi.fn(async () => gateFacts({ mergeable: false })),
    });
    const result = await coordinateWebhook(deps, autoMergeAdded);
    expect(result).toMatchObject({ outcome: "applied", event: EVENTS.MERGE_GATE_FAILED_HARD });
    expect(deps.removeLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AUTO_MERGING);
    expect(deps.addLabel).not.toHaveBeenCalled();
    expect(deps.fireRoutine).not.toHaveBeenCalled();
  });
});

describe("coordinateWebhook — CI failing under auto-merge goes to rework, then back", () => {
  it("the cap is three fix attempts, then merge-blocked", () => {
    expect(MAX_CI_FIX_ATTEMPTS).toBe(3);
  });

  const failing = [{ name: "test", status: "completed" as const, conclusion: "failure" as const }];
  const autoMergeAdded = input({
    payload: { action: "pull_request.labeled", label: { name: LABELS.AUTO_MERGING }, sender: { login: "phil", type: "User" } },
  });
  const pushed = input({ deliveryId: "push-1", payload: { action: "pull_request.synchronize" } });
  const reworkRemoved = input({
    deliveryId: "unlabel-1",
    payload: { action: "pull_request.unlabeled", label: { name: LABELS.AUTO_REWORKING }, sender: { login: "phil", type: "User" } },
  });

  it("auto-merge added after CI already failed -> auto-rework, a comment, and rework-loop fired (not merge-flow)", async () => {
    const deps = fakeDeps({
      getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]),
      getMergeGateFacts: vi.fn(async () => gateFacts({ checkRuns: failing })),
    });
    const result = await coordinateWebhook(deps, autoMergeAdded);
    expect(result).toMatchObject({ outcome: "applied", from: LABELS.AUTO_MERGING, event: EVENTS.MERGE_GATE_FAILED_SOFT });
    expect(deps.addLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AUTO_REWORKING);
    expect(deps.commentOnIssue).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, expect.stringContaining("attempt 1 of 3"));
    expect(deps.fireRoutine).toHaveBeenCalledTimes(1);
    expect(deps.fireRoutine).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, ROUTINES.REWORK_LOOP);
  });

  it("the fix push -> auto-rework swapped back to auto-merge", async () => {
    const deps = fakeDeps({
      getLabels: vi.fn(async () => [LABELS.AUTO_REWORKING]),
      getCiFix: vi.fn(async () => ({ attempts: 1, pending: true })),
    });
    const result = await coordinateWebhook(deps, pushed);
    expect(result).toMatchObject({ outcome: "applied", event: EVENTS.CI_FIX_PUSHED });
    expect(deps.removeLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AUTO_REWORKING);
    expect(deps.addLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AUTO_MERGING);
    expect(deps.setCiFix).toHaveBeenCalledWith({ attempts: 1, pending: false });
    expect(deps.fireRoutine).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, ROUTINES.MERGE_FLOW);
  });

  it("a label webhook whose label is already gone (CI swapped it a moment earlier) -> stale, nothing done", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AUTO_REWORKING]) });
    expect(await coordinateWebhook(deps, autoMergeAdded)).toEqual({ outcome: "stale_label", event: EVENTS.LABELLED_AUTO_MERGING });
    expect(deps.getMergeGateFacts).not.toHaveBeenCalled();
    expect(deps.logTransition).not.toHaveBeenCalled();
    expect(deps.addLabel).not.toHaveBeenCalled();
  });

  it("the self-trigger guard: the App's own label add comes back and is dropped, firing nothing", async () => {
    const deps = fakeDeps({
      botLogin: async () => "hifi-agent-orchestrator[bot]",
      getLabels: vi.fn(async () => [LABELS.AUTO_REWORKING]),
    });
    const echo = input({
      payload: {
        action: "pull_request.labeled",
        label: { name: LABELS.AUTO_REWORKING },
        sender: { login: "hifi-agent-orchestrator[bot]", type: "Bot" },
      },
    });
    expect(await coordinateWebhook(deps, echo)).toEqual({ outcome: "no_event" });
    expect(deps.fireRoutine).not.toHaveBeenCalled();
  });

  it("…while a human adding the same label still fires the loop", async () => {
    const deps = fakeDeps({
      botLogin: async () => "hifi-agent-orchestrator[bot]",
      getLabels: vi.fn(async () => [LABELS.AUTO_REWORKING]),
    });
    const human = input({
      payload: { action: "pull_request.labeled", label: { name: LABELS.AUTO_REWORKING }, sender: { login: "phil", type: "User" } },
    });
    expect(await coordinateWebhook(deps, human)).toMatchObject({ outcome: "applied", event: EVENTS.LABELLED_AUTO_REWORKING });
    expect(deps.fireRoutine).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, ROUTINES.REWORK_LOOP);
  });

  it("a review rework's push (no CI-fix pending) -> auto-rework just cleared, as before", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AUTO_REWORKING]) });
    const result = await coordinateWebhook(deps, pushed);
    expect(result).toMatchObject({ outcome: "applied", event: EVENTS.REWORK_PUSHED });
    expect(deps.removeLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AUTO_REWORKING);
    expect(deps.addLabel).not.toHaveBeenCalled();
  });

  it("auto-rework removed without a push -> the CI-fix ends, so the next push is a plain rework", async () => {
    const deps = fakeDeps({ getCiFix: vi.fn(async () => ({ attempts: 2, pending: true })) });
    await coordinateWebhook(deps, reworkRemoved);
    expect(deps.setCiFix).toHaveBeenCalledWith({ attempts: 2, pending: false });
  });

  it("CI still failing after 3 fix attempts -> merge-blocked instead of another rework", async () => {
    const deps = fakeDeps({
      getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]),
      getMergeGateFacts: vi.fn(async () => gateFacts({ checkRuns: failing })),
      getCiFix: vi.fn(async () => ({ attempts: 3, pending: false })),
    });
    const result = await coordinateWebhook(deps, input({ payload: { action: "check_suite.completed", check_suite: { conclusion: "failure", status: "completed" } } }));
    expect(result).toMatchObject({ outcome: "applied", event: EVENTS.MERGE_GATE_FAILED_HARD });
    expect(deps.addLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.MERGE_BLOCKED);
    expect(deps.addLabel).not.toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AUTO_REWORKING);
    expect(deps.commentOnIssue).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, expect.stringContaining("after 3 fix attempts (test)"));
  });

  it("a human re-adding auto-merge after merge-blocked resets the count", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.MERGE_BLOCKED, LABELS.AUTO_MERGING]) });
    await coordinateWebhook(deps, autoMergeAdded);
    expect(deps.setCiFix).toHaveBeenCalledWith(null);
  });

  it("shadow mode: logged as the swap, nothing written or commented", async () => {
    const deps = fakeDeps({
      enforced: () => false,
      getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]),
      getMergeGateFacts: vi.fn(async () => gateFacts({ checkRuns: failing })),
    });
    const result = await coordinateWebhook(deps, autoMergeAdded);
    expect(result).toMatchObject({ event: EVENTS.MERGE_GATE_FAILED_SOFT });
    expect(deps.addLabel).not.toHaveBeenCalled();
    expect(deps.commentOnIssue).not.toHaveBeenCalled();
  });
});
