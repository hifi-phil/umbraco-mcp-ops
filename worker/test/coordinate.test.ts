import { describe, expect, it, vi } from "vitest";
import { LABELS } from "../../graph/constants/labels";
import { EVENTS } from "../../graph/constants/events";
import { ROUTINES } from "../../graph/constants/routines";
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
  let ciFix: CiFix | null = null;
  let reconcileReported: string | null = null;
  let completed: string | null = null;
  return {
    getLabels: vi.fn(async () => []),
    addLabel: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
    closeIssue: vi.fn(async () => {}),
    commentOnIssue: vi.fn(async () => {}),
    fireRoutine: vi.fn(async () => {}),
    logTransition: vi.fn(async () => {}),
    hasSeenDelivery: vi.fn(async (id: string) => seen.has(id)),
    markSeenDelivery: vi.fn(async (id: string) => {
      seen.add(id);
    }),
    unmarkSeenDelivery: vi.fn(async (id: string) => {
      seen.delete(id);
    }),
    setPendingFire: vi.fn(async (info: PendingFire) => {
      pendingFire = info;
    }),
    clearPendingFire: vi.fn(async () => {
      pendingFire = null;
    }),
    getPendingFire: vi.fn(async () => pendingFire),
    watchdogArmed: vi.fn(async () => pendingFire !== null),
    recordStatus: vi.fn(async () => {}),
    getMergeGateFacts: vi.fn(async () => gateFacts()),
    getCiFix: vi.fn(async () => ciFix),
    setCiFix: vi.fn(async (state: CiFix | null) => {
      ciFix = state;
    }),
    // These tests are about the write path; shadow and per-event
    // enforcement have their own describe blocks.
    enforced: () => true,
    watchdogMinutes: watchdogMinutesFor,
    botLogin: async () => null,
    lastActivityAt: async () => null,
    markCompleted: vi.fn(async (at: string) => {
      completed = at;
    }),
    completedAt: vi.fn(async () => completed),
    getReconcileReported: vi.fn(async () => reconcileReported),
    setReconcileReported: vi.fn(async (s: string) => {
      reconcileReported = s;
    }),
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

describe("resolveMode — fails safe to shadow", () => {
  it('only the exact string "enforce" enforces', () => {
    expect(resolveMode("enforce")).toBe("enforce");
    for (const raw of [undefined, "", "shadow", "enforced", "ENFORCE", " enforce"]) {
      expect(resolveMode(raw), `MODE=${JSON.stringify(raw)}`).toBe("shadow");
    }
  });
});

describe("shadowDeps", () => {
  it("runs the same decision path but reaches none of the write deps", async () => {
    const deps = fakeDeps();
    const result = await coordinateWebhook(
      shadowDeps(deps),
      input({
        payload: { action: "issues.labeled", label: { name: LABELS.AI_READY }, sender: { login: "phil", type: "User" } },
      }),
    );

    expect(result.outcome).toBe("applied");
    for (const write of ["addLabel", "removeLabel", "closeIssue", "commentOnIssue", "fireRoutine"] as const) {
      expect(deps[write], write).not.toHaveBeenCalled();
    }
    expect(deps.logTransition).toHaveBeenCalledTimes(1);
    expect(deps.setPendingFire).toHaveBeenCalledTimes(1);
  });
});

describe("resolveEnforced — MODE plus the watchdog's own switch (Phase 4)", () => {
  it("MODE=enforce enforces every event except the watchdog", () => {
    const enforced = resolveEnforced("enforce", undefined);
    expect(enforced(EVENTS.LABELLED_AI_READY)).toBe(true);
    expect(enforced(EVENTS.MERGED)).toBe(true);
    expect(enforced(EVENTS.WATCHDOG_EXPIRED)).toBe(false);
  });

  it("WATCHDOG=enforce adds the watchdog, but only under MODE=enforce", () => {
    expect(resolveEnforced("enforce", "enforce")(EVENTS.WATCHDOG_EXPIRED)).toBe(true);
    expect(resolveEnforced(undefined, "enforce")(EVENTS.WATCHDOG_EXPIRED)).toBe(false);
  });

  it("anything but exactly \"enforce\" is shadow (fails towards shadow)", () => {
    for (const raw of [undefined, "", "shadow", "enforced", "ENFORCE"]) {
      expect(resolveEnforced(raw, "enforce")(EVENTS.LABELLED_AUTO_MERGING), String(raw)).toBe(false);
    }
  });
});

describe("coordinateWebhook — enforced events vs the shadowed watchdog", () => {
  const enforced = resolveEnforced("enforce", undefined);
  const mergeLabel = { action: "pull_request.labeled", label: { name: LABELS.AUTO_MERGING }, sender: { login: "phil", type: "User" as const } };

  it("an enforced event fires for real and its row says enforce", async () => {
    const deps = fakeDeps({ enforced, getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]) });
    const result = await coordinateWebhook(deps, input({ payload: mergeLabel }));
    expect(result).toMatchObject({ outcome: "applied", event: EVENTS.LABELLED_AUTO_MERGING });
    expect(deps.fireRoutine).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, ROUTINES.MERGE_FLOW);
    expect(deps.logTransition).toHaveBeenCalledWith(expect.objectContaining({ mode: "enforce" }));
    expect(deps.setPendingFire).toHaveBeenCalledOnce();
  });

  it("with the watchdog in shadow, an expiry posts no comment, moves nothing, and logs shadow", async () => {
    const pending = { owner: "hifi-phil", repo: "umbraco-mcp-ops", issueNumber: 412, run: ROUTINES.MERGE_FLOW };
    const deps = fakeDeps({ enforced, getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]) });
    await deps.setPendingFire(pending);
    await coordinateWatchdogExpired(deps);
    expect(deps.commentOnIssue).not.toHaveBeenCalled();
    expect(deps.addLabel).not.toHaveBeenCalled();
    expect(deps.logTransition).toHaveBeenCalledWith(
      expect.objectContaining({ event: EVENTS.WATCHDOG_EXPIRED, mode: "shadow" }),
    );
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

  it("a delivery that failed is processed again when GitHub redelivers it (same id)", async () => {
    let failOnce = true;
    const deps = fakeDeps({
      closeIssue: vi.fn(async () => {
        if (failOnce) {
          failOnce = false;
          throw new Error("GitHub API PATCH …/issues/412 failed: 403");
        }
      }),
      getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]),
    });
    const merged = input({ deliveryId: "d-merged", payload: { action: "pull_request.closed", pull_request: { merged: true } } });

    await expect(coordinateWebhook(deps, merged)).rejects.toThrow(/403/);
    const redelivered = await coordinateWebhook(deps, merged);

    expect(redelivered).toMatchObject({ outcome: "applied", event: EVENTS.MERGED });
    expect(deps.closeIssue).toHaveBeenCalledTimes(2);
    // And now it IS seen: a third copy is dropped.
    expect(await coordinateWebhook(deps, merged)).toEqual({ outcome: "deduped" });
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
    // generated-by-ai added while the issue is in ai-discuss: build_succeeded
    // has no rule from there, and it isn't a contextual event, so it's a gap.
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_DISCUSSING]) });
    const result = await coordinateWebhook(
      deps,
      input({ payload: { action: "issues.labeled", label: { name: LABELS.AI_GENERATED }, sender: { login: "phil", type: "User" } } }),
    );
    expect(result).toEqual({ outcome: "dropped_no_rule", from: LABELS.AI_DISCUSSING, event: EVENTS.BUILD_SUCCEEDED });
    expect(deps.logTransition).toHaveBeenCalledWith(
      expect.objectContaining({ droppedReason: "no matching rule for this (state, event) pair" }),
    );
  });

  it("a contextual event outside its states (a merge with no auto-merge, a push with no auto-rework) -> ignored, not logged", async () => {
    for (const payload of [
      { action: "pull_request.closed", pull_request: { merged: true } },
      { action: "pull_request.synchronize" },
    ]) {
      const deps = fakeDeps({ getLabels: vi.fn(async () => []) });
      const result = await coordinateWebhook(deps, input({ payload }));
      expect(result, payload.action).toMatchObject({ outcome: "ignored", from: "none" });
      expect(deps.logTransition, payload.action).not.toHaveBeenCalled();
    }
  });

  it("the build loop swapping its own label (no outcome comment) clears the watchdog", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_GENERATED]) });
    await deps.setPendingFire({ owner: "hifi-phil", repo: "umbraco-mcp-ops", issueNumber: 412, run: ROUTINES.ISSUE_BUILD_LOOP });
    const result = await coordinateWebhook(
      deps,
      input({ payload: { action: "issues.labeled", label: { name: LABELS.AI_GENERATED }, sender: { login: "phil", type: "User" } } }),
    );
    expect(result).toMatchObject({ outcome: "applied", from: LABELS.AI_GENERATED, event: EVENTS.BUILD_SUCCEEDED });
    expect(await deps.getPendingFire()).toBeNull();
    expect(deps.addLabel).not.toHaveBeenCalled();
    expect(deps.removeLabel).not.toHaveBeenCalled();
  });

  it("the release loop removing auto-release (blocked, no outcome comment) clears the watchdog", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => []) });
    await deps.setPendingFire({ owner: "hifi-phil", repo: "umbraco-mcp-ops", issueNumber: 412, run: ROUTINES.AUTO_RELEASE_LOOP });
    const result = await coordinateWebhook(
      deps,
      input({ payload: { action: "issues.unlabeled", label: { name: LABELS.AUTO_RELEASING }, sender: { login: "phil", type: "User" } } }),
    );
    expect(result).toMatchObject({ outcome: "applied", from: "none", event: EVENTS.UNLABELLED_AUTO_RELEASING });
    expect(await deps.getPendingFire()).toBeNull();
  });

  it("a discussion reply on an ai-discuss issue fires issue-discuss-loop, unwatched", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_DISCUSSING]) });
    const result = await coordinateWebhook(
      deps,
      input({
        payload: {
          action: "issue_comment.created",
          comment: { body: "Good point, go with option B", author_association: "OWNER", user_type: "User" },
          issue: { state: "open", is_pr: false },
        },
      }),
    );
    expect(result).toMatchObject({ outcome: "applied", from: LABELS.AI_DISCUSSING, event: EVENTS.DISCUSSION_REPLY });
    expect(deps.fireRoutine).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, ROUTINES.ISSUE_DISCUSS_LOOP);
    expect(deps.setPendingFire).not.toHaveBeenCalled();
  });

  it("the same comment on an issue that isn't in ai-discuss -> ignored, not logged", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => []) });
    const result = await coordinateWebhook(
      deps,
      input({
        payload: {
          action: "issue_comment.created",
          comment: { body: "Thanks!", author_association: "OWNER", user_type: "User" },
          issue: { state: "open", is_pr: false },
        },
      }),
    );
    expect(result).toMatchObject({ outcome: "ignored", event: EVENTS.DISCUSSION_REPLY });
    expect(deps.logTransition).not.toHaveBeenCalled();
    expect(deps.fireRoutine).not.toHaveBeenCalled();
  });

  it("watchdog timeout is per routine: releases 60, builds 60, others the 30 default", () => {
    expect(watchdogMinutesFor(ROUTINES.AUTO_RELEASE_LOOP)).toBe(60);
    expect(watchdogMinutesFor(ROUTINES.ISSUE_BUILD_LOOP)).toBe(60);
    expect(watchdogMinutesFor(ROUTINES.MERGE_FLOW)).toBe(30);
  });

  it("a labelled_* event's own label doesn't count towards ambiguity — only genuinely pre-existing labels do", async () => {
    // ready-for-ai is what THIS event just added, so it's excluded before
    // checking ambiguity; ai-discuss was already there. The real
    // pre-event state is just "ai-discuss", which has no rule for
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
    expect(deps.fireRoutine).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, ROUTINES.ISSUE_BUILD_LOOP);
    expect(deps.setPendingFire).toHaveBeenCalledWith({
      owner: "hifi-phil",
      repo: "umbraco-mcp-ops",
      issueNumber: 412,
      run: ROUTINES.ISSUE_BUILD_LOOP,
    });
    expect(deps.clearPendingFire).not.toHaveBeenCalled();
  });

  it("build_succeeded outcome artifact, realistic ordering (issue-build-loop's own Step 3 already swapped ready-for-ai -> generated-by-ai before commenting): applied as a noop confirm, no GitHub write, clears pendingFire", async () => {
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

  it("Phase 5: build_succeeded marker while ready-for-ai is still on -> the Worker does the swap itself", async () => {
    // Orchestrated loops post the marker and don't swap, so this is the main
    // path now. For a loop that still swaps, this is the rare reverse race;
    // the Worker's swap is then redundant but harmless (the loop's own
    // remove gets a tolerated 404, its add finds the label present).
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]) });
    await deps.setPendingFire({ owner: "hifi-phil", repo: "umbraco-mcp-ops", issueNumber: 412, run: ROUTINES.ISSUE_BUILD_LOOP });
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
    expect(result).toMatchObject({ outcome: "applied", from: LABELS.AI_READY, event: EVENTS.BUILD_SUCCEEDED });
    expect(deps.removeLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AI_READY);
    expect(deps.addLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AI_GENERATED);
    expect(deps.fireRoutine).not.toHaveBeenCalled();
    expect(await deps.getPendingFire()).toBeNull(); // the outcome ends the watch
  });

  it("Phase 5: release_blocked marker while auto-release is still on -> the Worker removes it", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AUTO_RELEASING]) });
    const body = [
      `<!-- agent-outcome:${ROUTINES.AUTO_RELEASE_LOOP} -->`,
      "```json",
      JSON.stringify({ outcome: "release_blocked", reason: "pre-publish review: BLOCK" }),
      "```",
    ].join("\n");
    const result = await coordinateWebhook(deps, input({ payload: { action: "issue_comment.created", comment: { body } } }));
    expect(result).toMatchObject({ outcome: "applied", from: LABELS.AUTO_RELEASING, event: EVENTS.RELEASE_BLOCKED });
    expect(deps.removeLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AUTO_RELEASING);
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

  it("labelled_ai_discussing: fires issue-discuss-loop but does NOT arm the watchdog (it never reports an outcome)", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_DISCUSSING]) });
    const result = await coordinateWebhook(
      deps,
      input({ payload: { action: "issues.labeled", label: { name: LABELS.AI_DISCUSSING } } }),
    );
    expect(result.outcome).toBe("applied");
    expect(deps.fireRoutine).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, ROUTINES.ISSUE_DISCUSS_LOOP);
    expect(deps.setPendingFire).not.toHaveBeenCalled();
    expect(deps.clearPendingFire).toHaveBeenCalledOnce();
  });
});

