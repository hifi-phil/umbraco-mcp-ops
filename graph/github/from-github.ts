// Turns a raw GitHub webhook payload into zero or one domain Event.
// This is the piece that was missing from the original design entirely —
// see 03-components.md §3.0. Every case here is grounded in a real label
// or event from loop-dispatch's actual routing table (route-event.sh) and
// the loop skills it fires, not invented.
//
// The label names matched below come from constants/labels.ts's LABELS
// constant, not retyped strings — so a rename there (see
// 10-label-rename.md) propagates here automatically instead of silently
// drifting out of sync. They're today's live spelling; the proposed
// rename is deferred until the basic lane works.
//
// build_succeeded/build_blocked/release_blocked/release_published are
// sourced from a loop's structured outcome comment (see
// 11-outcome-artifact.md) — four of six events that used to be
// "deliberately absent" here because the fact only existed as an agent's
// self-report. rework_pushed is NOT in that family, on purpose: a git push
// is a native, independently-observable GitHub event
// (pull_request.synchronize) — sourcing it from a self-reported comment
// would be a downgrade from what's already true today, not an upgrade.
// merge_gate_failed_* are still absent for a different reason: their
// deterministic source is a live re-check of CI/approval/conflict state
// (the same checks merge-flow itself runs), not something a comment can
// carry — that's the same category as the CI-aggregation stub below, not
// an outcome artifact.

import { EVENTS, type Event } from "../constants/events";
import { LABELS } from "../constants/labels";
import { parseOutcomeShape } from "../outcomes";

export const BOT_LOGIN = "umbraco-mcp-ops[bot]"; // the default; the Worker passes its GitHub App's real login to translate()
export const COMMENT_SIGNATURE = "<!-- issue-discuss-loop -->"; // real marker, from issue-discuss-loop's SKILL.md

// Matches any loop's outcome marker (plugins/agent-outcomes's format),
// regardless of which routine wrote it — the outcome name inside the JSON
// is what decides the Event, not the marker's routine name, so this
// doesn't need to special-case each loop.
const OUTCOME_MARKER_PATTERN = /<!-- agent-outcome:[a-zA-Z0-9_-]+ -->/;

// Transport-specific: extracting JSON out of a comment body. The shape
// itself (what counts as a valid outcome) is shared with the direct-signal
// transport in routines/from-routine.ts — see ../outcomes.ts — so the two
// can't validate against two different ideas of "valid" as the catalog
// grows.
function parseOutcomeArtifact(body: string | undefined) {
  if (!body || !OUTCOME_MARKER_PATTERN.test(body)) return null;
  const match = body.match(/```json\s*([\s\S]*?)\s*```/);
  if (!match) return null;
  try {
    return parseOutcomeShape(JSON.parse(match[1]!));
  } catch {
    return null;
  }
}

export type WebhookPayload = {
  action: string;
  sender?: { login: string; type: "Bot" | "User" };
  label?: { name: string };
  comment?: { body: string; author_association?: string; user_type?: "Bot" | "User" };
  issue?: { state?: "open" | "closed"; is_pr?: boolean };
  review?: { state: "approved" | "changes_requested" | "commented" };
  pull_request?: { merged?: boolean };
  check_suite?: { conclusion: "success" | "failure" | null; status: "completed" | "in_progress" };
};

function isOwnBot(sender: WebhookPayload["sender"], botLogin: string): boolean {
  return sender?.login === botLogin;
}

function hasOwnSignatureMarker(body: string | undefined): boolean {
  return !!body && body.includes(COMMENT_SIGNATURE);
}

// loop-dispatch's discussion-round gates 2–7 (route-event.sh's
// issue_comment case), all fail-closed. Gate 1, "the issue carries
// ai-discuss", is the reducer's: DISCUSSION_REPLY only has a rule from
// that state. The self-marker gate (2) is checked by the caller first.
const TRUSTED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];
function isDiscussionReply(payload: WebhookPayload): boolean {
  const c = payload.comment;
  return (
    !!c &&
    !c.body.trimStart().startsWith("//") &&
    TRUSTED_ASSOCIATIONS.includes(c.author_association ?? "") &&
    c.user_type === "User" &&
    payload.issue?.state === "open" &&
    payload.issue.is_pr === false
  );
}

/**
 * `botLogin` is the orchestrator's own GitHub identity (its App's
 * `<slug>[bot]`): label changes it made come back as webhooks and are
 * dropped here, the self-trigger guard. The Worker passes its App's login;
 * without one, BOT_LOGIN (a login no one has) means nothing is dropped.
 */
