// The release split (15-agent-splits.md): the agent prepares and reviews;
// on release_approved the Worker merges the release PR, pinned to the commit
// the review saw, then waits for the repo's own workflow to tag and publish
// the Release. On that Release the Worker posts the note to Slack.

import { LABELS } from "@orchestrator/graph/constants/labels";
import { EVENTS } from "@orchestrator/graph/constants/events";
import { parseOutcomeArtifact } from "@orchestrator/graph/github/from-github";
import { depsFor, type CoordinateInput, type CoordinateResult, type Deps } from "./types";
import { applyEvent } from "./apply";

/**
 * The review passed: merge the PR with a merge commit (never a squash; the
 * tag and sync workflows key off it), pinned to the reviewed commit so a push
 * after the review is refused, not shipped. A refused merge is handled like
 * a block: the trigger label comes off, with a comment saying why. Merged,
 * the issue is marked completed, so the sweep doesn't take the wait for the
 * Release as a lost run and fire the release again.
 */
export async function releaseApproved(deps: Deps, input: CoordinateInput, currentLabels: string[]): Promise<CoordinateResult> {
  const outcome = parseOutcomeArtifact(input.payload.comment?.body);
  if (outcome?.outcome !== "release_approved") return { outcome: "no_event" };
  // This one merges code, so unlike the other outcomes it counts only from
  // the Worker's own App or someone with write access: anyone else's
  // comment is ignored, not acted on.
  if (!(await trustedAuthor(deps, input))) return { outcome: "no_event" };
  const result = await applyEvent(deps, input, EVENTS.RELEASE_APPROVED, currentLabels);
  if (result.outcome !== "applied") return result;

  const { io } = depsFor(deps, EVENTS.RELEASE_APPROVED);
  const where = { owner: input.owner, repo: input.repo };
  const refuse = async (why: string) => {
    await applyEvent(deps, input, EVENTS.RELEASE_BLOCKED, currentLabels);
    await io.commentOnIssue(
      where.owner,
      where.repo,
      input.issueNumber,
      `🛑 Not releasing v${outcome.version}: ${why} \`${LABELS.AUTO_RELEASING}\` is removed; fix the cause and re-add it to try again. ` +
        `(Automatic, from the orchestrator.)`,
    );
    return result;
  };

  // Only this version's release PR, into the default branch.
  const pr = await deps.getPullDetails(where.owner, where.repo, outcome.pr);
  if (pr.headRef !== `release/${outcome.version}` || pr.baseRef !== pr.defaultBranch) {
    return refuse(`#${outcome.pr} isn't the release PR for v${outcome.version} (it's \`${pr.headRef}\` into \`${pr.baseRef}\`).`);
  }
  // Merged already: a redelivery, or the merge's answer was lost. At the
  // reviewed commit that's done, not a refusal; at any other it needs a person.
  if (pr.merged) {
    if (pr.headSha !== outcome.sha) return refuse(`#${outcome.pr} was merged at a commit the review didn't see (\`${pr.headSha.slice(0, 7)}\`).`);
  } else {
    try {
      await io.mergePull(where.owner, where.repo, outcome.pr, outcome.sha);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return refuse(`merging #${outcome.pr} at the reviewed commit (\`${outcome.sha.slice(0, 7)}\`) was refused. GitHub said: ${why.slice(0, 300)}`);
    }
  }
  await deps.setReleaseNote({ version: outcome.version, note: outcome.note });
  await deps.markCompleted(new Date().toISOString());
  await io.commentOnIssue(
    where.owner,
    where.repo,
    input.issueNumber,
    `✅ The pre-publish review passed. Merged #${outcome.pr} into \`main\`; the repo's release workflow tags and publishes ` +
      `v${outcome.version}, and this closes when that Release is out. (Automatic, from the orchestrator.)`,
  );
  return result;
}

/** Write access, as for a discussion reply (from-github.ts): the comment's
 * author association, or the Worker's own App bot. */
const TRUSTED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];
async function trustedAuthor(deps: Deps, input: CoordinateInput): Promise<boolean> {
  const sender = input.payload.sender?.login;
  const bot = await deps.botLogin();
  if (bot && sender === bot) return true;
  return TRUSTED_ASSOCIATIONS.includes(input.payload.comment?.author_association ?? "");
}

/** The Release is out (GitHub's own event): its note to Slack, if a webhook
 * is set and the review left one. Never fails the release: a failed post is
 * said on the issue instead. */
export async function announceRelease(deps: Deps, input: CoordinateInput): Promise<void> {
  const release = input.payload.release;
  const stored = await deps.getReleaseNote();
  if (!release || !stored || stored.version !== release.version) return;
  const text = `🚀 ${input.repo} v${release.version} released: ${stored.note}${release.url ? ` (${release.url})` : ""}`;
  const { io } = depsFor(deps, EVENTS.RELEASE_PUBLISHED);
  try {
    await io.postSlack(text);
  } catch {
    await io.commentOnIssue(input.owner, input.repo, input.issueNumber, "The Slack release post failed; the release itself is out. (Automatic, from the orchestrator.)");
  }
}
