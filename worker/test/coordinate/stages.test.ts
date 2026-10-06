// The issue's stages after its PR: a merged PR hands pr_merged to each issue
// it closes; a published release hands released to each issue waiting for
// one, which closes if the release's tag contains its merge.
import { describe, expect, it, vi } from "vitest";
import { LABELS } from "@orchestrator/graph/constants/labels";
import { EVENTS } from "@orchestrator/graph/constants/events";
import { coordinateWebhook } from "../../src/coordinate";
import { fakeDeps, input } from "./helpers";

const OWNER = "hifi-phil";
const REPO = "umbraco-mcp-ops";
const ref = (issueNumber: number) => ({ owner: OWNER, repo: REPO, issueNumber });

const merged = (body: string | null, merge_commit_sha: string | null = "sha-merge", merge = true) =>
  input({ deliveryId: "d-merge", issueNumber: 50, payload: { action: "pull_request.closed", pull_request: { merged: merge, body, merge_commit_sha } } });
const handOff = (issueNumber: number, payload: Record<string, unknown>) =>
  input({ deliveryId: `d-merge:#${issueNumber}`, issueNumber, payload: payload as never });
const publishedComment = (version: string) =>
  input({
    deliveryId: "d-release",
    issueNumber: 60,
    payload: {
      action: "issue_comment.created",
      comment: { body: `Done.\n\n<!-- agent-outcome:auto-release-loop -->\n\`\`\`json\n${JSON.stringify({ outcome: "release_published", version })}\n\`\`\`` },
    },
  });

describe("a PR merging hands pr_merged to each issue its description closes", () => {
  it("each closed issue gets it, with the PR and its merge commit, under its own delivery id", async () => {
    const d = fakeDeps();
    await coordinateWebhook(d, merged("Closes #12, and fixes #13. See #14."));
    expect(d.forward).toHaveBeenCalledTimes(2);
    expect(d.forward).toHaveBeenCalledWith(ref(12), { action: "orchestrator.pr_merged", shipped: { pr: 50, sha: "sha-merge" } }, "d-merge:#12");
    expect(d.forward).toHaveBeenCalledWith(ref(13), { action: "orchestrator.pr_merged", shipped: { pr: 50, sha: "sha-merge" } }, "d-merge:#13");
  });

  it("closed without merging, no merge commit, or no closing keyword -> nothing handed on", async () => {
    for (const i of [merged("Closes #12", "sha", false), merged("Closes #12", null), merged("Related to #12")]) {
      const d = fakeDeps();
      await coordinateWebhook(d, i);
      expect(d.forward).not.toHaveBeenCalled();
    }
  });
});

describe(`the issue: pr_merged -> ${LABELS.READY_FOR_RELEASE}`, () => {
  const prMerged = (n: number) => handOff(n, { action: "orchestrator.pr_merged", shipped: { pr: 50, sha: "sha-merge" } });

  it(`from ${LABELS.PR_OPEN}: the stage moves, and the merge commit is kept for the release check`, async () => {
    const d = fakeDeps({ getLabels: vi.fn(async () => [LABELS.PR_OPEN]) });
    expect(await coordinateWebhook(d, prMerged(12))).toMatchObject({ outcome: "applied", event: EVENTS.PR_MERGED });
    expect(d.removeLabel).toHaveBeenCalledWith(OWNER, REPO, 12, LABELS.PR_OPEN);
    expect(d.addLabel).toHaveBeenCalledWith(OWNER, REPO, 12, LABELS.READY_FOR_RELEASE);
    expect(await d.getShipped()).toEqual({ pr: 50, sha: "sha-merge" });
  });

  it("from no label (a person's PR): the same", async () => {
    const d = fakeDeps({ getLabels: vi.fn(async () => []) });
    expect(await coordinateWebhook(d, prMerged(12))).toMatchObject({ outcome: "applied" });
    expect(d.addLabel).toHaveBeenCalledWith(OWNER, REPO, 12, LABELS.READY_FOR_RELEASE);
  });

  it("an issue at another stage (still under discussion) is left alone", async () => {
    const d = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_DISCUSSING]) });
    expect(await coordinateWebhook(d, prMerged(12))).toMatchObject({ outcome: "ignored" });
    expect(d.addLabel).not.toHaveBeenCalled();
    expect(await d.getShipped()).toBeNull();
  });
});

describe("a release published hands released to each issue waiting for one", () => {
  it(`the release issue closes as before, and each open ${LABELS.READY_FOR_RELEASE} issue gets the version`, async () => {
    const d = fakeDeps({
      getLabels: vi.fn(async () => [LABELS.AUTO_RELEASING]),
      openWithLabel: vi.fn(async () => [12, 13]),
    });
    expect(await coordinateWebhook(d, publishedComment("2.1.0"))).toMatchObject({ outcome: "applied", event: EVENTS.RELEASE_PUBLISHED });
    expect(d.closeIssue).toHaveBeenCalledWith(OWNER, REPO, 60);
    expect(d.openWithLabel).toHaveBeenCalledWith(OWNER, REPO, LABELS.READY_FOR_RELEASE);
    expect(d.forward).toHaveBeenCalledWith(ref(12), { action: "orchestrator.released", release: { version: "2.1.0", tag: "v2.1.0" } }, "d-release:#12");
    expect(d.forward).toHaveBeenCalledWith(ref(13), { action: "orchestrator.released", release: { version: "2.1.0", tag: "v2.1.0" } }, "d-release:#13");
  });
});

describe(`the issue: released -> closed, if the release's tag contains its merge`, () => {
  const releasedIn = (version: string) => handOff(12, { action: "orchestrator.released", release: { version, tag: `v${version}` } });

  it("its merge is in the tag the release reported: closed", async () => {
    const d = fakeDeps({ getLabels: vi.fn(async () => [LABELS.READY_FOR_RELEASE]) });
    await d.setShipped({ pr: 50, sha: "sha-merge" });
    expect(await coordinateWebhook(d, releasedIn("2.1.0"))).toMatchObject({ outcome: "applied", event: EVENTS.RELEASED });
    expect(d.commitInRef).toHaveBeenCalledWith(OWNER, REPO, "sha-merge", "v2.1.0");
    expect(d.closeIssue).toHaveBeenCalledWith(OWNER, REPO, 12);
  });

  it("merged after the release was cut (not in the tag): waits for the next release, nothing written", async () => {
    const d = fakeDeps({ getLabels: vi.fn(async () => [LABELS.READY_FOR_RELEASE]), commitInRef: vi.fn(async () => false) });
    await d.setShipped({ pr: 50, sha: "sha-merge" });
    expect(await coordinateWebhook(d, releasedIn("2.1.0"))).toMatchObject({ outcome: "ignored" });
    expect(d.closeIssue).not.toHaveBeenCalled();
    expect(d.logTransition).not.toHaveBeenCalled();
  });

  it("no merge on record (labelled by hand): nothing to check, left open", async () => {
    const d = fakeDeps({ getLabels: vi.fn(async () => [LABELS.READY_FOR_RELEASE]) });
    expect(await coordinateWebhook(d, releasedIn("2.1.0"))).toMatchObject({ outcome: "ignored" });
    expect(d.commitInRef).not.toHaveBeenCalled();
    expect(d.closeIssue).not.toHaveBeenCalled();
  });
});
