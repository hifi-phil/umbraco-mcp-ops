import { describe, expect, it, vi } from "vitest";
import { ROUTINES } from "@orchestrator/graph/constants/routines";
import { coordinateRoutineSignal } from "../../src/coordinate";
import type { RoutineSignal } from "@orchestrator/graph/routines/from-routine";
import { LABELS } from "@orchestrator/graph/constants/labels";
import { EVENTS } from "@orchestrator/graph/constants/events";
import { coordinateWebhook } from "../../src/coordinate";
import { fakeDeps, input } from "./helpers";

describe("coordinateRoutineSignal — the direct routine-to-DO channel", () => {
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

  it("completion with an unrecognized outcome shape -> invalid_signal, logged, nothing applied or cleared", async () => {
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
    expect(deps.addLabel).not.toHaveBeenCalled();
    expect(deps.logTransition).toHaveBeenCalledOnce();
    expect(deps.logTransition).toHaveBeenCalledWith(
      expect.objectContaining({ event: "completion_invalid", actor: "routine-signal", issueNumber: 412, run: ROUTINES.ISSUE_BUILD_LOOP, droppedReason: expect.stringContaining("not_a_real_outcome") }),
    );
  });

  it("a signal while a fire is deferred (an earlier run of the same routine) -> no_pending_fire: it neither clears nor extends the deferred fire", async () => {
    const deps = fakeDeps();
    const pending = { owner: "hifi-phil", repo: "umbraco-mcp-ops", issueNumber: 412, run: ROUTINES.ISSUE_BUILD_LOOP, deferUntil: 5000 };
    await deps.setPendingFire(pending);
    vi.mocked(deps.setPendingFire).mockClear();
    const completion = await coordinateRoutineSignal(deps, signalInput({ kind: "completion", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412, outcome: { outcome: "build_succeeded", pr: 123 } }));
    const heartbeat = await coordinateRoutineSignal(deps, signalInput({ kind: "process", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412, step: "merging" }));
    expect(completion).toEqual({ outcome: "no_pending_fire" });
    expect(heartbeat).toEqual({ outcome: "no_pending_fire" });
    expect(deps.clearPendingFire).not.toHaveBeenCalled();
    expect(deps.setPendingFire).not.toHaveBeenCalled();
    expect(await deps.getPendingFire()).toEqual(pending);
  });
});

// An issue with live labels: the Worker's own writes move them.
function liveDeps(labels: string[], overrides: Parameters<typeof fakeDeps>[0] = {}) {
  const now = [...labels];
  return fakeDeps({
    getLabels: vi.fn(async () => [...now]),
    addLabel: vi.fn(async (_o: string, _r: string, _n: number, label: string) => {
      if (!now.includes(label)) now.push(label);
    }),
    removeLabel: vi.fn(async (_o: string, _r: string, _n: number, label: string) => {
      const i = now.indexOf(label);
      if (i >= 0) now.splice(i, 1);
    }),
    ...overrides,
  });
}

const ref = { owner: "hifi-phil", repo: "umbraco-mcp-ops" };
const buildFire = { ...ref, issueNumber: 412, run: ROUTINES.ISSUE_BUILD_LOOP, firedAt: 1_000 };
const succeeded = { outcome: "build_succeeded", pr: 123 } as const;
const fence = "`".repeat(3);
const outcomeBody = `<!-- agent-outcome:${ROUTINES.ISSUE_BUILD_LOOP} -->\n${fence}json\n${JSON.stringify(succeeded)}\n${fence}`;
const completion = (outcome: unknown = succeeded): RoutineSignal => ({ kind: "completion", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412, outcome });
const outcomeWebhook = (deliveryId = "comment-delivery") =>
  input({
    deliveryId,
    payload: {
      action: "issue_comment.created",
      sender: { login: "maintainer", type: "User" },
      comment: { body: outcomeBody, author_association: "OWNER", user_type: "User" },
      issue: { state: "open", is_pr: false },
    },
  });