describe("who caused each log row (actor)", () => {
  const ref = { owner: "hifi-phil", repo: "umbraco-mcp-ops", issueNumber: 412 };

  it("a webhook's row names its sender: a person removing auto-merge reads as them", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => []) });
    await coordinateWebhook(deps, input({ payload: { action: "pull_request.unlabeled", label: { name: LABELS.AUTO_MERGING }, sender: { login: "hifi-phil", type: "User" } } }));
    expect(deps.logTransition).toHaveBeenCalledWith(expect.objectContaining({ event: EVENTS.UNLABELLED_AUTO_MERGING, actor: "hifi-phil" }));
  });

  it("the watchdog's expiry is the watchdog's", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]) });
    await deps.setPendingFire({ ...ref, run: ROUTINES.ISSUE_BUILD_LOOP });
    await coordinateWatchdogExpired(deps);
    expect(deps.logTransition).toHaveBeenCalledWith(expect.objectContaining({ event: EVENTS.WATCHDOG_EXPIRED, actor: "watchdog" }));
  });

  it("a sweep re-fire, and what its gate applies, are the sweep's", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]), lastActivityAt: async () => "2026-10-01 00:00:00" });
    await coordinateReconcile(deps, ref, { enforced: true, now: Date.parse("2026-10-02T00:00:00Z") });
    expect(deps.logTransition).toHaveBeenCalledWith(expect.objectContaining({ event: "reconcile_refire", actor: "sweep" }));

    const gated = fakeDeps({
      getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]),
      lastActivityAt: async () => "2026-10-01 00:00:00",
      getMergeGateFacts: vi.fn(async () => gateFacts({ mergeable: false })),
    });
    await coordinateReconcile(gated, ref, { enforced: true, now: Date.parse("2026-10-02T00:00:00Z") });
    expect(gated.logTransition).toHaveBeenCalledWith(expect.objectContaining({ event: EVENTS.MERGE_GATE_FAILED_HARD, actor: "sweep" }));
  });
});

