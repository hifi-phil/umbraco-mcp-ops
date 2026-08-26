import { describe, expect, it, vi } from "vitest";
import { LABELS } from "../../graph/constants/labels";
import { EVENTS } from "../../graph/constants/events";
import { ROUTINES } from "../../graph/constants/routines";
import {
  LABEL_JUST_ADDED_BY,
  coordinateWebhook,
  coordinateRoutineSignal,
  deriveState,
  type CoordinateInput,
  type Deps,
  type PendingFire,
} from "../src/coordinate";
import type { RoutineSignal } from "../../graph/routines/from-routine";
import type { MergeGateFacts } from "../../graph/github/merge-gate";

function gateFacts(overrides: Partial<MergeGateFacts> = {}): MergeGateFacts {
  return {
    checkRuns: [{ status: "completed", conclusion: "success" }],
    latestReviewState: "approved",
    mergeable: true,
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<Deps> = {}): Deps {
  const seen = new Set<string>();
  let pendingFire: PendingFire | null = null;
  return {
    getLabels: vi.fn(async () => []),
    addLabel: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
    closeIssue: vi.fn(async () => {}),
    fireRoutine: vi.fn(async () => {}),
    logTransition: vi.fn(async () => {}),
    hasSeenDelivery: vi.fn(async (id: string) => seen.has(id)),
    markSeenDelivery: vi.fn(async (id: string) => {
      seen.add(id);
    }),
    setPendingFire: vi.fn(async (info: PendingFire) => {
      pendingFire = info;
    }),
    clearPendingFire: vi.fn(async () => {
      pendingFire = null;
    }),
    getPendingFire: vi.fn(async () => pendingFire),
    getMergeGateFacts: vi.fn(async () => gateFacts()),
    ...overrides,
  };
}

function input(overrides: Partial<CoordinateInput> = {}): CoordinateInput {
  return {
    deliveryId: "delivery-1",
    owner: "hifi-phil",
    repo: "umbraco-mcp-ops",
    issueNumber: 412,
    payload: { action: "unknown" },
    ...overrides,
  };
}

describe("LABEL_JUST_ADDED_BY — completeness", () => {
  it("has an entry for every labelled_* event in EVENTS", () => {
    const labelledEvents = Object.values(EVENTS).filter((e) => e.startsWith("labelled_"));
    for (const e of labelledEvents) {
      expect(LABEL_JUST_ADDED_BY, `missing an entry for ${e}`).toHaveProperty(e);
    }
  });
});

describe("deriveState", () => {
  it("no tracked label -> none", () => {
    expect(deriveState(["dependencies"])).toBe("none");
  });

  it("exactly one tracked label -> that label", () => {
    expect(deriveState([LABELS.AI_READY, "dependencies"])).toBe(LABELS.AI_READY);
  });

  it("more than one tracked label -> ambiguous", () => {
    expect(deriveState([LABELS.AI_READY, LABELS.AI_DISCUSSING])).toBe("ambiguous");
  });
});

describe("coordinateWebhook — dedupe", () => {
  it("the same delivery id twice is only processed once", async () => {
    const deps = fakeDeps();
    const msg = input({
      payload: { action: "issues.labeled", label: { name: LABELS.AI_READY } },
    });
    await coordinateWebhook(deps, msg);
    const second = await coordinateWebhook(deps, msg);
    expect(second).toEqual({ outcome: "deduped" });
    expect(deps.logTransition).toHaveBeenCalledTimes(1);
  });
});

describe("coordinateWebhook — no event / no rule", () => {
  it("a payload translate() can't map -> no_event, no GitHub calls", async () => {
    const deps = fakeDeps();
    const result = await coordinateWebhook(deps, input({ payload: { action: "pull_request.opened" } }));
    expect(result).toEqual({ outcome: "no_event" });
    expect(deps.addLabel).not.toHaveBeenCalled();
    expect(deps.logTransition).not.toHaveBeenCalled();
  });

  it("a legal event with no rule for the current state -> dropped, logged", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => []) });
    const result = await coordinateWebhook(
      deps,
      input({ payload: { action: "pull_request.closed", pull_request: { merged: true } } }),
    );
    expect(result).toEqual({ outcome: "dropped_no_rule", from: "none", event: EVENTS.MERGED });
    expect(deps.logTransition).toHaveBeenCalledWith(
      expect.objectContaining({ droppedReason: "no matching rule for this (state, event) pair" }),
    );
  });

  it("a labelled_* event's own label doesn't count towards ambiguity — only genuinely pre-existing labels do", async () => {
    // ai-ready is what THIS event just added, so it's excluded before
    // checking ambiguity; ai-discussing was already there. The real
    // pre-event state is just "ai-discussing", which has no rule for
    // labelled_ai_ready -- correctly dropped, not ambiguous.
    const deps = fakeDeps({
      getLabels: vi.fn(async () => [LABELS.AI_READY, LABELS.AI_DISCUSSING]),
    });
    const result = await coordinateWebhook(
      deps,
      input({ payload: { action: "issues.labeled", label: { name: LABELS.AI_READY } } }),
    );
    expect(result).toEqual({
      outcome: "dropped_no_rule",
      from: LABELS.AI_DISCUSSING,
      event: EVENTS.LABELLED_AI_READY,
    });
  });

  it("two genuinely pre-existing tracked labels (unrelated to this event) -> ambiguous_state", async () => {
    const deps = fakeDeps({
      getLabels: vi.fn(async () => [LABELS.AI_READY, LABELS.AI_BLOCKED]),
    });
    const body = [
      `<!-- agent-outcome:${ROUTINES.ISSUE_BUILD_LOOP} -->`,
      "```json",
      JSON.stringify({ outcome: "build_succeeded", pr: 123 }),
      "```",
    ].join("\n");
    const result = await coordinateWebhook(
      deps,
      input({ payload: { action: "issue_comment.created", comment: { body } } }),
    );
    expect(result).toEqual({ outcome: "ambiguous_state" });
    expect(deps.addLabel).not.toHaveBeenCalled();
    expect(deps.logTransition).toHaveBeenCalledWith(
      expect.objectContaining({ fromState: "ambiguous" }),
    );
  });
});