describe("coordinateRoutineSignal — a completion is applied, like its comment", () => {
  it(`build_succeeded: ${LABELS.AI_READY} -> ${LABELS.PR_OPEN}, the PR handed to review, a row by routine-signal; the later comment is deduped`, async () => {
    const deps = liveDeps([LABELS.AI_READY]);
    await deps.setPendingFire(buildFire);

    const result = await coordinateRoutineSignal(deps, { ...ref, signal: completion() });

    expect(result).toMatchObject({ outcome: "completion_acknowledged", result: { outcome: "applied", event: EVENTS.BUILD_SUCCEEDED } });
    expect(await deps.getLabels("hifi-phil", "umbraco-mcp-ops", 412)).toEqual([LABELS.PR_OPEN]);
    expect(deps.forward).toHaveBeenCalledWith(
      { owner: "hifi-phil", repo: "umbraco-mcp-ops", issueNumber: 123 },
      { action: "orchestrator.review_requested", reviewRequest: { requestedBy: 412 } },
      expect.any(String),
    );
    expect(deps.logTransition).toHaveBeenCalledWith(
      expect.objectContaining({ event: EVENTS.BUILD_SUCCEEDED, actor: "routine-signal", droppedReason: null }),
    );
    expect(await deps.getPendingFire()).toBeNull();

    vi.mocked(deps.logTransition).mockClear();
    vi.mocked(deps.forward).mockClear();
    const comment = await coordinateWebhook(deps, outcomeWebhook());
    expect(comment).toEqual({ outcome: "deduped" });
    expect(deps.forward).not.toHaveBeenCalled();
    expect(deps.logTransition).toHaveBeenCalledOnce();
    expect(deps.logTransition).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: "comment-delivery", event: "build_succeeded", droppedReason: expect.stringMatching(/^deduped:/) }),
    );
  });

  it("the comment first, then the completion -> deduped, logged, nothing applied twice", async () => {
    const deps = liveDeps([LABELS.AI_READY]);
    await deps.setPendingFire(buildFire);

    expect(await coordinateWebhook(deps, outcomeWebhook())).toMatchObject({ outcome: "applied", event: EVENTS.BUILD_SUCCEEDED });
    vi.mocked(deps.logTransition).mockClear();
    vi.mocked(deps.forward).mockClear();
    vi.mocked(deps.addLabel).mockClear();

    expect(await coordinateRoutineSignal(deps, { ...ref, signal: completion() })).toEqual({ outcome: "deduped" });
    expect(deps.addLabel).not.toHaveBeenCalled();
    expect(deps.forward).not.toHaveBeenCalled();
    expect(deps.logTransition).toHaveBeenCalledOnce();
    expect(deps.logTransition).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "routine-signal", event: "build_succeeded", droppedReason: expect.stringMatching(/^deduped:/) }),
    );
  });

  it("a newer fire of the same routine is not deduped by the last one's outcome", async () => {
    const deps = liveDeps([LABELS.AI_READY]);
    await deps.setPendingFire(buildFire);
    await coordinateRoutineSignal(deps, { ...ref, signal: completion() });
    // A person sends it round again: a new fire, and its own outcome.
    await deps.setPendingFire({ ...buildFire, firedAt: 2_000 });
    expect(await coordinateWebhook(deps, outcomeWebhook("second-comment"))).toMatchObject({ outcome: "applied" });
  });

  it("an invalid completion changes nothing: the valid comment still applies", async () => {
    const deps = liveDeps([LABELS.AI_READY]);
    await deps.setPendingFire(buildFire);
    expect(await coordinateRoutineSignal(deps, { ...ref, signal: completion({ outcome: "build_succeeded" }) })).toEqual({ outcome: "invalid_signal" });
    expect(deps.addLabel).not.toHaveBeenCalled();
    expect(await deps.getPendingFire()).toEqual(buildFire);
    expect(await coordinateWebhook(deps, outcomeWebhook())).toMatchObject({ outcome: "applied", event: EVENTS.BUILD_SUCCEEDED });
  });

  it("a completion the rules drop still ends the watch (the old fast path), marked completed", async () => {
    const deps = liveDeps([LABELS.AI_DISCUSSING]);
    await deps.setPendingFire(buildFire);
    const result = await coordinateRoutineSignal(deps, { ...ref, signal: completion() });
    expect(result).toMatchObject({ outcome: "completion_acknowledged", result: { outcome: "dropped_no_rule" } });
    expect(await deps.getPendingFire()).toBeNull();
    expect(deps.markCompleted).toHaveBeenCalledOnce();
  });
});

