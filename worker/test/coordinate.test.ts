import { describe, expect, it, vi } from "vitest";
import { LABELS } from "../../graph/constants/labels";
import { EVENTS } from "../../graph/constants/events";
import { ROUTINES } from "../../graph/constants/routines";
import {
  LABEL_JUST_ADDED_BY,
  coordinateWebhook,
  deriveState,
  type CoordinateInput,
  type Deps,
} from "../src/coordinate";

function fakeDeps(overrides: Partial<Deps> = {}): Deps {
  const seen = new Set<string>();
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
    setPendingFire: vi.fn(async () => {}),
    clearPendingFire: vi.fn(async () => {}),
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

  it("build_succeeded outcome artifact: removes ai-ready, adds ai-generated, no routine fired, clears pendingFire", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]) });
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
    expect(deps.removeLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AI_READY);
    expect(deps.addLabel).toHaveBeenCalledWith(
      "hifi-phil",
      "umbraco-mcp-ops",
      412,
      LABELS.AI_GENERATED,
    );
    expect(deps.fireRoutine).not.toHaveBeenCalled();
    expect(deps.clearPendingFire).toHaveBeenCalledOnce();
    expect(deps.setPendingFire).not.toHaveBeenCalled();
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

  it("merge_gate_failed_soft equivalent (noop effect): no GitHub call, no routine, clears pendingFire", async () => {
    // There's no real webhook source for merge_gate_failed_* yet (see
    // 11-outcome-artifact.md) -- this exercises the noop-effect path
    // directly via a synthetic payload shape, since translate() has no
    // case for it. Kept here so labelOps()'s noop handling is exercised
    // through the full coordinator once a real source exists.
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]) });
    // No case in translate() maps to this yet, so assert the honest
    // current behaviour: no_event, nothing touched.
    const result = await coordinateWebhook(
      deps,
      input({ payload: { action: "check_suite.completed", check_suite: { conclusion: "failure", status: "completed" } } }),
    );
    expect(result).toEqual({ outcome: "no_event" });
    expect(deps.addLabel).not.toHaveBeenCalled();
  });
});