describe("the live-status row (recordStatus): what each step tells the dashboard", () => {
  const ref = { owner: "hifi-phil", repo: "umbraco-mcp-ops", issueNumber: 412 };
  const readyLabel = { action: "issues.labeled", label: { name: LABELS.AI_READY } };

  it("an enforced fire -> its state, the routine, and running (watched)", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]) });
    await coordinateWebhook(deps, input({ payload: readyLabel }));
    expect(deps.recordStatus).toHaveBeenCalledWith(expect.objectContaining(ref), {
      kind: "transition",
      state: LABELS.AI_READY,
      run: ROUTINES.ISSUE_BUILD_LOOP,
      running: true,
    });
  });

  it("a shadow event -> nothing recorded (its labels never moved)", async () => {
    const deps = fakeDeps({ enforced: () => false, getLabels: vi.fn(async () => [LABELS.AI_READY]) });
    await coordinateWebhook(deps, input({ payload: readyLabel }));
    expect(deps.recordStatus).not.toHaveBeenCalled();
  });

  it("an unwatched fire (discussion) -> the routine, not running", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_DISCUSSING]) });
    await coordinateWebhook(deps, input({ payload: { action: "issues.labeled", label: { name: LABELS.AI_DISCUSSING } } }));
    expect(deps.recordStatus).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ run: ROUTINES.ISSUE_DISCUSS_LOOP, running: false }));
  });

  it("a merged PR (close) or a label simply removed (nothing left) -> gone", async () => {
    const merged = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]) });
    await coordinateWebhook(merged, input({ payload: { action: "pull_request.closed", pull_request: { merged: true } } }));
    expect(merged.recordStatus).toHaveBeenCalledWith(expect.anything(), { kind: "gone" });

    const blocked = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AUTO_RELEASING]) });
    const body = [`<!-- agent-outcome:${ROUTINES.AUTO_RELEASE_LOOP} -->`, "```json", JSON.stringify({ outcome: "release_blocked", reason: "x" }), "```"].join("\n");
    await coordinateWebhook(blocked, input({ payload: { action: "issue_comment.created", comment: { body } } }));
    expect(blocked.recordStatus).toHaveBeenCalledWith(expect.anything(), { kind: "gone" });
  });

  it("an issue closed by anyone (a person, a PR's 'Closes #') -> gone, last", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_GENERATED]) });
    await coordinateWebhook(deps, input({ payload: { action: "issues.closed" } }));
    expect(deps.recordStatus).toHaveBeenLastCalledWith(expect.objectContaining(ref), { kind: "gone", closed: true });
  });

  it("a closed release still labelled auto-release (issue_closed's noop rule applies) -> still gone (e2e #443)", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AUTO_RELEASING]) });
    const result = await coordinateWebhook(deps, input({ payload: { action: "issues.closed" } }));
    expect(result).toMatchObject({ outcome: "applied" });
    expect(deps.recordStatus).toHaveBeenLastCalledWith(expect.objectContaining(ref), { kind: "gone", closed: true });
  });

  it("a shadow watchdog's expiry (the row isn't moved) still ends the run on it -> done", async () => {
    const deps = fakeDeps({
      enforced: (e) => e !== EVENTS.WATCHDOG_EXPIRED,
      getLabels: vi.fn(async () => [LABELS.AI_READY]),
    });
    await deps.setPendingFire({ ...ref, run: ROUTINES.ISSUE_BUILD_LOOP });
    await coordinateWatchdogExpired(deps);
    expect(deps.recordStatus).toHaveBeenLastCalledWith(expect.objectContaining(ref), { kind: "done" });
  });

  it("closed -> gone and remembered as closed; reopened -> it can show again", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]) });
    await coordinateWebhook(deps, input({ payload: { action: "issues.closed" } }));
    expect(deps.recordStatus).toHaveBeenLastCalledWith(expect.objectContaining(ref), { kind: "gone", closed: true });
    await coordinateWebhook(deps, input({ deliveryId: "d-2", payload: { action: "issues.reopened" } }));
    expect(deps.recordStatus).toHaveBeenLastCalledWith(expect.objectContaining(ref), { kind: "reopened" });
  });

  it("a watchdog expiry -> ai-stuck, no routine fired, not running", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]) });
    await deps.setPendingFire({ ...ref, run: ROUTINES.ISSUE_BUILD_LOOP });
    await coordinateWatchdogExpired(deps);
    expect(deps.recordStatus).toHaveBeenCalledWith(expect.anything(), { kind: "transition", state: LABELS.AI_STUCK, run: null, running: false });
  });

  it("a heartbeat -> its step; a completion -> done", async () => {
    const deps = fakeDeps();
    await deps.setPendingFire({ ...ref, run: ROUTINES.ISSUE_BUILD_LOOP });
    await coordinateRoutineSignal(deps, { owner: "hifi-phil", repo: "umbraco-mcp-ops", signal: { kind: "process", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412, step: "running tests" } });
    expect(deps.recordStatus).toHaveBeenCalledWith(expect.objectContaining(ref), expect.objectContaining({ kind: "step", step: "running tests" }));
    await coordinateRoutineSignal(deps, {
      owner: "hifi-phil",
      repo: "umbraco-mcp-ops",
      signal: { kind: "completion", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412, outcome: { outcome: "build_blocked", reason: "x" } },
    });
    expect(deps.recordStatus).toHaveBeenLastCalledWith(expect.objectContaining(ref), { kind: "done" });
  });

  it("a sweep re-fire -> a transition with the routine, running", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]), lastActivityAt: async () => "2026-10-01 00:00:00" });
    await coordinateReconcile(deps, ref, { enforced: true, now: Date.parse("2026-10-02T00:00:00Z") });
    expect(deps.recordStatus).toHaveBeenCalledWith(ref, { kind: "transition", state: LABELS.AI_READY, run: ROUTINES.ISSUE_BUILD_LOOP, running: true });
  });

  it("a CI-fix rework handed out -> its new count", async () => {
    const deps = fakeDeps({
      getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]),
      getMergeGateFacts: vi.fn(async () => gateFacts({ checkRuns: [{ status: "completed", conclusion: "failure" }] })),
    });
    await coordinateWebhook(deps, input({ payload: { action: "pull_request.labeled", label: { name: LABELS.AUTO_MERGING } } }));
    expect(deps.recordStatus).toHaveBeenCalledWith(expect.anything(), { kind: "rework", count: 1 });
  });
});

