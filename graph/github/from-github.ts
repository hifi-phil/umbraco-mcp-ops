// Turns a raw GitHub webhook payload into zero or one domain Event.
// This is the piece that was missing from the original design entirely —
// see 03-components.md §3.0. Every case here is grounded in a real label
// or event from loop-dispatch's actual routing table (route-event.sh) and
// the loop skills it fires, not invented.
//
// The label names matched below come from constants/labels.ts's LABELS
// constant, not retyped strings — so a rename there (see
// 10-label-rename.md) propagates here automatically instead of silently
// drifting out of sync. They're the PROPOSED renamed labels, not today's
// exact live spelling (ready-for-ai, auto-release, ai-discuss, auto-rework,
// auto-merge). Real webhooks won't carry these strings until that
// migration actually renames the labels; this is written against the
// target, on the same "no infrastructure yet" basis as the rest of Phase 2.
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

export const BOT_LOGIN = "umbraco-mcp-ops[bot]"; // placeholder — set to the real GitHub App login
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
  comment?: { body: string };
  review?: { state: "approved" | "changes_requested" | "commented" };
  pull_request?: { merged?: boolean };
  check_suite?: { conclusion: "success" | "failure" | null; status: "completed" | "in_progress" };
};

function isOwnBot(sender: WebhookPayload["sender"]): boolean {
  return sender?.login === BOT_LOGIN;
}

function hasOwnSignatureMarker(body: string | undefined): boolean {
  return !!body && body.includes(COMMENT_SIGNATURE);
}

// STUB — real aggregation needs the full check-run list for the SHA (github-ops
// → "Get PR CI / check-run status"), not just the one check_suite payload that
// triggered this webhook. This is the honest placeholder Phase 2 leaves for
// whoever wires this against a real GitHub client.
function allRequiredChecksComplete(_payload: WebhookPayload): boolean {
  return _payload.check_suite?.status === "completed";
}
function allRequiredChecksPassed(payload: WebhookPayload): boolean {
  return payload.check_suite?.conclusion === "success";
}

export function translate(payload: WebhookPayload): Event | null {
  switch (payload.action) {
    case "issues.labeled":
      // Self-trigger guard, identity case — see 03-components.md §3.3.
      // Scoped to label webhooks specifically: a self-authored label write
      // is the actual risk here. Applying this identity check to every
      // payload (as an earlier version of this function did) would also
      // swallow a loop's own outcome comments below, since loops post
      // under the same bot identity — that's not a self-trigger to guard
      // against, it's the fact we want to read.
      if (isOwnBot(payload.sender)) return null;
      switch (payload.label?.name) {
        case LABELS.AI_READY:
          return EVENTS.LABELLED_AI_READY;
        case LABELS.AUTO_RELEASING:
          return EVENTS.LABELLED_AUTO_RELEASING;
        case LABELS.AI_DISCUSSING:
          return EVENTS.LABELLED_AI_DISCUSSING;
        default:
          return null;
      }

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

      // No rule in ../graph.ts has an outbound transition from
      // "ai-discussing" — it's a human-owned level-state by design — so a
      // plain comment never needs to become a domain event here.
      // loop-dispatch's existing router still fires issue-discuss-loop
      // directly; this reducer simply has no opinion on that state.
      return null;
    }

    case "pull_request.labeled":
      // Self-trigger guard, identity case — see the issues.labeled case above.
      if (isOwnBot(payload.sender)) return null;
      switch (payload.label?.name) {
        case LABELS.AUTO_REWORKING:
          return EVENTS.LABELLED_AUTO_REWORKING;
        case LABELS.AUTO_MERGING:
          return EVENTS.LABELLED_AUTO_MERGING;
        default:
          return null;
      }

    // rework-loop pushing a fix is a native, independently-observable
    // event — GitHub fires this the moment a PR's head branch gets a new
    // commit, regardless of who or what pushed it. No self-report needed,
    // no outcome artifact, no loop change: rework-loop already pushes in
    // its own Step 4; this just reads the webhook that action already
    // produces. reduce() only acts on it when the PR is currently in
    // auto-reworking state, so this can map unconditionally — same
    // pattern as the label cases above.
    case "pull_request.synchronize":
      return EVENTS.REWORK_PUSHED;

    case "check_suite.completed":
      if (!allRequiredChecksComplete(payload)) return null;
      // NOTE: this table has no rule consuming a bare checks_passed/failed
      // event today — issue-build-loop drives CI green itself, inline, as
      // part of "build_succeeded"/"build_blocked" (see ../graph.ts). Kept
      // here as the aggregation point once/if CI-driving moves out of the
      // loop and into something the reducer watches directly.
      return null;

    case "pull_request.closed":
      if (payload.pull_request?.merged) return EVENTS.MERGED;
      return null;

    default:
      return null;
  }
}
