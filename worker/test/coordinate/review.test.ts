// The review (15-agent-splits.md): LABELS.AI_REVIEWING's CI gate, review-loop's
// verdicts, the pushes that bring a PR back to LABELS.AI_REVIEWING, and the caps.
import { describe, expect, it, vi } from "vitest";
import { LABELS } from "@orchestrator/graph/constants/labels";
import { EVENTS } from "@orchestrator/graph/constants/events";
import { ROUTINES } from "@orchestrator/graph/constants/routines";
import {
  DEFAULT_CAPS,
  MAX_BOT_REVIEW_REWORKS,
  MAX_CI_FIX_ATTEMPTS,
  MAX_REVIEW_REWORKS,
  coordinateReconcile,
  coordinateWebhook,
  type Deps,
} from "../../src/coordinate";
import { fakeDeps, gateFacts, input } from "./helpers";

const OWNER = "hifi-phil";
const REPO = "umbraco-mcp-ops";
const PR = 412;
const person = { login: "a-person", type: "User" as const };

const labelled = (name: string, deliveryId = "d-label") =>
  input({ deliveryId, payload: { action: "pull_request.labeled", label: { name }, sender: person } });
const checkSuite = (deliveryId = "d-suite") =>
  input({ deliveryId, payload: { action: "check_suite.completed", check_suite: { status: "completed", conclusion: "success" } } });
const pushed = (deliveryId = "d-push") => input({ deliveryId, payload: { action: "pull_request.synchronize", sender: person } });
const verdict = (json: Record<string, unknown>, deliveryId = "d-verdict") =>
  input({
    deliveryId,
    payload: {
      action: "issue_comment.created",
      comment: { body: `Review.\n\n<!-- agent-outcome:review-loop -->\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\`` },
    },
  });

const green = gateFacts({ checkRuns: [{ status: "completed", conclusion: "success", name: "test" }] });
const red = gateFacts({ checkRuns: [{ status: "completed", conclusion: "failure", name: "test" }] });
const running = gateFacts({ checkRuns: [{ status: "in_progress", conclusion: null, name: "test" }] });

function expectFiredOnce(d: Deps, routine: string) {
  expect(d.fireRoutine).toHaveBeenCalledTimes(1);
  expect(d.fireRoutine).toHaveBeenCalledWith(OWNER, REPO, PR, routine);
}

function deps(labels: string[], facts = green, overrides: Partial<Deps> = {}) {
  return fakeDeps({ getLabels: vi.fn(async () => labels), getMergeGateFacts: vi.fn(async () => facts), ...overrides });
}

describe(`${LABELS.AI_REVIEWING} added: the label, then the CI gate`, () => {
  it("CI already green: fires review-loop and watches it", async () => {
    const d = deps([LABELS.AI_REVIEWING]);
    const result = await coordinateWebhook(d, labelled(LABELS.AI_REVIEWING));
    expect(result).toMatchObject({ outcome: "applied", event: EVENTS.REVIEW_CI_PASSED });
    expectFiredOnce(d, ROUTINES.REVIEW_LOOP);
    expect(await d.getPendingFire()).toMatchObject({ run: ROUTINES.REVIEW_LOOP });
    expect(d.logTransition).toHaveBeenCalledWith(expect.objectContaining({ event: EVENTS.LABELLED_AI_REVIEWING, actor: "a-person" }));
  });

  it("CI still running, or not started (no checks yet): labelled, nothing fired", async () => {
    for (const facts of [running, gateFacts({ checkRuns: [] })]) {
      const d = deps([LABELS.AI_REVIEWING], facts);
      expect(await coordinateWebhook(d, labelled(LABELS.AI_REVIEWING))).toMatchObject({
        outcome: "applied",
        event: EVENTS.LABELLED_AI_REVIEWING,
      });
      expect(d.fireRoutine).not.toHaveBeenCalled();
    }
  });

  it(`CI red: rework-loop fixes it first, a counted CI fix that comes back to ${LABELS.AI_REVIEWING}`, async () => {
    const d = deps([LABELS.AI_REVIEWING], red);
    expect(await coordinateWebhook(d, labelled(LABELS.AI_REVIEWING))).toMatchObject({ event: EVENTS.REVIEW_CI_FAILED });
    expect(d.removeLabel).toHaveBeenCalledWith(OWNER, REPO, PR, LABELS.AI_REVIEWING);
    expect(d.addLabel).toHaveBeenCalledWith(OWNER, REPO, PR, LABELS.AUTO_REWORKING);
    expectFiredOnce(d, ROUTINES.REWORK_LOOP);
    expect(await d.getCiFix()).toEqual({ attempts: 1, pending: true, returnTo: LABELS.AI_REVIEWING });
    expect(d.commentOnIssue).toHaveBeenCalledWith(OWNER, REPO, PR, expect.stringMatching(/CI failing: test.*attempt 1 of 3/));
  });

  it(`re-run on a PR the review blocked: ${LABELS.AI_BLOCKED} comes off, then the gate`, async () => {
    const d = deps([LABELS.AI_BLOCKED, LABELS.AI_REVIEWING]);
    expect(await coordinateWebhook(d, labelled(LABELS.AI_REVIEWING))).toMatchObject({ event: EVENTS.REVIEW_CI_PASSED });
    expect(d.removeLabel).toHaveBeenCalledWith(OWNER, REPO, PR, LABELS.AI_BLOCKED);
    expect(d.fireRoutine).toHaveBeenCalledWith(OWNER, REPO, PR, ROUTINES.REVIEW_LOOP);
  });

  it(`re-run from ${LABELS.AI_STUCK}: fresh counts for the review's rounds and its CI fixes`, async () => {
    const d = deps([LABELS.AI_STUCK, LABELS.AI_REVIEWING]);
    await d.setReviewLoop({ botRounds: MAX_BOT_REVIEW_REWORKS, fixPending: false });
    await d.setCiFix({ attempts: MAX_CI_FIX_ATTEMPTS, pending: false, returnTo: LABELS.AI_REVIEWING });
    await coordinateWebhook(d, labelled(LABELS.AI_REVIEWING));
    expect(await d.getReviewLoop()).toBeNull();
    expect(await d.getCiFix()).toBeNull();
    expect(d.removeLabel).toHaveBeenCalledWith(OWNER, REPO, PR, LABELS.AI_STUCK);
  });
});