describe("coordinateWebhook — a real transition, applied end to end", () => {
  it("labelled_ai_ready: no label ops needed (webhook already added it), fires the routine, sets pendingFire", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]) });
    const result = await coordinateWebhook(
      deps,
      input({ payload: { action: "issues.labeled", label: { name: LABELS.AI_READY } } }),
    );
    expect(result.outcome).toBe("applied");
    expect(deps.addLabel).not.toHaveBeenCalled(); // already present from the triggering webhook
    expect(deps.fireRoutine).toHaveBeenCalledWith(
      ROUTINES.ISSUE_BUILD_LOOP,
      expect.stringContaining("#412"),
    );
    expect(deps.setPendingFire).toHaveBeenCalledWith({
      owner: "hifi-phil",
      repo: "umbraco-mcp-ops",
      issueNumber: 412,
      run: ROUTINES.ISSUE_BUILD_LOOP,
    });
    expect(deps.clearPendingFire).not.toHaveBeenCalled();
  });

  it("build_succeeded outcome artifact, realistic ordering (issue-build-loop's own Step 3 already swapped ai-ready -> ai-generated before commenting): applied as a noop confirm, no GitHub write, clears pendingFire", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_GENERATED]) });
    const body = [
      "PR opened.",
      "",
      `<!-- agent-outcome:${ROUTINES.ISSUE_BUILD_LOOP} -->`,
      "```json",
      JSON.stringify({ outcome: "build_succeeded", pr: 123 }),
      "```",
    ].join("\n");
    const result = await coordinateWebhook(
      deps,
      input({ payload: { action: "issue_comment.created", comment: { body } } }),
    );
    expect(result.outcome).toBe("applied");
    expect(deps.removeLabel).not.toHaveBeenCalled();
    expect(deps.addLabel).not.toHaveBeenCalled();
    expect(deps.fireRoutine).not.toHaveBeenCalled();
    expect(deps.clearPendingFire).toHaveBeenCalledOnce();
    expect(deps.setPendingFire).not.toHaveBeenCalled();
  });

  it("build_succeeded outcome artifact arriving BEFORE the label swap is visible (a webhook race): dropped_no_rule, not a redundant swap", async () => {
    // rule.from is keyed on AI_GENERATED specifically because the real
    // ordering always swaps first — this documents what happens on the
    // (currently unobserved) reverse ordering: dropped, not a second
    // remove/add. See graph.ts's comment on this rule and
    // worker/README.md's "black-box shape" section for how this was found.
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]) });
    const body = [
      `<!-- agent-outcome:${ROUTINES.ISSUE_BUILD_LOOP} -->`,
      "```json",
      JSON.stringify({ outcome: "build_succeeded", pr: 123 }),
      "```",
    ].join("\n");
    const result = await coordinateWebhook(
      deps,
      input({ payload: { action: "issue_comment.created", comment: { body } } }),
    );
    expect(result).toEqual({
      outcome: "dropped_no_rule",
      from: LABELS.AI_READY,
      event: EVENTS.BUILD_SUCCEEDED,
    });
    expect(deps.removeLabel).not.toHaveBeenCalled();
    expect(deps.addLabel).not.toHaveBeenCalled();
  });

  it("merged PR: closes the issue via the close effect, not a label op", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]) });
    const result = await coordinateWebhook(
      deps,
      input({ payload: { action: "pull_request.closed", pull_request: { merged: true } } }),
    );
    expect(result.outcome).toBe("applied");
    expect(deps.closeIssue).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412);
    expect(deps.addLabel).not.toHaveBeenCalled();
    expect(deps.removeLabel).not.toHaveBeenCalled();
  });

});

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

  it("completed, but this PR isn't in auto-merging -> no_event, never fetches gate facts (nothing else watches CI this way)", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]) });
    const result = await coordinateWebhook(deps, checkSuiteInput());
    expect(result).toEqual({ outcome: "no_event" });
    expect(deps.getMergeGateFacts).not.toHaveBeenCalled();
  });

  it("completed, in auto-merging, gate genuinely passes -> no_event (merge-flow's own Step 3 does the actual merge, not the reducer)", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]) });
    const result = await coordinateWebhook(deps, checkSuiteInput());
    expect(result).toEqual({ outcome: "no_event" });
    expect(deps.getMergeGateFacts).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412);
  });

  it("completed, in auto-merging, still_pending per the real facts (e.g. mergeable still computing) -> no_event", async () => {
    const deps = fakeDeps({
      getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]),
      getMergeGateFacts: vi.fn(async () => gateFacts({ mergeable: null })),
    });
    const result = await coordinateWebhook(deps, checkSuiteInput());
    expect(result).toEqual({ outcome: "no_event" });
  });

  it("completed, in auto-merging, a required check genuinely failed -> applied, noop effect, clears pendingFire", async () => {
    const deps = fakeDeps({
      getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]),
      getMergeGateFacts: vi.fn(async () =>
        gateFacts({ checkRuns: [{ status: "completed", conclusion: "failure" }] }),
      ),
    });
    const result = await coordinateWebhook(deps, checkSuiteInput());
    expect(result.outcome).toBe("applied");
    expect(deps.addLabel).not.toHaveBeenCalled();
    expect(deps.removeLabel).not.toHaveBeenCalled();
    expect(deps.clearPendingFire).toHaveBeenCalledOnce();
  });

  it("completed, in auto-merging, unresolvable conflicts -> applied, unlabel effect (needs a human)", async () => {
    const deps = fakeDeps({
      getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]),
      getMergeGateFacts: vi.fn(async () => gateFacts({ mergeable: false })),
    });
    const result = await coordinateWebhook(deps, checkSuiteInput());
    expect(result.outcome).toBe("applied");
    expect(deps.removeLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AUTO_MERGING);
  });

  it("completed, in auto-merging, changes requested -> applied, unlabel effect", async () => {
    const deps = fakeDeps({
      getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]),
      getMergeGateFacts: vi.fn(async () => gateFacts({ latestReviewState: "changes_requested" })),
    });
    const result = await coordinateWebhook(deps, checkSuiteInput());
    expect(result.outcome).toBe("applied");
    expect(deps.removeLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AUTO_MERGING);
  });
});

