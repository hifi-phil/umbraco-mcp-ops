// The Worker applies every lane label: build_succeeded hands its PR the review
// label, and rework_no_change, merge_blocked and discussion_capped replace the
// last label writes a session made itself.
import { describe, expect, it, vi } from "vitest";
import { LABELS } from "@orchestrator/graph/constants/labels";
import { EVENTS } from "@orchestrator/graph/constants/events";
import { ROUTINES } from "@orchestrator/graph/constants/routines";
import { coordinateWebhook, type Deps } from "../../src/coordinate";
import { fakeDeps, gateFacts, input } from "./helpers";

const OWNER = "hifi-phil";
const REPO = "umbraco-mcp-ops";
const ISSUE = 364;
const PR = 412;

const outcomeComment = (issueNumber: number, routine: string, json: Record<string, unknown>, association = "OWNER", deliveryId = "d-outcome") =>
  input({
    deliveryId,
    issueNumber,
    payload: {
      action: "issue_comment.created",
      comment: { author_association: association, body: `Done.\n\n<!-- agent-outcome:${routine} -->\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\`` },
    },
  });
const deps = (labels: string[], overrides: Partial<Deps> = {}) => fakeDeps({ getLabels: vi.fn(async () => labels), ...overrides });

describe("build_succeeded hands its PR the review", () => {
  const built = (association = "OWNER") => outcomeComment(ISSUE, ROUTINES.ISSUE_BUILD_LOOP, { outcome: "build_succeeded", pr: PR }, association);

  it("the issue moves on and the PR is handed a review request, under its own delivery id", async () => {
    const d = deps([LABELS.AI_READY]);
    expect(await coordinateWebhook(d, built())).toMatchObject({ outcome: "applied", event: EVENTS.BUILD_SUCCEEDED });
    expect(d.addLabel).toHaveBeenCalledWith(OWNER, REPO, ISSUE, LABELS.PR_OPEN);
    expect(d.forward).toHaveBeenCalledWith(
      { owner: OWNER, repo: REPO, issueNumber: PR },
      { action: "orchestrator.review_requested", reviewRequest: { requestedBy: ISSUE } },
      `d-outcome:#${PR}`,
    );
  });

  it("an untrusted commenter's report hands nothing on", async () => {
    const d = deps([LABELS.AI_READY]);
    await coordinateWebhook(d, built("NONE"));
    expect(d.forward).not.toHaveBeenCalled();
  });

  it("an issue the outcome doesn't apply to hands nothing on", async () => {
    const d = deps([LABELS.AUTO_RELEASING]);
    await coordinateWebhook(d, built());
    expect(d.forward).not.toHaveBeenCalled();
  });

  it("a PR naming itself is not handed on", async () => {
    const d = deps([LABELS.AI_READY]);
    await coordinateWebhook(d, outcomeComment(PR, ROUTINES.ISSUE_BUILD_LOOP, { outcome: "build_succeeded", pr: PR }));
    expect(d.forward).not.toHaveBeenCalled();
  });
});

describe("the PR's side of the hand-off", () => {
  const request = input({
    deliveryId: `d-outcome:#${PR}`,
    issueNumber: PR,
    payload: { action: "orchestrator.review_requested", reviewRequest: { requestedBy: ISSUE } },
  });
  const green = gateFacts({ checkRuns: [{ status: "completed", conclusion: "success", name: "test" }] });

  it("adds the review label and gates it as a person's would: CI green fires review-loop", async () => {
    const d = deps([], { getMergeGateFacts: vi.fn(async () => green) });
    expect(await coordinateWebhook(d, request)).toMatchObject({ outcome: "applied", event: EVENTS.REVIEW_CI_PASSED });
    expect(d.addLabel).toHaveBeenCalledWith(OWNER, REPO, PR, LABELS.AI_REVIEWING);
    expect(d.fireRoutine).toHaveBeenCalledWith(OWNER, REPO, PR, ROUTINES.REVIEW_LOOP);
  });

  it("CI still running: labelled, nothing fired yet", async () => {
    const running = gateFacts({ checkRuns: [{ status: "in_progress", conclusion: null, name: "test" }] });
    const d = deps([], { getMergeGateFacts: vi.fn(async () => running) });
    expect(await coordinateWebhook(d, request)).toMatchObject({ outcome: "applied", event: EVENTS.LABELLED_AI_REVIEWING });
    expect(d.addLabel).toHaveBeenCalledWith(OWNER, REPO, PR, LABELS.AI_REVIEWING);
    expect(d.fireRoutine).not.toHaveBeenCalled();
  });

  it("a PR that already has the label isn't changed", async () => {
    const d = deps([LABELS.AI_REVIEWING], { getMergeGateFacts: vi.fn(async () => green) });
    expect(await coordinateWebhook(d, request)).toMatchObject({ outcome: "stale_label" });
    expect(d.addLabel).not.toHaveBeenCalled();
    expect(d.fireRoutine).not.toHaveBeenCalled();
  });

  it("a PR in a state with no review rule is left alone, and the drop is logged", async () => {
    const d = deps([LABELS.AUTO_MERGING]);
    expect(await coordinateWebhook(d, request)).toMatchObject({ outcome: "dropped_no_rule" });
    expect(d.addLabel).not.toHaveBeenCalled();
    expect(d.logTransition).toHaveBeenCalledWith(expect.objectContaining({ event: EVENTS.LABELLED_AI_REVIEWING, droppedReason: expect.stringMatching(/no matching rule/) }));
  });
});