export function translate(payload: WebhookPayload, { botLogin = BOT_LOGIN }: { botLogin?: string } = {}): Event | null {
  switch (payload.action) {
    case "issues.labeled":
      // Self-trigger guard, identity case — see 03-components.md §3.3.
      // Scoped to label webhooks specifically: a self-authored label write
      // is the actual risk here. Applying this identity check to every
      // payload (as an earlier version of this function did) would also
      // swallow a loop's own outcome comments below, since loops post
      // under the same bot identity — that's not a self-trigger to guard
      // against, it's the fact we want to read.
      if (isOwnBot(payload.sender, botLogin)) return null;
      switch (payload.label?.name) {
        case LABELS.AI_READY:
          return EVENTS.LABELLED_AI_READY;
        case LABELS.AUTO_RELEASING:
          return EVENTS.LABELLED_AUTO_RELEASING;
        case LABELS.AI_DISCUSSING:
          return EVENTS.LABELLED_AI_DISCUSSING;
        // issue-build-loop's own Step 3 swap. The same fact its outcome
        // comment carries, but native and reliably present (the comment
        // wasn't, in shadow run 1). Also how a late build leaves ai-stuck.
        case LABELS.AI_GENERATED:
          return EVENTS.BUILD_SUCCEEDED;
        case LABELS.AI_BLOCKED:
          return EVENTS.BUILD_BLOCKED;
        default:
          return null;
      }

    case "issues.unlabeled":
      if (isOwnBot(payload.sender, botLogin)) return null;
      switch (payload.label?.name) {
        case LABELS.AI_READY:
          return EVENTS.UNLABELLED_AI_READY;
        case LABELS.AUTO_RELEASING:
          return EVENTS.UNLABELLED_AUTO_RELEASING;
        default:
          return null;
      }

    case "issues.closed":
      return EVENTS.ISSUE_CLOSED;

    case "issue_comment.created": {
      // Self-trigger guard, content-marker case — see 03-components.md §3.3.
      // issue-discuss-loop posts as the maintainer's own account on purpose,
      // so identity filtering (above) can't catch its own comments; the
      // signed marker is the only thing that does.
      if (hasOwnSignatureMarker(payload.comment?.body)) return null;

      // A loop's structured outcome artifact — see 11-outcome-artifact.md.
      // Deliberately not identity-guarded: this comment is posted under
      // the same bot identity a future reducer would use, but it's the
      // loop's own new fact, not an echo of anything we wrote.
      const outcome = parseOutcomeArtifact(payload.comment?.body);
      if (outcome) {
        switch (outcome.outcome) {
          case "build_succeeded":
            return EVENTS.BUILD_SUCCEEDED;
          case "build_blocked":
            return EVENTS.BUILD_BLOCKED;
          case "release_blocked":
            return EVENTS.RELEASE_BLOCKED;
          case "release_published":
            return EVENTS.RELEASE_PUBLISHED;
        }
      }

      // A discussion round. Whether the issue is actually in ai-discuss is
      // the reducer's call (see isDiscussionReply above).
      if (isDiscussionReply(payload)) return EVENTS.DISCUSSION_REPLY;
      return null;
    }

    case "pull_request.labeled":
      // Self-trigger guard, identity case — see the issues.labeled case above.
      if (isOwnBot(payload.sender, botLogin)) return null;
      switch (payload.label?.name) {
        case LABELS.AUTO_REWORKING:
          return EVENTS.LABELLED_AUTO_REWORKING;
        case LABELS.AUTO_MERGING:
          return EVENTS.LABELLED_AUTO_MERGING;
        default:
          return null;
      }

    case "pull_request.unlabeled":
      if (isOwnBot(payload.sender, botLogin)) return null;
      switch (payload.label?.name) {
        case LABELS.AUTO_REWORKING:
          return EVENTS.UNLABELLED_AUTO_REWORKING;
        case LABELS.AUTO_MERGING:
          return EVENTS.UNLABELLED_AUTO_MERGING;
        default:
          return null;
      }

    // rework-loop pushing a fix is a native, independently-observable
    // event — GitHub fires this the moment a PR's head branch gets a new
    // commit, regardless of who or what pushed it. No self-report needed,
    // no outcome artifact, no loop change: rework-loop already pushes in
    // its own Step 4; this just reads the webhook that action already
    // produces. Every push maps here; reduce() only acts on it when the PR
    // is in auto-rework, and elsewhere it's a CONTEXTUAL_EVENT that the
    // coordinator ignores without logging (see graph.ts).
    case "pull_request.synchronize":
      return EVENTS.REWORK_PUSHED;

    // check_suite.completed is deliberately absent here, not a gap: deciding
    // MERGE_GATE_FAILED_SOFT/HARD needs facts this pure function structurally
    // can't have (the full check-run list for the SHA, review state,
    // mergeability — not just this one payload) — that's I/O. Falls to
    // `default` below; worker/src/coordinate.ts's coordinateWebhook
    // intercepts this action BEFORE translate() is ever called for it, and
    // does the real, independently-fetched aggregation itself — see
    // graph/github/merge-gate.ts.

    case "pull_request.closed":
      if (payload.pull_request?.merged) return EVENTS.MERGED;
      return null;

    default:
      return null;
  }
}