describe("coordinateRoutineSignal — blocked", () => {
  const blocked: RoutineSignal = { kind: "blocked", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412, detail: "Bash: npm publish" };

  it("one comment naming the permission, the step recorded, no label change, the watchdog untouched; a second is quiet", async () => {
    const deps = liveDeps([LABELS.AI_READY]);
    await deps.setPendingFire(buildFire);
    vi.mocked(deps.setPendingFire).mockClear();

    expect(await coordinateRoutineSignal(deps, { ...ref, signal: blocked })).toEqual({ outcome: "blocked_noted" });
    expect(deps.commentOnIssue).toHaveBeenCalledOnce();
    expect(deps.commentOnIssue).toHaveBeenCalledWith(
      "hifi-phil",
      "umbraco-mcp-ops",
      412,
      expect.stringContaining("`issue-build-loop` is waiting for a permission it can't get unattended: `Bash: npm publish`. Approve it in the session, or add an allow rule."),
    );
    expect(deps.recordStatus).toHaveBeenCalledWith(expect.objectContaining({ issueNumber: 412 }), {
      kind: "step",
      step: "blocked: Bash: npm publish",
      at: expect.any(String),
    });
    expect(deps.logTransition).toHaveBeenCalledWith(expect.objectContaining({ event: "routine_blocked", actor: "routine-signal" }));
    expect(deps.addLabel).not.toHaveBeenCalled();
    expect(deps.removeLabel).not.toHaveBeenCalled();
    expect(deps.setPendingFire).not.toHaveBeenCalled();
    expect(deps.clearPendingFire).not.toHaveBeenCalled();

    expect(await coordinateRoutineSignal(deps, { ...ref, signal: blocked })).toEqual({ outcome: "blocked_already_noted" });
    expect(deps.commentOnIssue).toHaveBeenCalledOnce();
  });

  it("a new fire may say it again", async () => {
    const deps = liveDeps([LABELS.AI_READY]);
    await deps.setPendingFire(buildFire);
    await coordinateRoutineSignal(deps, { ...ref, signal: blocked });
    await deps.setPendingFire({ ...buildFire, firedAt: 2_000 });
    expect(await coordinateRoutineSignal(deps, { ...ref, signal: blocked })).toEqual({ outcome: "blocked_noted" });
    expect(deps.commentOnIssue).toHaveBeenCalledTimes(2);
  });
});

describe("coordinateRoutineSignal — ended", () => {
  const ended: RoutineSignal = { kind: "ended", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412, detail: "max turns reached" };

  it(`one comment naming the detail, then ${LABELS.AI_STUCK} as on expiry, the pending fire cleared`, async () => {
    const deps = liveDeps([LABELS.AI_READY]);
    await deps.setPendingFire(buildFire);

    const result = await coordinateRoutineSignal(deps, { ...ref, signal: ended });

    expect(result).toMatchObject({ outcome: "ended_expired", result: { outcome: "applied", event: EVENTS.WATCHDOG_EXPIRED } });
    expect(deps.commentOnIssue).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.commentOnIssue).mock.calls[0]![3]).toContain("`max turns reached`");
    expect(vi.mocked(deps.commentOnIssue).mock.calls[0]![3]).toContain(`Moving this to \`${LABELS.AI_STUCK}\``);
    expect(await deps.getLabels("hifi-phil", "umbraco-mcp-ops", 412)).toEqual([LABELS.AI_STUCK]);
    expect(deps.logTransition).toHaveBeenCalledWith(
      expect.objectContaining({ event: EVENTS.WATCHDOG_EXPIRED, actor: "routine-signal", deliveryId: null }),
    );
    expect(await deps.getPendingFire()).toBeNull();

    // Said once: the fire is over, so a second finds nothing pending.
    expect(await coordinateRoutineSignal(deps, { ...ref, signal: ended })).toEqual({ outcome: "no_pending_fire" });
    expect(deps.commentOnIssue).toHaveBeenCalledOnce();
  });
});
