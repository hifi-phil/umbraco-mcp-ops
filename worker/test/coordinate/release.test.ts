// The release split: on release_approved the Worker merges the release PR,
// pinned to the reviewed commit; when GitHub reports the Release published,
// it posts the note to Slack, closes the release issue and hands released on.
import { describe, expect, it, vi } from "vitest";
import { LABELS } from "@orchestrator/graph/constants/labels";
import { EVENTS } from "@orchestrator/graph/constants/events";
import { coordinateWebhook, type Deps } from "../../src/coordinate";
import { fakeDeps, input } from "./helpers";

const OWNER = "hifi-phil";
const REPO = "umbraco-mcp-ops";
const ISSUE = 219;

const approved = (extra: Record<string, unknown> = {}) =>
  input({
    deliveryId: "d-approved",
    issueNumber: ISSUE,
    payload: {
      action: "issue_comment.created",
      comment: {
        body: `Review passed.\n\n<!-- agent-outcome:auto-release-loop -->\n\`\`\`json\n${JSON.stringify({
          outcome: "release_approved",
          pr: 220,
          sha: "abc1234def",
          version: "2.1.0",
          note: "Issue stages and the release split.",
          ...extra,
        })}\n\`\`\``,
      },
    },
  });
const published = (version = "2.1.0") =>
  input({
    deliveryId: "d-published",
    issueNumber: ISSUE,
    payload: { action: "release.published", release: { version, url: `https://github.com/${OWNER}/${REPO}/releases/tag/v${version}` } },
  });
const releasing = (overrides: Partial<Deps> = {}) => fakeDeps({ getLabels: vi.fn(async () => [LABELS.AUTO_RELEASING]), ...overrides });

describe("release_approved: the Worker merges", () => {
  it("merges the PR at the reviewed commit, keeps the note, marks the run completed, says so; the label stays", async () => {
    const d = releasing();
    expect(await coordinateWebhook(d, approved())).toMatchObject({ outcome: "applied", event: EVENTS.RELEASE_APPROVED });
    expect(d.mergePull).toHaveBeenCalledWith(OWNER, REPO, 220, "abc1234def");
    expect(await d.getReleaseNote()).toEqual({ version: "2.1.0", note: "Issue stages and the release split." });
    expect(d.markCompleted).toHaveBeenCalled();
    expect(d.commentOnIssue).toHaveBeenCalledWith(OWNER, REPO, ISSUE, expect.stringMatching(/review passed\. Merged #220/));
    expect(d.removeLabel).not.toHaveBeenCalled();
    expect(d.closeIssue).not.toHaveBeenCalled();
  });

  it("GitHub refuses the merge (a push after the review): handled as a block, the label off with the reason", async () => {
    const d = releasing({ mergePull: vi.fn(async () => Promise.reject(new Error("409 Head branch was modified"))) });
    await coordinateWebhook(d, approved());
    expect(d.removeLabel).toHaveBeenCalledWith(OWNER, REPO, ISSUE, LABELS.AUTO_RELEASING);
    expect(d.commentOnIssue).toHaveBeenCalledWith(OWNER, REPO, ISSUE, expect.stringMatching(/Not releasing v2\.1\.0.*abc1234.*Head branch was modified/));
    expect(await d.getReleaseNote()).toBeNull();
    expect(d.logTransition).toHaveBeenCalledWith(expect.objectContaining({ event: EVENTS.RELEASE_BLOCKED }));
  });

  it("shadow: decided and logged, but nothing merged or posted", async () => {
    const d = releasing({ enforced: () => false });
    await coordinateWebhook(d, approved());
    expect(d.mergePull).not.toHaveBeenCalled();
    expect(d.commentOnIssue).not.toHaveBeenCalled();
  });
});

describe("the Release is out (GitHub's release event)", () => {
  it("posts the note to Slack, closes the release issue, and hands released to the waiting issues", async () => {
    const d = releasing({ openWithLabel: vi.fn(async () => [12]) });
    await d.setReleaseNote({ version: "2.1.0", note: "Issue stages and the release split." });
    expect(await coordinateWebhook(d, published())).toMatchObject({ outcome: "applied", event: EVENTS.RELEASE_PUBLISHED });
    expect(d.postSlack).toHaveBeenCalledWith(
      `🚀 ${REPO} v2.1.0 released: Issue stages and the release split. (https://github.com/${OWNER}/${REPO}/releases/tag/v2.1.0)`,
    );
    expect(d.closeIssue).toHaveBeenCalledWith(OWNER, REPO, ISSUE);
    expect(d.forward).toHaveBeenCalledWith({ owner: OWNER, repo: REPO, issueNumber: 12 }, { action: "orchestrator.released", release: { version: "2.1.0" } }, "d-published:#12");
  });

  it("no note for this version (a release the Worker didn't merge): no Slack post, still closed", async () => {
    const d = releasing();
    await d.setReleaseNote({ version: "2.0.0", note: "older" });
    await coordinateWebhook(d, published("2.1.0"));
    expect(d.postSlack).not.toHaveBeenCalled();
    expect(d.closeIssue).toHaveBeenCalled();
  });

  it("the Slack post fails: said on the issue, the release isn't held back", async () => {
    const d = releasing({ postSlack: vi.fn(async () => Promise.reject(new Error("500"))) });
    await d.setReleaseNote({ version: "2.1.0", note: "n" });
    expect(await coordinateWebhook(d, published())).toMatchObject({ outcome: "applied" });
    expect(d.commentOnIssue).toHaveBeenCalledWith(OWNER, REPO, ISSUE, expect.stringMatching(/Slack release post failed/));
    expect(d.closeIssue).toHaveBeenCalled();
  });
});