describe("coordinateWebhook — leaving ai-stuck", () => {
  const outcomeComment = (outcome: Record<string, unknown>) =>
    [`<!-- agent-outcome:${ROUTINES.ISSUE_BUILD_LOOP} -->`, "```json", JSON.stringify(outcome), "```"].join("\n");

  it("a late build_succeeded after the routine's own swap landed (ai-stuck + generated-by-ai): read as ai-stuck, only ai-stuck removed", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_STUCK, LABELS.AI_GENERATED]) });
    const result = await coordinateWebhook(
      deps,
      input({ payload: { action: "issue_comment.created", comment: { body: outcomeComment({ outcome: "build_succeeded", pr: 123 }) } } }),
    );
    expect(result).toMatchObject({ outcome: "applied", from: LABELS.AI_STUCK, event: EVENTS.BUILD_SUCCEEDED });
    expect(deps.removeLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AI_STUCK);
    expect(deps.addLabel).not.toHaveBeenCalled(); // generated-by-ai already there
  });

  it("a late build_blocked with no swap visible yet (only ai-stuck): swaps ai-stuck -> ai-blocked itself", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_STUCK]) });
    await coordinateWebhook(
      deps,
      input({ payload: { action: "issue_comment.created", comment: { body: outcomeComment({ outcome: "build_blocked", reason: "ambiguous spec" }) } } }),
    );
    expect(deps.removeLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AI_STUCK);
    expect(deps.addLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AI_BLOCKED);
  });

  it("a human retry — re-adding ready-for-ai on a stuck issue: removes ai-stuck, re-fires issue-build-loop, re-arms the watchdog", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_STUCK, LABELS.AI_READY]) });
    const result = await coordinateWebhook(
      deps,
      input({ payload: { action: "issues.labeled", label: { name: LABELS.AI_READY } } }),
    );
    expect(result).toMatchObject({ outcome: "applied", from: LABELS.AI_STUCK });
    expect(deps.removeLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AI_STUCK);
    expect(deps.addLabel).not.toHaveBeenCalled();
    expect(deps.fireRoutine).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, ROUTINES.ISSUE_BUILD_LOOP);
    expect(deps.setPendingFire).toHaveBeenCalledOnce();
  });

  it("ai-stuck plus two other tracked labels is still genuinely ambiguous", () => {
    expect(deriveState([LABELS.AI_STUCK, LABELS.AI_GENERATED, LABELS.AUTO_MERGING])).toBe("ambiguous");
  });
});

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