describe("the label and its check suite, handled in either order", () => {
  it("the check suite first fired the review: the label's webhook then fires nothing more (e2e #729)", async () => {
    const d = deps([LABELS.AI_REVIEWING]);
    expect(await coordinateWebhook(d, checkSuite("s-first"))).toMatchObject({ event: EVENTS.REVIEW_CI_PASSED });
    expect(await coordinateWebhook(d, labelled(LABELS.AI_REVIEWING, "d-label-second"))).toMatchObject({ outcome: "stale_label" });
    expectFiredOnce(d, ROUTINES.REVIEW_LOOP);
    expect(await d.getPendingFire()).toMatchObject({ run: ROUTINES.REVIEW_LOOP });
  });
});

describe(`a check suite finishing on an ${LABELS.AI_REVIEWING} PR`, () => {
  it("green: fires review-loop once, however many suites report after it", async () => {
    const d = deps([LABELS.AI_REVIEWING]);
    expect(await coordinateWebhook(d, checkSuite("s-1"))).toMatchObject({ event: EVENTS.REVIEW_CI_PASSED });
    expect(await coordinateWebhook(d, checkSuite("s-2"))).toEqual({ outcome: "no_event" });
    expect(d.fireRoutine).toHaveBeenCalledTimes(1);
  });

  it("still running: waits", async () => {
    const d = deps([LABELS.AI_REVIEWING], running);
    expect(await coordinateWebhook(d, checkSuite())).toEqual({ outcome: "no_event" });
    expect(d.fireRoutine).not.toHaveBeenCalled();
  });

  it(`CI fixes past MAX_CI_FIX_ATTEMPTS: ${LABELS.AI_STUCK} with a comment, nothing fired`, async () => {
    const d = deps([LABELS.AI_REVIEWING], red);
    await d.setCiFix({ attempts: MAX_CI_FIX_ATTEMPTS, pending: false, returnTo: LABELS.AI_REVIEWING });
    expect(await coordinateWebhook(d, checkSuite())).toMatchObject({ event: EVENTS.REWORK_CAP_REACHED });
    expect(d.addLabel).toHaveBeenCalledWith(OWNER, REPO, PR, LABELS.AI_STUCK);
    expect(d.fireRoutine).not.toHaveBeenCalled();
    expect(d.commentOnIssue).toHaveBeenCalledWith(OWNER, REPO, PR, expect.stringMatching(/still failing after 3 fix attempts/));
  });
});

