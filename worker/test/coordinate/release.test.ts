// The release split: before (the agent's release_approved), the merge (the
// Worker, as the App, the way the approval says), after (release-publish,
// fired once merged; its release_published closes the issue and hands
// released on with the tag it reported).
import { describe, expect, it, vi } from "vitest";
import { LABELS } from "@orchestrator/graph/constants/labels";
import { EVENTS } from "@orchestrator/graph/constants/events";
import { ROUTINES } from "@orchestrator/graph/constants/routines";
import { coordinateWebhook, type Deps } from "../../src/coordinate";
import { fakeDeps, input } from "./helpers";

const OWNER = "hifi-phil";
const REPO = "umbraco-mcp-ops";
const ISSUE = 219;

const outcomeComment = (json: Record<string, unknown>, author_association = "OWNER", sender = "hifi-phil", deliveryId = "d-outcome") =>
  input({
    deliveryId,
    issueNumber: ISSUE,
    payload: {
      action: "issue_comment.created",
      sender: { login: sender, type: "User" },
      comment: { author_association, body: `Done.\n\n<!-- agent-outcome:auto-release-loop -->\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\`` },
    },
  });
const approved = (extra: Record<string, unknown> = {}, association?: string, sender?: string) =>
  outcomeComment({ outcome: "release_approved", pr: 220, sha: "abc1234def", version: "2.1.0", merge_method: "merge", ...extra }, association, sender);
const releasing = (overrides: Partial<Deps> = {}) => fakeDeps({ getLabels: vi.fn(async () => [LABELS.AUTO_RELEASING]), ...overrides });
const pull = (over: Record<string, unknown> = {}) =>
  vi.fn(async () => ({ headRef: "release/2.1.0", headSha: "abc1234def", baseRef: "main", defaultBranch: "main", merged: false, ...over }));