describe("coordinateWebhook — manual_override (a person editing a tracked label)", () => {
  const bot = "umbraco-agent-orchestrator[bot]";
  const change = (action: string, label: string, login = "phil", type: "User" | "Bot" = "User") =>
    input({ deliveryId: "d-manual", payload: { action, label: { name: label }, sender: { login, type } } });
  const row = (deps: Deps) => (deps.logTransition as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];

  it("a person clears ai-blocked -> a manual_override row: before, the change, who, after; nothing written to GitHub", async () => {
    const deps = fakeDeps({ botLogin: async () => bot, getLabels: vi.fn(async () => []) });
    const result = await coordinateWebhook(deps, change("issues.unlabeled", LABELS.AI_BLOCKED));
    expect(result).toEqual({ outcome: "manual_override", change: "-ai-blocked", by: "phil" });
    expect(row(deps)).toMatchObject({ deliveryId: "d-manual", event: "manual_override", fromState: LABELS.AI_BLOCKED, droppedReason: null });
    expect(JSON.parse(row(deps).toEffect)).toEqual({ kind: "manual", change: "-ai-blocked", by: "phil", now: "none" });
    expect(deps.addLabel).not.toHaveBeenCalled();
    expect(deps.removeLabel).not.toHaveBeenCalled();
    expect(deps.fireRoutine).not.toHaveBeenCalled();
  });

  it("a person adds merge-blocked by hand -> logged, from auto-merge", async () => {
    const deps = fakeDeps({ botLogin: async () => bot, getLabels: vi.fn(async () => [LABELS.AUTO_MERGING, LABELS.MERGE_BLOCKED]) });
    const result = await coordinateWebhook(deps, change("pull_request.labeled", LABELS.MERGE_BLOCKED));
    expect(result).toMatchObject({ outcome: "manual_override", change: "+merge-blocked" });
    expect(row(deps).fromState).toBe(LABELS.AUTO_MERGING);
  });

  it("a person removes auto-merge from a merge-blocked PR (contextual there, normally unlogged) -> logged", async () => {
    const deps = fakeDeps({ botLogin: async () => bot, getLabels: vi.fn(async () => [LABELS.MERGE_BLOCKED]) });
    const result = await coordinateWebhook(deps, change("pull_request.unlabeled", LABELS.AUTO_MERGING));
    expect(result).toMatchObject({ outcome: "manual_override", change: "-auto-merge" });
  });

  it("the Worker's own bot changing a label -> not an override, nothing logged", async () => {
    const deps = fakeDeps({ botLogin: async () => bot, getLabels: vi.fn(async () => []) });
    expect(await coordinateWebhook(deps, change("issues.unlabeled", LABELS.AI_BLOCKED, bot, "Bot"))).toEqual({ outcome: "no_event" });
    expect(deps.logTransition).not.toHaveBeenCalled();
  });

  it("a person adding a trigger label is a command, not an override: its own rule's row", async () => {
    const deps = fakeDeps({ botLogin: async () => bot, getLabels: vi.fn(async () => [LABELS.AI_READY]) });
    expect(await coordinateWebhook(deps, change("issues.labeled", LABELS.AI_READY))).toMatchObject({
      outcome: "applied",
      event: EVENTS.LABELLED_AI_READY,
    });
    expect(row(deps).event).toBe(EVENTS.LABELLED_AI_READY);
  });

  it("an untracked label (dependencies) -> nothing logged", async () => {
    const deps = fakeDeps({ botLogin: async () => bot });
    expect(await coordinateWebhook(deps, change("issues.labeled", "dependencies"))).toEqual({ outcome: "no_event" });
    expect(deps.logTransition).not.toHaveBeenCalled();
  });
});

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

  it("process, matching routine -> heartbeat_extended, records the step on pendingFire (which also re-schedules the alarm)", async () => {
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
    expect(deps.setPendingFire).toHaveBeenCalledWith({
      ...pending,
      lastStep: "driving CI green",
      lastStepAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
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
