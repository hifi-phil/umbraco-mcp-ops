// Turns a raw GitHub webhook payload into zero or one domain Event.
// This is the piece that was missing from the original design entirely —
// see 03-components.md §3.0. Every case here is grounded in a real label
// or event from loop-dispatch's actual routing table (route-event.sh) and
// the loop skills it fires, not invented.
//
// The label names matched below come from labels.ts's LABELS constant, not
// retyped strings — so a rename there (see 10-label-rename.md) propagates
// here automatically instead of silently drifting out of sync. They're the
// PROPOSED renamed labels, not today's exact live spelling (ready-for-ai,
// auto-release, ai-discuss, auto-rework, auto-merge). Real webhooks won't
// carry these strings until that migration actually renames the labels;
// this is written against the target, on the same "no infrastructure yet"
// basis as the rest of Phase 2.
//
// Deliberately absent: build_succeeded, build_blocked, release_blocked,
// release_published, rework_pushed, merge_gate_failed_*. Today those facts
// only exist as an agent's self-report (the exact anti-pattern Phase 5 in
// 07-build-phases.md exists to remove) — there's no structured, verifiable
// GitHub artifact yet for translate() to read. Wiring those cases in is
// what Phase 5 actually is: define the outcome artifact each loop writes,
// then add the case here that reads it.

import type { Event } from "./graph";
import { LABELS } from "./labels";

export const BOT_LOGIN = "umbraco-mcp-ops[bot]"; // placeholder — set to the real GitHub App login
export const COMMENT_SIGNATURE = "<!-- issue-discuss-loop -->"; // real marker, from issue-discuss-loop's SKILL.md

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
  // Self-trigger guard, identity case — see 03-components.md §3.3.
  if (isOwnBot(payload.sender)) return null;

  switch (payload.action) {
    case "issues.labeled":
      switch (payload.label?.name) {
        case LABELS.AI_READY:
          return "labelled_ai_ready";
        case LABELS.AUTO_RELEASING:
          return "labelled_auto_releasing";
        case LABELS.AI_DISCUSSING:
          return "labelled_ai_discussing";
        default:
          return null;
      }

    case "issue_comment.created":
      // Self-trigger guard, content-marker case — see 03-components.md §3.3.
      // issue-discuss-loop posts as the maintainer's own account on purpose,
      // so identity filtering (above) can't catch its own comments; the
      // signed marker is the only thing that does.
      if (hasOwnSignatureMarker(payload.comment?.body)) return null;
      // No rule in graph.ts has an outbound transition from "ai-discussing" —
      // it's a human-owned level-state by design (see graph.ts) — so a plain
      // comment never needs to become a domain event here. loop-dispatch's
      // existing router still fires issue-discuss-loop directly; this
      // reducer simply has no opinion on that state.
      return null;

    case "pull_request.labeled":
      switch (payload.label?.name) {
        case LABELS.AUTO_REWORKING:
          return "labelled_auto_reworking";
        case LABELS.AUTO_MERGING:
          return "labelled_auto_merging";
        default:
          return null;
      }

    case "check_suite.completed":
      if (!allRequiredChecksComplete(payload)) return null;
      // NOTE: this table has no rule consuming a bare checks_passed/failed
      // event today — issue-build-loop drives CI green itself, inline, as
      // part of "build_succeeded"/"build_blocked" (see graph.ts). Kept here
      // as the aggregation point once/if CI-driving moves out of the loop
      // and into something the reducer watches directly.
      return null;

    case "pull_request.closed":
      if (payload.pull_request?.merged) return "merged";
      return null;

    default:
      return null;
  }
}
