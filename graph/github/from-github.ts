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
// build_succeeded/build_blocked are sourced from issue-build-loop's
// structured outcome comment (see 11-outcome-artifact.md) — the first two
// of six events that used to be "deliberately absent" here because the
// fact only existed as an agent's self-report. Still absent for the same
// reason: release_blocked, release_published, rework_pushed,
// merge_gate_failed_*. Wiring each of those in is the same shape of work —
// define the artifact that loop writes, add the case here that reads it.

import { EVENTS, type Event } from "../constants/events";
import { LABELS } from "../constants/labels";
import { ROUTINES } from "../constants/routines";
import { parseBuildOutcomeShape } from "../outcomes";

export const BOT_LOGIN = "umbraco-mcp-ops[bot]"; // placeholder — set to the real GitHub App login
export const COMMENT_SIGNATURE = "<!-- issue-discuss-loop -->"; // real marker, from issue-discuss-loop's SKILL.md

// The structured outcome artifact issue-build-loop writes instead of only
// self-reporting via its own label swap — see 11-outcome-artifact.md for
// the full spec and why the loop still does the label swap too (additive,
// not a replacement, until something real reads this and owns the swap
// instead). Marker is per-routine so a future loop's artifact can't be
// mistaken for this one.
export const OUTCOME_MARKER = `<!-- agent-outcome:${ROUTINES.ISSUE_BUILD_LOOP} -->`;

// Transport-specific: extracting JSON out of a comment body. The shape
// itself (what counts as a valid build_succeeded/build_blocked) is shared
// with the direct-signal transport in routines/from-routine.ts — see
// ../outcomes.ts — so the two can't validate against two different ideas
// of "valid" as the catalog grows.
function parseBuildOutcome(body: string | undefined) {
  if (!body || !body.includes(OUTCOME_MARKER)) return null;
  const match = body.match(/```json\s*([\s\S]*?)\s*```/);
  if (!match) return null;
  try {
    return parseBuildOutcomeShape(JSON.parse(match[1]!));
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
      // swallow issue-build-loop's own outcome comments below, since loops
      // post under the same bot identity — that's not a self-trigger to
      // guard against, it's the fact we want to read.
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

      // issue-build-loop's structured outcome artifact — see 11-outcome-
      // artifact.md. Deliberately not identity-guarded: this comment is
      // posted under the same bot identity a future reducer would use, but
      // it's the loop's own new fact, not an echo of anything we wrote.
      const outcome = parseBuildOutcome(payload.comment?.body);
      if (outcome) {
        return outcome.outcome === "build_succeeded"
          ? EVENTS.BUILD_SUCCEEDED
          : EVENTS.BUILD_BLOCKED;
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