describe("release_approved: the Worker merges, then the after part runs", () => {
  it("merges the way the approval says, pinned to the reviewed commit, then fires release-publish (watched)", async () => {
    const d = releasing();
    expect(await coordinateWebhook(d, approved({ merge_method: "squash" }))).toMatchObject({ outcome: "applied", event: EVENTS.RELEASE_MERGED });
    expect(d.mergePull).toHaveBeenCalledWith(OWNER, REPO, 220, "abc1234def", "squash");
    expect(d.fireRoutine).toHaveBeenCalledWith(OWNER, REPO, ISSUE, ROUTINES.RELEASE_PUBLISH);
    expect(await d.getPendingFire()).toMatchObject({ run: ROUTINES.RELEASE_PUBLISH });
    expect(d.logTransition).toHaveBeenCalledWith(expect.objectContaining({ event: EVENTS.RELEASE_APPROVED }));
    expect(d.commentOnIssue).toHaveBeenCalledWith(OWNER, REPO, ISSUE, expect.stringMatching(/merged #220 \(squash\)/));
    expect(d.removeLabel).not.toHaveBeenCalled();
  });

  it("no project convention is checked: any branch name, as long as the commit is the reviewed one", async () => {
    const d = releasing({ getPullDetails: pull({ headRef: "anything/at-all", baseRef: "trunk", defaultBranch: "trunk" }) });
    await coordinateWebhook(d, approved());
    expect(d.mergePull).toHaveBeenCalled();
  });

  it("GitHub refuses the merge (a push after the review): handled as a block, the label off with the reason, nothing fired", async () => {
    const d = releasing({ mergePull: vi.fn(async () => Promise.reject(new Error("409 Head branch was modified"))) });
    await coordinateWebhook(d, approved());
    expect(d.removeLabel).toHaveBeenCalledWith(OWNER, REPO, ISSUE, LABELS.AUTO_RELEASING);
    expect(d.commentOnIssue).toHaveBeenCalledWith(OWNER, REPO, ISSUE, expect.stringMatching(/Not releasing v2\.1\.0.*abc1234.*Head branch was modified/));
    expect(d.fireRoutine).not.toHaveBeenCalled();
  });

  it("already merged at the reviewed commit (a redelivery, a lost answer): done, the after part runs", async () => {
    const d = releasing({ getPullDetails: pull({ merged: true }) });
    await coordinateWebhook(d, approved());
    expect(d.mergePull).not.toHaveBeenCalled();
    expect(d.fireRoutine).toHaveBeenCalledWith(OWNER, REPO, ISSUE, ROUTINES.RELEASE_PUBLISH);
  });

  it("the merge call fails but the PR did merge at the reviewed commit (a lost answer): done, the after part runs", async () => {
    const getPullDetails = vi.fn().mockResolvedValueOnce({ headRef: "release/2.1.0", headSha: "abc1234def", baseRef: "main", defaultBranch: "main", merged: false })
      .mockResolvedValueOnce({ headRef: "release/2.1.0", headSha: "abc1234def", baseRef: "main", defaultBranch: "main", merged: true });
    const d = releasing({ getPullDetails, mergePull: vi.fn(async () => Promise.reject(new Error("502 Bad Gateway"))) });
    expect(await coordinateWebhook(d, approved())).toMatchObject({ outcome: "applied", event: EVENTS.RELEASE_MERGED });
    expect(d.removeLabel).not.toHaveBeenCalled();
    expect(d.fireRoutine).toHaveBeenCalledWith(OWNER, REPO, ISSUE, ROUTINES.RELEASE_PUBLISH);
  });

  it("release-publish is fired before the comment: a failed comment still leaves it running and watched", async () => {
    const d = releasing({ commentOnIssue: vi.fn(async () => Promise.reject(new Error("500"))) });
    await expect(coordinateWebhook(d, approved())).rejects.toThrow("500");
    expect(d.fireRoutine).toHaveBeenCalledWith(OWNER, REPO, ISSUE, ROUTINES.RELEASE_PUBLISH);
    expect(await d.getPendingFire()).toMatchObject({ run: ROUTINES.RELEASE_PUBLISH });
  });

  it("already merged at a commit the review didn't see: refused, for a person", async () => {
    const d = releasing({ getPullDetails: pull({ merged: true, headSha: "other99" }) });
    await coordinateWebhook(d, approved());
    expect(d.removeLabel).toHaveBeenCalledWith(OWNER, REPO, ISSUE, LABELS.AUTO_RELEASING);
    expect(d.commentOnIssue).toHaveBeenCalledWith(OWNER, REPO, ISSUE, expect.stringMatching(/merged at a commit the review didn't see/));
    expect(d.fireRoutine).not.toHaveBeenCalled();
  });

  it("records the merge, so a lost release-publish is never answered with the before part again", async () => {
    const d = releasing();
    await coordinateWebhook(d, approved());
    expect(await d.getReleaseMerged()).toEqual({ pr: 220, sha: "abc1234def" });
  });

  it("shadow: decided and logged, nothing merged, posted, fired or recorded", async () => {
    const d = releasing({ enforced: () => false });
    await coordinateWebhook(d, approved());
    expect(await d.getReleaseMerged()).toBeNull();
    expect(d.mergePull).not.toHaveBeenCalled();
    expect(d.commentOnIssue).not.toHaveBeenCalled();
    expect(d.fireRoutine).not.toHaveBeenCalled();
  });
});

describe("release_approved: only a trusted author", () => {
  it("anyone without write access: ignored, nothing merged or logged", async () => {
    for (const association of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR"]) {
      const d = releasing();
      expect(await coordinateWebhook(d, approved({}, association, "someone")), association).toEqual({ outcome: "no_event" });
      expect(d.mergePull).not.toHaveBeenCalled();
      expect(d.logTransition).not.toHaveBeenCalled();
    }
  });

  it("the Worker's own App (the e2e stub posts as it) counts, whatever its association", async () => {
    const d = releasing({ botLogin: async () => "orchestrator[bot]" });
    await coordinateWebhook(d, approved({}, "NONE", "orchestrator[bot]"));
    expect(d.mergePull).toHaveBeenCalled();
  });
});

describe("release_published (from release-publish): the issue closes, released goes on with the reported tag", () => {
  it("closes the release issue and hands each waiting issue the version and the tag as reported", async () => {
    const d = releasing({ openWithLabel: vi.fn(async () => [12]) });
    const published = outcomeComment({ outcome: "release_published", version: "2.1.0", tag: "release-2.1.0" }, "OWNER", "hifi-phil", "d-published");
    expect(await coordinateWebhook(d, published)).toMatchObject({ outcome: "applied", event: EVENTS.RELEASE_PUBLISHED });
    expect(d.closeIssue).toHaveBeenCalledWith(OWNER, REPO, ISSUE);
    expect(d.forward).toHaveBeenCalledWith(
      { owner: OWNER, repo: REPO, issueNumber: 12 },
      { action: "orchestrator.released", release: { version: "2.1.0", tag: "release-2.1.0" } },
      "d-published:#12",
    );
  });

  it("anyone without write access: ignored, nothing closed or handed on (it closes issues)", async () => {
    const d = releasing({ openWithLabel: vi.fn(async () => [12]) });
    const forged = outcomeComment({ outcome: "release_published", version: "2.1.0", tag: "dev" }, "NONE", "someone", "d-forged");
    expect(await coordinateWebhook(d, forged)).toEqual({ outcome: "no_event" });
    expect(d.closeIssue).not.toHaveBeenCalled();
    expect(d.forward).not.toHaveBeenCalled();
  });

  it("clears the merge record", async () => {
    const d = releasing();
    await d.setReleaseMerged({ pr: 220, sha: "abc1234def" });
    await coordinateWebhook(d, outcomeComment({ outcome: "release_published", version: "2.1.0", tag: "v2.1.0" }, "OWNER", "hifi-phil", "d-pub"));
    expect(await d.getReleaseMerged()).toBeNull();
  });

  it("an agent that still publishes itself (no tag reported): v<version>, as it always tagged", async () => {
    const d = releasing({ openWithLabel: vi.fn(async () => [12]) });
    await coordinateWebhook(d, outcomeComment({ outcome: "release_published", version: "2.1.0" }, "OWNER", "hifi-phil", "d-old"));
    expect(d.forward).toHaveBeenCalledWith(expect.anything(), { action: "orchestrator.released", release: { version: "2.1.0", tag: "v2.1.0" } }, "d-old:#12");
  });
});

describe(`${LABELS.AUTO_RELEASING} re-added after the Worker merged: the after part again, not the before part`, () => {
  const relabelled = input({
    deliveryId: "d-relabel",
    issueNumber: ISSUE,
    payload: { action: "issues.labeled", label: { name: LABELS.AUTO_RELEASING }, sender: { login: "hifi-phil", type: "User" } },
  });

  it(`from ${LABELS.AI_STUCK}: ${LABELS.AI_STUCK} off, release-publish fired and watched`, async () => {
    const d = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AI_STUCK, LABELS.AUTO_RELEASING]) });
    await d.setReleaseMerged({ pr: 220, sha: "abc1234def" });
    expect(await coordinateWebhook(d, relabelled)).toMatchObject({ outcome: "applied", event: EVENTS.RELEASE_MERGED });
    expect(d.removeLabel).toHaveBeenCalledWith(OWNER, REPO, ISSUE, LABELS.AI_STUCK);
    expect(d.fireRoutine).toHaveBeenCalledWith(OWNER, REPO, ISSUE, ROUTINES.RELEASE_PUBLISH);
    expect(d.fireRoutine).not.toHaveBeenCalledWith(OWNER, REPO, ISSUE, ROUTINES.AUTO_RELEASE_LOOP);
  });

  it("nothing merged yet: the before part, as always", async () => {
    const d = fakeDeps({ getLabels: vi.fn(async () => [LABELS.AUTO_RELEASING]) });
    await coordinateWebhook(d, relabelled);
    expect(d.fireRoutine).toHaveBeenCalledWith(OWNER, REPO, ISSUE, ROUTINES.AUTO_RELEASE_LOOP);
  });
});