describe("rework_no_change", () => {
  const none = (association = "OWNER") => outcomeComment(PR, ROUTINES.REWORK_LOOP, { outcome: "rework_no_change", reason: "nothing to push" }, association);

  it(`takes ${LABELS.AUTO_REWORKING} off, with a log row`, async () => {
    const d = deps([LABELS.AUTO_REWORKING]);
    expect(await coordinateWebhook(d, none())).toMatchObject({ outcome: "applied", event: EVENTS.REWORK_NO_CHANGE });
    expect(d.removeLabel).toHaveBeenCalledWith(OWNER, REPO, PR, LABELS.AUTO_REWORKING);
    expect(d.logTransition).toHaveBeenCalledWith(expect.objectContaining({ event: EVENTS.REWORK_NO_CHANGE, fromState: LABELS.AUTO_REWORKING, droppedReason: null }));
  });

  it("ends a pending CI fix, as the label coming off does", async () => {
    const d = deps([LABELS.AUTO_REWORKING]);
    await d.setCiFix({ attempts: 1, pending: true });
    await coordinateWebhook(d, none());
    expect(await d.getCiFix()).toMatchObject({ pending: false });
  });

  it("from the wrong state it's dropped and logged, and nothing changes", async () => {
    const d = deps([LABELS.AUTO_MERGING]);
    await d.setCiFix({ attempts: 1, pending: true });
    expect(await coordinateWebhook(d, none())).toMatchObject({ outcome: "dropped_no_rule" });
    expect(d.removeLabel).not.toHaveBeenCalled();
    expect(await d.getCiFix()).toMatchObject({ pending: true });
    expect(d.logTransition).toHaveBeenCalledWith(expect.objectContaining({ event: EVENTS.REWORK_NO_CHANGE, droppedReason: expect.any(String) }));
  });

  it("an untrusted commenter's report is ignored", async () => {
    const d = deps([LABELS.AUTO_REWORKING]);
    expect(await coordinateWebhook(d, none("NONE"))).toEqual({ outcome: "no_event" });
    expect(d.removeLabel).not.toHaveBeenCalled();
  });
});

describe("merge_blocked", () => {
  const blocked = outcomeComment(PR, ROUTINES.MERGE_FLOW, { outcome: "merge_blocked", reason: "branch protection requires a code owner" });

  it(`swaps ${LABELS.AUTO_MERGING} for ${LABELS.MERGE_BLOCKED} and comments the reason`, async () => {
    const d = deps([LABELS.AUTO_MERGING]);
    expect(await coordinateWebhook(d, blocked)).toMatchObject({ outcome: "applied", event: EVENTS.MERGE_BLOCKED });
    expect(d.removeLabel).toHaveBeenCalledWith(OWNER, REPO, PR, LABELS.AUTO_MERGING);
    expect(d.addLabel).toHaveBeenCalledWith(OWNER, REPO, PR, LABELS.MERGE_BLOCKED);
    expect(d.commentOnIssue).toHaveBeenCalledWith(OWNER, REPO, PR, expect.stringContaining("branch protection requires a code owner"));
  });

  it("from the wrong state it's dropped and logged, with no label or comment", async () => {
    const d = deps([LABELS.AI_REVIEWING]);
    expect(await coordinateWebhook(d, blocked)).toMatchObject({ outcome: "dropped_no_rule" });
    expect(d.addLabel).not.toHaveBeenCalled();
    expect(d.commentOnIssue).not.toHaveBeenCalled();
    expect(d.logTransition).toHaveBeenCalledWith(expect.objectContaining({ event: EVENTS.MERGE_BLOCKED, droppedReason: expect.any(String) }));
  });
});

describe("discussion_capped", () => {
  const capped = outcomeComment(ISSUE, ROUTINES.ISSUE_DISCUSS_LOOP, { outcome: "discussion_capped" });

  it(`takes ${LABELS.AI_DISCUSSING} off`, async () => {
    const d = deps([LABELS.AI_DISCUSSING]);
    expect(await coordinateWebhook(d, capped)).toMatchObject({ outcome: "applied", event: EVENTS.DISCUSSION_CAPPED });
    expect(d.removeLabel).toHaveBeenCalledWith(OWNER, REPO, ISSUE, LABELS.AI_DISCUSSING);
  });

  it("from the wrong state it's dropped and logged", async () => {
    const d = deps([LABELS.AI_READY]);
    expect(await coordinateWebhook(d, capped)).toMatchObject({ outcome: "dropped_no_rule" });
    expect(d.removeLabel).not.toHaveBeenCalled();
  });
});
