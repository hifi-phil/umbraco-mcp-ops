// The release split (15-agent-splits.md): before (the agent prepares and
// reviews, then reports release_approved), the merge (the Worker, as the
// App), and after (release-publish, a skinny agent fired once merged). The
// Worker holds no project conventions: the merge method comes in the
// approval, and the tag in release-publish's release_published.

import { LABELS } from "@orchestrator/graph/constants/labels";
import { EVENTS } from "@orchestrator/graph/constants/events";
import { parseOutcomeArtifact } from "@orchestrator/graph/github/from-github";
import { depsFor, type CoordinateInput, type CoordinateResult, type Deps } from "./types";
import { applyEvent } from "./apply";

/**
 * The review passed: merge the PR the way the approval says, pinned to the
 * reviewed commit (GitHub refuses if anything was pushed after the review),
 * then release_merged fires the after part. Only a trusted author's approval
 * counts, since this merges code. A refused merge is handled like a block:
 * the trigger label comes off, with a comment saying why. A PR already
 * merged at the reviewed commit (a redelivery, a lost answer) is done, not
 * refused.
 */
export async function releaseApproved(deps: Deps, input: CoordinateInput, currentLabels: string[]): Promise<CoordinateResult> {
  const outcome = parseOutcomeArtifact(input.payload.comment?.body);
  if (outcome?.outcome !== "release_approved") return { outcome: "no_event" };
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

  const pr = await deps.getPullDetails(where.owner, where.repo, outcome.pr);
  if (pr.merged) {
    if (pr.headSha !== outcome.sha) return refuse(`#${outcome.pr} was merged at a commit the review didn't see (\`${pr.headSha.slice(0, 7)}\`).`);
  } else {
    try {
      await io.mergePull(where.owner, where.repo, outcome.pr, outcome.sha, outcome.merge_method);
    } catch (e) {
      // A lost answer (a timeout, a 5xx) can hide a merge that happened:
      // look again before calling it refused.
      const again = await deps.getPullDetails(where.owner, where.repo, outcome.pr).catch(() => null);
      if (!(again?.merged && again.headSha === outcome.sha)) {
        const why = e instanceof Error ? e.message : String(e);
        return refuse(`merging #${outcome.pr} at the reviewed commit (\`${outcome.sha.slice(0, 7)}\`) was refused. GitHub said: ${why.slice(0, 300)}`);
      }
    }
  }
  // The merge is the Worker's own: the after part runs first (the table's
  // release_merged rule fires release-publish and watches it), so a failed
  // comment can't leave a merged release with nothing watching it.
  const merged = await applyEvent(deps, input, EVENTS.RELEASE_MERGED, currentLabels);
  await io.commentOnIssue(
    where.owner,
    where.repo,
    input.issueNumber,
    `✅ The pre-publish review passed: merged #${outcome.pr} (${outcome.merge_method}). release-publish takes it from here: ` +
      `it waits for the repo's tag, posts the release note and merges back into \`dev\`. (Automatic, from the orchestrator.)`,
  );
  return merged;
}

/** Write access, as for a discussion reply (from-github.ts): the comment's
 * author association, or the Worker's own App bot. */
const TRUSTED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];
export async function trustedAuthor(deps: Deps, input: CoordinateInput): Promise<boolean> {
  const sender = input.payload.sender?.login;
  const bot = await deps.botLogin();
  if (bot && sender === bot) return true;
  return TRUSTED_ASSOCIATIONS.includes(input.payload.comment?.author_association ?? "");
}
