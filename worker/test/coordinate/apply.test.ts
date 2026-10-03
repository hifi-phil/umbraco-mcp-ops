import { describe,expect,it,vi } from "vitest";
import { LABELS } from "../../../graph/constants/labels";
import { EVENTS } from "../../../graph/constants/events";
import { ROUTINES } from "../../../graph/constants/routines";
import {
coordinateWebhook,
coordinateReconcile,
coordinateRoutineSignal,
coordinateWatchdogExpired
} from "../../src/coordinate";
import { fakeDeps,gateFacts,input } from "./helpers";

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