describe(`the push that brings a PR back to ${LABELS.AI_REVIEWING}`, () => {
  it(`after a CI fix started from ${LABELS.AI_REVIEWING}: review_fix_pushed -> ${LABELS.AI_REVIEWING}, nothing fired (it waits for CI)`, async () => {
    const d = deps([LABELS.AUTO_REWORKING]);
    await d.setCiFix({ attempts: 1, pending: true, returnTo: LABELS.AI_REVIEWING });
    expect(await coordinateWebhook(d, pushed())).toMatchObject({ event: EVENTS.REVIEW_FIX_PUSHED });
    expect(d.removeLabel).toHaveBeenCalledWith(OWNER, REPO, PR, LABELS.AUTO_REWORKING);
    expect(d.addLabel).toHaveBeenCalledWith(OWNER, REPO, PR, LABELS.AI_REVIEWING);
    expect(d.fireRoutine).not.toHaveBeenCalled();
    expect(await d.getCiFix()).toMatchObject({ pending: false });
  });

  it("after the review's findings: the same", async () => {
    const d = deps([LABELS.AUTO_REWORKING]);
    await d.setReviewLoop({ botRounds: 1, fixPending: true });
    expect(await coordinateWebhook(d, pushed())).toMatchObject({ event: EVENTS.REVIEW_FIX_PUSHED });
    expect(await d.getReviewLoop()).toEqual({ botRounds: 1, fixPending: false });
  });

  it(`an ${LABELS.AUTO_MERGING} CI fix still goes back to ${LABELS.AUTO_MERGING}`, async () => {
    const d = deps([LABELS.AUTO_REWORKING]);
    await d.setCiFix({ attempts: 1, pending: true });
    expect(await coordinateWebhook(d, pushed())).toMatchObject({ event: EVENTS.CI_FIX_PUSHED });
  });
});

describe("review-loop's verdicts", () => {
  it("findings: a counted round for rework-loop, with a comment", async () => {
    const d = deps([LABELS.AI_REVIEWING]);
    expect(await coordinateWebhook(d, verdict({ outcome: "review_findings", findings: 2 }))).toMatchObject({
      event: EVENTS.REVIEW_FINDINGS,
    });
    expect(d.addLabel).toHaveBeenCalledWith(OWNER, REPO, PR, LABELS.AUTO_REWORKING);
    expectFiredOnce(d, ROUTINES.REWORK_LOOP);
    expect(await d.getReviewLoop()).toEqual({ botRounds: 1, fixPending: true });
    expect(d.commentOnIssue).toHaveBeenCalledWith(OWNER, REPO, PR, expect.stringMatching(/Review round 1 of 3/));
  });

  it(`findings past MAX_BOT_REVIEW_REWORKS: ${LABELS.AI_STUCK}, nothing fired`, async () => {
    const d = deps([LABELS.AI_REVIEWING]);
    await d.setReviewLoop({ botRounds: MAX_BOT_REVIEW_REWORKS, fixPending: false });
    expect(await coordinateWebhook(d, verdict({ outcome: "review_findings", findings: 1 }))).toMatchObject({
      event: EVENTS.REWORK_CAP_REACHED,
    });
    expect(d.addLabel).toHaveBeenCalledWith(OWNER, REPO, PR, LABELS.AI_STUCK);
    expect(d.fireRoutine).not.toHaveBeenCalled();
    expect(d.commentOnIssue).toHaveBeenCalledWith(OWNER, REPO, PR, expect.stringMatching(/asked for changes 3 times/));
  });

  it(`pass: ${LABELS.AI_REVIEWING} swapped for ${LABELS.READY_FOR_REVIEW}, and the counts reset for the next stage`, async () => {
    const d = deps([LABELS.AI_REVIEWING]);
    await d.setReviewLoop({ botRounds: 2, fixPending: false });
    await d.setCiFix({ attempts: 2, pending: false, returnTo: LABELS.AI_REVIEWING });
    expect(await coordinateWebhook(d, verdict({ outcome: "review_passed" }))).toMatchObject({ event: EVENTS.REVIEW_PASSED });
    expect(d.removeLabel).toHaveBeenCalledWith(OWNER, REPO, PR, LABELS.AI_REVIEWING);
    expect(d.addLabel).toHaveBeenCalledWith(OWNER, REPO, PR, LABELS.READY_FOR_REVIEW);
    expect(d.fireRoutine).not.toHaveBeenCalled();
    expect(await d.getReviewLoop()).toBeNull();
    expect(await d.getCiFix()).toBeNull();
  });

  it(`then a person approves: ${LABELS.READY_FOR_REVIEW} swapped for ${LABELS.AUTO_MERGING}, merge-flow fired`, async () => {
    const d = deps([LABELS.READY_FOR_REVIEW, LABELS.AUTO_MERGING]);
    expect(await coordinateWebhook(d, labelled(LABELS.AUTO_MERGING))).toMatchObject({ event: EVENTS.LABELLED_AUTO_MERGING });
    expect(d.removeLabel).toHaveBeenCalledWith(OWNER, REPO, PR, LABELS.READY_FOR_REVIEW);
    expect(d.fireRoutine).toHaveBeenCalledWith(OWNER, REPO, PR, ROUTINES.MERGE_FLOW);
  });

  it(`block: ${LABELS.AI_BLOCKED}, nothing fired, waits for a person`, async () => {
    const d = deps([LABELS.AI_REVIEWING]);
    expect(await coordinateWebhook(d, verdict({ outcome: "review_blocked", reason: "wrong approach" }))).toMatchObject({
      event: EVENTS.REVIEW_BLOCKED,
    });
    expect(d.addLabel).toHaveBeenCalledWith(OWNER, REPO, PR, LABELS.AI_BLOCKED);
    expect(d.fireRoutine).not.toHaveBeenCalled();
  });
});

