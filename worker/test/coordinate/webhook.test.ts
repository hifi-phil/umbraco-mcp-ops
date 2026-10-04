import { describe, expect, it, vi } from "vitest";
import { LABELS } from "@orchestrator/graph/constants/labels";
import { EVENTS } from "@orchestrator/graph/constants/events";
import { ROUTINES } from "@orchestrator/graph/constants/routines";
import {
  coordinateWebhook,
  coordinateWatchdogExpired,
  deriveState,
  resolveEnforced,
  watchdogMinutesFor,
  type Deps,
} from "../../src/coordinate";
import { fakeDeps, input } from "./helpers";

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
    // pr-open added while the issue is in ai-discussing: build_succeeded
    // has no rule from there, and it isn't a contextual event, so it's a gap.
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_DISCUSSING]) });
    const result = await coordinateWebhook(
      deps,
      input({ payload: { action: "issues.labeled", label: { name: LABELS.PR_OPEN }, sender: { login: "phil", type: "User" } } }),
    );
    expect(result).toEqual({ outcome: "dropped_no_rule", from: LABELS.AI_DISCUSSING, event: EVENTS.BUILD_SUCCEEDED });
    expect(deps.logTransition).toHaveBeenCalledWith(
      expect.objectContaining({ droppedReason: "no matching rule for this (state, event) pair" }),
    );
  });

  it("a contextual event outside its states (a merge with no auto-merging, a push with no auto-reworking) -> ignored, not logged", async () => {
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
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.PR_OPEN]) });
    await deps.setPendingFire({ owner: "hifi-phil", repo: "umbraco-mcp-ops", issueNumber: 412, run: ROUTINES.ISSUE_BUILD_LOOP });
    const result = await coordinateWebhook(
      deps,
      input({ payload: { action: "issues.labeled", label: { name: LABELS.PR_OPEN }, sender: { login: "phil", type: "User" } } }),
    );
    expect(result).toMatchObject({ outcome: "applied", from: LABELS.PR_OPEN, event: EVENTS.BUILD_SUCCEEDED });
    expect(await deps.getPendingFire()).toBeNull();
    expect(deps.addLabel).not.toHaveBeenCalled();
    expect(deps.removeLabel).not.toHaveBeenCalled();
  });

  it("the release loop removing auto-releasing (blocked, no outcome comment) clears the watchdog", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => []) });
    await deps.setPendingFire({ owner: "hifi-phil", repo: "umbraco-mcp-ops", issueNumber: 412, run: ROUTINES.AUTO_RELEASE_LOOP });
    const result = await coordinateWebhook(
      deps,
      input({ payload: { action: "issues.unlabeled", label: { name: LABELS.AUTO_RELEASING }, sender: { login: "phil", type: "User" } } }),
    );
    expect(result).toMatchObject({ outcome: "applied", from: "none", event: EVENTS.UNLABELLED_AUTO_RELEASING });
    expect(await deps.getPendingFire()).toBeNull();
  });

  it("a discussion reply on an ai-discussing issue fires issue-discuss-loop, unwatched", async () => {
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

  it("the same comment on an issue that isn't in ai-discussing -> ignored, not logged", async () => {
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
    expect(deps.fireRoutine).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, ROUTINES.ISSUE_BUILD_LOOP);
    expect(deps.setPendingFire).toHaveBeenCalledWith({
      owner: "hifi-phil",
      repo: "umbraco-mcp-ops",
      issueNumber: 412,
      run: ROUTINES.ISSUE_BUILD_LOOP,
    });
    expect(deps.clearPendingFire).not.toHaveBeenCalled();
  });

  it("build_succeeded outcome artifact, realistic ordering (issue-build-loop's own Step 3 already swapped ai-ready -> pr-open before commenting): applied as a noop confirm, no GitHub write, clears pendingFire", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.PR_OPEN]) });
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

  it("Phase 5: build_succeeded marker while ai-ready is still on -> the Worker does the swap itself", async () => {
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
    expect(deps.addLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.PR_OPEN);
    expect(deps.fireRoutine).not.toHaveBeenCalled();
    expect(await deps.getPendingFire()).toBeNull(); // the outcome ends the watch
  });

  it("Phase 5: release_blocked marker while auto-releasing is still on -> the Worker removes it", async () => {
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

describe("coordinateWebhook — leaving ai-stuck", () => {
  const outcomeComment = (outcome: Record<string, unknown>) =>
    [`<!-- agent-outcome:${ROUTINES.ISSUE_BUILD_LOOP} -->`, "```json", JSON.stringify(outcome), "```"].join("\n");

  it("a late build_succeeded after the routine's own swap landed (ai-stuck + pr-open): read as ai-stuck, only ai-stuck removed", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_STUCK, LABELS.PR_OPEN]) });
    const result = await coordinateWebhook(
      deps,
      input({ payload: { action: "issue_comment.created", comment: { body: outcomeComment({ outcome: "build_succeeded", pr: 123 }) } } }),
    );
    expect(result).toMatchObject({ outcome: "applied", from: LABELS.AI_STUCK, event: EVENTS.BUILD_SUCCEEDED });
    expect(deps.removeLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AI_STUCK);
    expect(deps.addLabel).not.toHaveBeenCalled(); // pr-open already there
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

  it("a human retry — re-adding ai-ready on a stuck issue: removes ai-stuck, re-fires issue-build-loop, re-arms the watchdog", async () => {
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
    expect(deriveState([LABELS.AI_STUCK, LABELS.PR_OPEN, LABELS.AUTO_MERGING])).toBe("ambiguous");
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

  it("a person adds merge-blocked by hand -> logged, from auto-merging", async () => {
    const deps = fakeDeps({ botLogin: async () => bot, getLabels: vi.fn(async () => [LABELS.AUTO_MERGING, LABELS.MERGE_BLOCKED]) });
    const result = await coordinateWebhook(deps, change("pull_request.labeled", LABELS.MERGE_BLOCKED));
    expect(result).toMatchObject({ outcome: "manual_override", change: "+merge-blocked" });
    expect(row(deps).fromState).toBe(LABELS.AUTO_MERGING);
  });

  it("a person removes auto-merging from a merge-blocked PR (contextual there, normally unlogged) -> logged", async () => {
    const deps = fakeDeps({ botLogin: async () => bot, getLabels: vi.fn(async () => [LABELS.MERGE_BLOCKED]) });
    const result = await coordinateWebhook(deps, change("pull_request.unlabeled", LABELS.AUTO_MERGING));
    expect(result).toMatchObject({ outcome: "manual_override", change: "-auto-merging" });
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
