import { describe, expect, it, vi } from "vitest";
import { LABELS } from "@orchestrator/graph/constants/labels";
import { EVENTS } from "@orchestrator/graph/constants/events";
import { ROUTINES } from "@orchestrator/graph/constants/routines";
import { coordinateRoutineSignal, coordinateWebhook, type Deps } from "../../src/coordinate";
import type { RoutineSignal } from "@orchestrator/graph/routines/from-routine";
import { fakeDeps, input } from "./helpers";

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

describe("coordinateRoutineSignal — outcome, blocked and ended", () => {
  const signalInput = (signal: RoutineSignal) => ({ owner: "hifi-phil", repo: "umbraco-mcp-ops", signal });
  const pending = { owner: "hifi-phil", repo: "umbraco-mcp-ops", issueNumber: 412, run: ROUTINES.ISSUE_BUILD_LOOP, firedAt: 1000, dueAt: 5000 };
  const built = { outcome: "build_succeeded", pr: 123 };
  const outcomeSignal = (outcome: unknown = built, routine: RoutineSignal["routine"] = ROUTINES.ISSUE_BUILD_LOOP): RoutineSignal => ({
    kind: "outcome",
    routine,
    issue: 412,
    outcome,
  });
  const commentWebhook = (deliveryId = "delivery-comment") =>
    input({
      deliveryId,
      payload: {
        action: "issue_comment.created",
        sender: { login: "phil", type: "User" },
        comment: {
          body: [`<!-- agent-outcome:${ROUTINES.ISSUE_BUILD_LOOP} -->`, "```json", JSON.stringify(built), "```"].join("\n"),
          author_association: "OWNER",
        },
      },
    });
  // Labels that move as the Worker writes them, so a second carrier sees the first's effect.
  function liveDeps(start: string[], overrides: Partial<Deps> = {}): Deps {
    let labels = [...start];
    return fakeDeps({
      getLabels: vi.fn(async () => [...labels]),
      addLabel: vi.fn(async (_o: string, _r: string, _n: number, l: string) => {
        if (!labels.includes(l)) labels.push(l);
      }),
      removeLabel: vi.fn(async (_o: string, _r: string, _n: number, l: string) => {
        labels = labels.filter((x) => x !== l);
      }),
      ...overrides,
    });
  }
  const dedupedRows = (deps: Deps) =>
    vi.mocked(deps.logTransition).mock.calls.filter(([row]) => row.droppedReason?.startsWith("deduped:"));

  it(`an outcome with build_succeeded -> ${LABELS.PR_OPEN}, the PR handed to review; the later comment webhook is deduped`, async () => {
    const deps = liveDeps([LABELS.AI_READY]);
    await deps.setPendingFire(pending);

    const result = await coordinateRoutineSignal(deps, signalInput(outcomeSignal()));

    expect(result).toMatchObject({ outcome: "outcome_reported", result: { outcome: "applied", event: EVENTS.BUILD_SUCCEEDED } });
    expect(deps.addLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.PR_OPEN);
    expect(deps.removeLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AI_READY);
    expect(deps.forward).toHaveBeenCalledWith(
      { owner: "hifi-phil", repo: "umbraco-mcp-ops", issueNumber: 123 },
      { action: "orchestrator.review_requested", reviewRequest: { requestedBy: 412 } },
      expect.any(String),
    );
    expect(deps.logTransition).toHaveBeenCalledWith(expect.objectContaining({ event: EVENTS.BUILD_SUCCEEDED, actor: "routine-signal", droppedReason: null }));
    expect(await deps.getPendingFire()).toBeNull();
    expect(deps.markCompleted).toHaveBeenCalledOnce();

    vi.mocked(deps.addLabel).mockClear();
    vi.mocked(deps.removeLabel).mockClear();
    vi.mocked(deps.forward).mockClear();
    const comment = await coordinateWebhook(deps, commentWebhook());

    expect(comment).toEqual({ outcome: "deduped" });
    expect(dedupedRows(deps)).toHaveLength(1);
    expect(dedupedRows(deps)[0]![0]).toMatchObject({ event: "build_succeeded", run: ROUTINES.ISSUE_BUILD_LOOP, fromState: LABELS.PR_OPEN });
    expect(deps.addLabel).not.toHaveBeenCalled();
    expect(deps.removeLabel).not.toHaveBeenCalled();
    expect(deps.forward).not.toHaveBeenCalled();
  });

  it("a rule that starts a new run keeps that run's pending fire and is not marked completed; the later comment is deduped", async () => {
    const reviewing = { ...pending, issueNumber: 123, run: ROUTINES.REVIEW_LOOP };
    const findings = { outcome: "review_findings", findings: 1 };
    const deps = liveDeps([LABELS.AI_REVIEWING]);
    await deps.setPendingFire(reviewing);

    const result = await coordinateRoutineSignal(deps, {
      owner: "hifi-phil",
      repo: "umbraco-mcp-ops",
      signal: { kind: "outcome", routine: ROUTINES.REVIEW_LOOP, issue: 123, outcome: findings },
    });

    expect(result).toMatchObject({ outcome: "outcome_reported", result: { outcome: "applied", event: EVENTS.REVIEW_FINDINGS } });
    expect(deps.fireRoutine).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 123, ROUTINES.REWORK_LOOP);
    expect(await deps.getPendingFire()).toMatchObject({ run: ROUTINES.REWORK_LOOP, issueNumber: 123 });
    expect(deps.markCompleted).not.toHaveBeenCalled();

    vi.mocked(deps.addLabel).mockClear();
    const comment = await coordinateWebhook(
      deps,
      input({
        deliveryId: "delivery-findings",
        issueNumber: 123,
        payload: {
          action: "issue_comment.created",
          sender: { login: "phil", type: "User" },
          comment: {
            body: [`<!-- agent-outcome:${ROUTINES.REVIEW_LOOP} -->`, "```json", JSON.stringify(findings), "```"].join("\n"),
            author_association: "OWNER",
          },
        },
      }),
    );
    expect(comment).toEqual({ outcome: "deduped" });
    expect(deps.addLabel).not.toHaveBeenCalled();
  });

  it("the comment first, then the outcome -> deduped, logged, nothing applied twice", async () => {
    const deps = liveDeps([LABELS.AI_READY]);
    await deps.setPendingFire(pending);

    expect(await coordinateWebhook(deps, commentWebhook())).toMatchObject({ outcome: "applied", event: EVENTS.BUILD_SUCCEEDED });
    expect(deps.forward).toHaveBeenCalledOnce();
    vi.mocked(deps.addLabel).mockClear();

    const result = await coordinateRoutineSignal(deps, signalInput(outcomeSignal()));

    expect(result).toEqual({ outcome: "deduped" });
    expect(dedupedRows(deps)).toHaveLength(1);
    expect(dedupedRows(deps)[0]![0]).toMatchObject({ actor: "routine-signal", event: "build_succeeded" });
    expect(deps.addLabel).not.toHaveBeenCalled();
    expect(deps.forward).toHaveBeenCalledOnce();
  });

  it("a new fire of the routine forgets the applied outcome: that run's own outcome applies", async () => {
    const deps = liveDeps([LABELS.AI_READY]);
    await deps.setPendingFire(pending);
    await coordinateRoutineSignal(deps, signalInput(outcomeSignal()));
    expect(await deps.getAppliedOutcome()).toEqual({ run: ROUTINES.ISSUE_BUILD_LOOP, firedAt: 1000, outcome: "build_succeeded" });

    // A person sends it back to build: LABELS.AI_READY again, a new fire.
    vi.mocked(deps.getLabels).mockResolvedValue([LABELS.AI_READY]);
    await coordinateWebhook(deps, input({ deliveryId: "relabel", payload: { action: "issues.labeled", label: { name: LABELS.AI_READY }, sender: { login: "phil", type: "User" } } }));
    expect(deps.fireRoutine).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, ROUTINES.ISSUE_BUILD_LOOP);
    expect(await deps.getAppliedOutcome()).toBeNull();
  });

  it("an invalid outcome -> invalid_signal, logged, nothing applied", async () => {
    const deps = liveDeps([LABELS.AI_READY]);
    await deps.setPendingFire(pending);

    const result = await coordinateRoutineSignal(deps, signalInput(outcomeSignal({ outcome: "build_succeeded" })));

    expect(result).toEqual({ outcome: "invalid_signal" });
    expect(deps.logTransition).toHaveBeenCalledOnce();
    expect(deps.logTransition).toHaveBeenCalledWith(
      expect.objectContaining({ event: "outcome_invalid", actor: "routine-signal", droppedReason: expect.stringContaining("failed validation") }),
    );
    expect(deps.addLabel).not.toHaveBeenCalled();
    expect(deps.removeLabel).not.toHaveBeenCalled();
    expect(await deps.getPendingFire()).toEqual(pending); // the watchdog still decides
  });

  it("a wrong routine -> mismatched_routine, refused and logged, nothing applied", async () => {
    const deps = liveDeps([LABELS.AI_READY]);
    await deps.setPendingFire(pending);

    const result = await coordinateRoutineSignal(deps, signalInput(outcomeSignal({ outcome: "review_passed" }, ROUTINES.REVIEW_LOOP)));

    expect(result).toEqual({ outcome: "mismatched_routine", expected: ROUTINES.ISSUE_BUILD_LOOP, got: ROUTINES.REVIEW_LOOP });
    expect(deps.logTransition).toHaveBeenCalledOnce();
    expect(deps.logTransition).toHaveBeenCalledWith(
      expect.objectContaining({ event: "review_passed", run: ROUTINES.REVIEW_LOOP, droppedReason: expect.stringContaining("refused") }),
    );
    expect(deps.addLabel).not.toHaveBeenCalled();
    expect(deps.removeLabel).not.toHaveBeenCalled();
    expect(await deps.getPendingFire()).toEqual(pending);
  });

  it("no pending fire -> no_pending_fire, refused and logged, nothing applied", async () => {
    const deps = liveDeps([LABELS.AI_READY]);

    const result = await coordinateRoutineSignal(deps, signalInput(outcomeSignal()));

    expect(result).toEqual({ outcome: "no_pending_fire" });
    expect(deps.logTransition).toHaveBeenCalledWith(expect.objectContaining({ droppedReason: "outcome signal refused: no pending fire" }));
    expect(deps.addLabel).not.toHaveBeenCalled();
  });

  it("an outcome with no rule from the current labels -> not applied, the watchdog stays armed", async () => {
    const deps = liveDeps([LABELS.AUTO_MERGING]);
    await deps.setPendingFire(pending);

    const result = await coordinateRoutineSignal(deps, signalInput(outcomeSignal()));

    expect(result).toMatchObject({ outcome: "outcome_reported", result: { outcome: "dropped_no_rule" } });
    expect(await deps.getPendingFire()).toEqual(pending);
    expect(await deps.getAppliedOutcome()).toBeNull();
  });

  it("blocked twice -> one comment, the step recorded, no label change", async () => {
    const deps = liveDeps([LABELS.AI_READY]);
    await deps.setPendingFire(pending);
    const blocked: RoutineSignal = { kind: "blocked", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412, detail: "Bash(npm publish)" };

    expect(await coordinateRoutineSignal(deps, signalInput(blocked))).toEqual({ outcome: "blocked_noted" });
    expect(await coordinateRoutineSignal(deps, signalInput(blocked))).toEqual({ outcome: "blocked_already_noted" });

    expect(deps.commentOnIssue).toHaveBeenCalledOnce();
    expect(deps.commentOnIssue).toHaveBeenCalledWith(
      "hifi-phil",
      "umbraco-mcp-ops",
      412,
      expect.stringContaining("`issue-build-loop` is waiting for a permission it can't get unattended: `Bash(npm publish)`"),
    );
    expect(deps.recordStatus).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "step", step: "blocked: Bash(npm publish)" }));
    expect(await deps.getPendingFire()).toMatchObject({ ...pending, lastStep: "blocked: Bash(npm publish)", blocked: true });
    expect(deps.addLabel).not.toHaveBeenCalled();
    expect(deps.removeLabel).not.toHaveBeenCalled();
  });

  it(`ended -> one comment naming the detail, then ${LABELS.AI_STUCK}, the pending fire cleared`, async () => {
    const deps = liveDeps([LABELS.AI_READY]);
    await deps.setPendingFire(pending);

    const result = await coordinateRoutineSignal(
      deps,
      signalInput({ kind: "ended", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412, detail: "session stopped: max turns" }),
    );

    expect(result).toMatchObject({ outcome: "ended_expired", result: { outcome: "applied", event: EVENTS.WATCHDOG_EXPIRED } });
    expect(deps.commentOnIssue).toHaveBeenCalledOnce();
    expect(deps.commentOnIssue).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, expect.stringContaining("`session stopped: max turns`"));
    expect(deps.addLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AI_STUCK);
    expect(deps.logTransition).toHaveBeenCalledWith(expect.objectContaining({ event: EVENTS.WATCHDOG_EXPIRED, actor: "routine-signal" }));
    expect(await deps.getPendingFire()).toBeNull();
    // Sent again, it finds nothing running.
    const again = await coordinateRoutineSignal(
      deps,
      signalInput({ kind: "ended", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412, detail: "session stopped: max turns" }),
    );
    expect(again).toEqual({ outcome: "no_pending_fire" });
    expect(deps.commentOnIssue).toHaveBeenCalledOnce();
  });

  it("a completion still only cancels the watchdog: nothing applied, no label, no row, no hand-off", async () => {
    const deps = liveDeps([LABELS.AI_READY]);
    await deps.setPendingFire(pending);

    const result = await coordinateRoutineSignal(deps, signalInput({ kind: "completion", routine: ROUTINES.ISSUE_BUILD_LOOP, issue: 412, outcome: built }));

    expect(result).toEqual({ outcome: "completion_acknowledged" });
    expect(await deps.getPendingFire()).toBeNull();
    expect(deps.addLabel).not.toHaveBeenCalled();
    expect(deps.removeLabel).not.toHaveBeenCalled();
    expect(deps.logTransition).not.toHaveBeenCalled();
    expect(deps.forward).not.toHaveBeenCalled();
    expect(await deps.getAppliedOutcome()).toBeNull();
    // The comment that follows is the real transition, not a duplicate.
    expect(await coordinateWebhook(deps, commentWebhook())).toMatchObject({ outcome: "applied", event: EVENTS.BUILD_SUCCEEDED });
  });
});