describe("coordinateRoutineSignal — the direct routine-to-DO heartbeat channel", () => {
  const signalInput = (signal: RoutineSignal) => ({
    owner: "hifi-phil",
    repo: "umbraco-mcp-ops",
    signal,
  });

  it("a 'process' signal with an empty step -> invalid_signal (parseRoutineSignal's own validation), no side effects", async () => {
    const deps = fakeDeps();
    const result = await coordinateRoutineSignal(
      deps,
      signalInput({ kind: "process", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412, step: "" }),
    );
    expect(result).toEqual({ outcome: "invalid_signal" });
    expect(deps.setPendingFire).not.toHaveBeenCalled();
    expect(deps.clearPendingFire).not.toHaveBeenCalled();
  });

  it("nothing pending for this issue -> no_pending_fire, a harmless stray signal", async () => {
    const deps = fakeDeps();
    const result = await coordinateRoutineSignal(
      deps,
      signalInput({ kind: "process", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412, step: "driving CI green" }),
    );
    expect(result).toEqual({ outcome: "no_pending_fire" });
  });

  it("a different routine currently owns this issue -> mismatched_routine, no watchdog change", async () => {
    const deps = fakeDeps();
    await deps.setPendingFire({
      owner: "hifi-phil",
      repo: "umbraco-mcp-ops",
      issueNumber: 412,
      run: ROUTINES.MERGE_FLOW,
    });
    const result = await coordinateRoutineSignal(
      deps,
      signalInput({ kind: "process", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412, step: "driving CI green" }),
    );
    expect(result).toEqual({
      outcome: "mismatched_routine",
      expected: ROUTINES.MERGE_FLOW,
      got: ROUTINES.ISSUE_BUILD_LOOP,
    });
  });

  it("process, matching routine -> heartbeat_extended, re-sets pendingFire (which re-schedules the alarm)", async () => {
    const deps = fakeDeps();
    const pending = {
      owner: "hifi-phil",
      repo: "umbraco-mcp-ops",
      issueNumber: 412,
      run: ROUTINES.ISSUE_BUILD_LOOP,
    };
    await deps.setPendingFire(pending);
    vi.mocked(deps.setPendingFire).mockClear();

    const result = await coordinateRoutineSignal(
      deps,
      signalInput({ kind: "process", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412, step: "driving CI green" }),
    );

    expect(result).toEqual({ outcome: "heartbeat_extended" });
    expect(deps.setPendingFire).toHaveBeenCalledWith(pending);
    expect(deps.clearPendingFire).not.toHaveBeenCalled();
  });

  it("completion, matching routine -> completion_acknowledged, clears pendingFire early (the real transition still comes from the GitHub webhook, later)", async () => {
    const deps = fakeDeps();
    await deps.setPendingFire({
      owner: "hifi-phil",
      repo: "umbraco-mcp-ops",
      issueNumber: 412,
      run: ROUTINES.ISSUE_BUILD_LOOP,
    });

    const result = await coordinateRoutineSignal(
      deps,
      signalInput({
        kind: "completion",
        routine: ROUTINES.ISSUE_BUILD_LOOP,
        issue: 412,
        outcome: { outcome: "build_succeeded", pr: 123 },
      }),
    );

    expect(result).toEqual({ outcome: "completion_acknowledged" });
    expect(deps.clearPendingFire).toHaveBeenCalledOnce();
    expect(await deps.getPendingFire()).toBeNull();
  });

  it("completion with an unrecognized outcome shape -> invalid_signal (parseRoutineSignal's own validation)", async () => {
    const deps = fakeDeps();
    await deps.setPendingFire({
      owner: "hifi-phil",
      repo: "umbraco-mcp-ops",
      issueNumber: 412,
      run: ROUTINES.ISSUE_BUILD_LOOP,
    });
    const result = await coordinateRoutineSignal(
      deps,
      signalInput({
        kind: "completion",
        routine: ROUTINES.ISSUE_BUILD_LOOP,
        issue: 412,
        outcome: { outcome: "not_a_real_outcome" },
      }),
    );
    expect(result).toEqual({ outcome: "invalid_signal" });
    expect(deps.clearPendingFire).not.toHaveBeenCalled();
  });
});