describe("bot and human review rounds are counted separately", () => {
  it("a person's rounds used up don't stop the review's findings", async () => {
    const d = deps([LABELS.AI_REVIEWING], green, { getReviewReworks: vi.fn(async () => MAX_REVIEW_REWORKS) });
    expect(await coordinateWebhook(d, verdict({ outcome: "review_findings", findings: 1 }))).toMatchObject({
      event: EVENTS.REVIEW_FINDINGS,
    });
  });

  it(`the review's rounds used up don't stop a person's ${LABELS.AUTO_REWORKING}`, async () => {
    const d = deps([LABELS.AUTO_REWORKING]);
    await d.setReviewLoop({ botRounds: MAX_BOT_REVIEW_REWORKS, fixPending: false });
    expect(await coordinateWebhook(d, labelled(LABELS.AUTO_REWORKING))).toMatchObject({ event: EVENTS.LABELLED_AUTO_REWORKING });
    expect(d.fireRoutine).toHaveBeenCalledWith(OWNER, REPO, PR, ROUTINES.REWORK_LOOP);
  });

  it(`a person retrying ${LABELS.AUTO_REWORKING} from ${LABELS.AI_STUCK} resets the review's count too`, async () => {
    const d = deps([LABELS.AI_STUCK, LABELS.AUTO_REWORKING]);
    await d.setReviewLoop({ botRounds: MAX_BOT_REVIEW_REWORKS, fixPending: false });
    await coordinateWebhook(d, labelled(LABELS.AUTO_REWORKING));
    expect(await d.getReviewLoop()).toBeNull();
  });
});

describe(`the sweep and a PR left in ${LABELS.AI_REVIEWING}`, () => {
  const ref = { owner: OWNER, repo: REPO, issueNumber: PR };
  const opts = { enforced: true, now: Date.parse("2026-10-04T12:00:00Z") };
  const idle = { lastActivityAt: async () => "2026-10-04 08:00:00" };

  it("idle, CI green, nothing out: the gate fires review-loop", async () => {
    const d = deps([LABELS.AI_REVIEWING], green, idle);
    const result = await coordinateReconcile(d, ref, opts);
    expect(result).toMatchObject({ outcome: "gated", result: { outcome: "applied", event: EVENTS.REVIEW_CI_PASSED } });
    expectFiredOnce(d, ROUTINES.REVIEW_LOOP);
  });

  it("idle, CI still running: nothing fired", async () => {
    const d = deps([LABELS.AI_REVIEWING], running, idle);
    expect(await coordinateReconcile(d, ref, opts)).toEqual({ outcome: "gated", result: { outcome: "no_event" } });
    expect(d.fireRoutine).not.toHaveBeenCalled();
  });
});

describe("a repo's lowered caps (the e2e sandbox's)", () => {
  const caps = { ...DEFAULT_CAPS, ciFixAttempts: 1, botReviewReworks: 1 };

  it("review findings: the second round is past a cap of 1", async () => {
    const d = deps([LABELS.AI_REVIEWING], green, { caps });
    await d.setReviewLoop({ botRounds: 1, fixPending: false });
    expect(await coordinateWebhook(d, verdict({ outcome: "review_findings", findings: 1 }))).toMatchObject({
      event: EVENTS.REWORK_CAP_REACHED,
    });
    expect(d.commentOnIssue).toHaveBeenCalledWith(OWNER, REPO, PR, expect.stringMatching(/asked for changes 1 times, the most it's given \(1\)/));
  });

  it(`CI fixes under ${LABELS.AI_REVIEWING}: the first says 'attempt 1 of 1', the second is past the cap`, async () => {
    const d = deps([LABELS.AI_REVIEWING], red, { caps });
    await coordinateWebhook(d, checkSuite("s-1"));
    expect(d.commentOnIssue).toHaveBeenCalledWith(OWNER, REPO, PR, expect.stringMatching(/attempt 1 of 1/));
    await d.setCiFix({ attempts: 1, pending: false, returnTo: LABELS.AI_REVIEWING });
    expect(await coordinateWebhook(d, checkSuite("s-2"))).toMatchObject({ event: EVENTS.REWORK_CAP_REACHED });
  });
});
