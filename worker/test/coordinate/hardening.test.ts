// Phase 9, hardening against loops and loss: review rework rounds are
// capped, and a fire's watchdog is armed before the fire.
import { describe, expect, it, vi } from "vitest";
import { LABELS } from "@orchestrator/graph/constants/labels";
import { EVENTS } from "@orchestrator/graph/constants/events";
import { ROUTINES } from "@orchestrator/graph/constants/routines";
import { MAX_REVIEW_REWORKS, coordinateReconcile, coordinateWebhook } from "../../src/coordinate";
import { fakeDeps, input } from "./helpers";

const reworkLabel = (deliveryId: string) =>
  input({ deliveryId, payload: { action: "pull_request.labeled", label: { name: LABELS.AUTO_REWORKING }, sender: { login: "reviewer", type: "User" } } });

describe("review rework rounds are capped (MAX_REVIEW_REWORKS)", () => {
  it("each round up to the cap fires rework-loop and counts", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AUTO_REWORKING]) });
    for (let i = 1; i <= MAX_REVIEW_REWORKS; i++) {
      expect(await coordinateWebhook(deps, reworkLabel(`d-${i}`))).toMatchObject({ outcome: "applied", event: EVENTS.LABELLED_AUTO_REWORKING });
    }
    expect(deps.fireRoutine).toHaveBeenCalledTimes(MAX_REVIEW_REWORKS);
    expect(await deps.getReviewReworks()).toBe(MAX_REVIEW_REWORKS);
  });

  it("one more: ai-stuck instead, nothing fired, and a comment saying why and how to retry", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AUTO_REWORKING]), getReviewReworks: vi.fn(async () => MAX_REVIEW_REWORKS) });
    const result = await coordinateWebhook(deps, reworkLabel("d-over"));
    expect(result).toMatchObject({ outcome: "applied", event: EVENTS.REWORK_CAP_REACHED });
    expect(deps.fireRoutine).not.toHaveBeenCalled();
    expect(deps.removeLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AUTO_REWORKING);
    expect(deps.addLabel).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, LABELS.AI_STUCK);
    expect(deps.commentOnIssue).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, expect.stringMatching(/3 review rework rounds.*ai-stuck.*fresh count/));
    expect(deps.logTransition).toHaveBeenCalledWith(expect.objectContaining({ event: EVENTS.REWORK_CAP_REACHED, actor: "reviewer" }));
  });

  it("a person retrying from ai-stuck starts a fresh count, and it fires", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_STUCK, LABELS.AUTO_REWORKING]), getReviewReworks: vi.fn(async () => MAX_REVIEW_REWORKS) });
    expect(await coordinateWebhook(deps, reworkLabel("d-retry"))).toMatchObject({ outcome: "applied", event: EVENTS.LABELLED_AUTO_REWORKING });
    expect(deps.fireRoutine).toHaveBeenCalledWith("hifi-phil", "umbraco-mcp-ops", 412, ROUTINES.REWORK_LOOP);
    expect(deps.setReviewReworks).toHaveBeenCalledWith(1);
  });

  it("CI-fix reworks (the Worker's own, no label event) don't count as review rounds", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AUTO_MERGING]) });
    await coordinateWebhook(deps, input({ payload: { action: "pull_request.synchronize" } }));
    expect(deps.setReviewReworks).not.toHaveBeenCalled();
  });
});

describe("a fire's watchdog is armed before the fire", () => {
  const order = (deps: ReturnType<typeof fakeDeps>) => ({
    armed: vi.mocked(deps.setPendingFire).mock.invocationCallOrder[0]!,
    fired: vi.mocked(deps.fireRoutine).mock.invocationCallOrder[0]!,
  });
  const readyLabel = input({ payload: { action: "issues.labeled", label: { name: LABELS.AI_READY } } });

  it("webhook path: armed, then fired (a crash between leaves the watchdog to notice)", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]) });
    await coordinateWebhook(deps, readyLabel);
    const { armed, fired } = order(deps);
    expect(armed).toBeLessThan(fired);
  });

  it("webhook path: a refused fire disarms (nothing's running; the sweep picks it up) and fails the delivery", async () => {
    const deps = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_READY]), fireRoutine: vi.fn(async () => Promise.reject(new Error("fire refused"))) });
    await expect(coordinateWebhook(deps, readyLabel)).rejects.toThrow("fire refused");
    expect(await deps.getPendingFire()).toBeNull();
  });

  it("the sweep's re-fire: armed, then fired; a refused one disarms", async () => {
    const ref = { owner: "hifi-phil", repo: "umbraco-mcp-ops", issueNumber: 412 };
    const opts = { enforced: true, now: Date.parse("2026-10-04T12:00:00Z") };
    const left = { getLabels: vi.fn(async () => [LABELS.AI_READY]), lastActivityAt: async () => "2026-10-04 08:00:00" };
    const deps = fakeDeps(left);
    await coordinateReconcile(deps, ref, opts);
    const { armed, fired } = order(deps);
    expect(armed).toBeLessThan(fired);

    const refused = fakeDeps({ ...left, fireRoutine: vi.fn(async () => Promise.reject(new Error("fire refused"))) });
    await expect(coordinateReconcile(refused, ref, opts)).rejects.toThrow("fire refused");
    expect(await refused.getPendingFire()).toBeNull();
  });
});
