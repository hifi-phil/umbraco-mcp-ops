// Turns a raw GitHub webhook delivery (headers + JSON body) into the
// routing info and WebhookPayload shape graph/'s translate() expects. Pure
// functions, tested with plain vitest — no live request/DO/crypto-context
// needed beyond what Node's global Web Crypto already provides.

import type { WebhookPayload } from "../../graph/github/from-github";

export type RoutingInfo = { owner: string; repo: string; issueNumbers: number[] } | null;

/**
 * translate() expects a single compound action string ("issues.labeled",
 * "pull_request.synchronize", ...), but GitHub splits that across the
 * X-GitHub-Event header (the resource type) and the body's own `action`
 * field (what happened to it). This recombines them.
 */
export function combineEventAction(eventType: string, action: string | undefined): string {
  return action ? `${eventType}.${action}` : eventType;
}

export function extractRoutingInfo(body: Record<string, unknown>): RoutingInfo {
  const repository = body.repository as { name?: string; owner?: { login?: string } } | undefined;
  const owner = repository?.owner?.login;
  const repo = repository?.name;
  const issue = body.issue as { number?: number } | undefined;
  const pullRequest = body.pull_request as { number?: number } | undefined;
  // A check_suite has no issue or pull_request key: its PRs (same-repo only,
  // possibly several) are listed under check_suite.pull_requests.
  const checkSuite = body.check_suite as { pull_requests?: Array<{ number?: number }> } | undefined;
  const single = issue?.number ?? pullRequest?.number;
  const issueNumbers =
    single !== undefined
      ? [single]
      : (checkSuite?.pull_requests ?? []).flatMap((pr) => (typeof pr.number === "number" ? [pr.number] : []));

  if (!owner || !repo || issueNumbers.length === 0) return null;
  return { owner, repo, issueNumbers };
}

export type ItemMeta = { kind: "issue" | "pr"; title: string | null; state: "open" | "closed" | "merged" | null };

/** What a webhook says about its one issue or PR, for the dashboard's
 * items table: an issue event's `issue` (a PR's comment arrives as an issue
 * with a `pull_request` key) or a PR event's `pull_request`. Null when it
 * names neither (a check_suite). */
export function extractItemMeta(body: Record<string, unknown>): ItemMeta | null {
  type Thing = { title?: unknown; state?: unknown; pull_request?: { merged_at?: unknown } | unknown; merged?: unknown; merged_at?: unknown };
  const pr = body.pull_request as Thing | undefined;
  const issue = body.issue as Thing | undefined;
  const thing = pr ?? issue;
  if (!thing || typeof thing !== "object") return null;
  const kind = pr || issue?.pull_request ? "pr" : "issue";
  const title = typeof thing.title === "string" ? thing.title.slice(0, 300) : null;
  // A PR event says `merged`; a PR seen through the issues API (a comment,
  // or a lookup) carries it as pull_request.merged_at.
  const prMergedAt = issue?.pull_request && typeof issue.pull_request === "object" ? (issue.pull_request as { merged_at?: unknown }).merged_at : undefined;
  const merged =
    thing.merged === true || (typeof thing.merged_at === "string" && thing.merged_at !== "") || (typeof prMergedAt === "string" && prMergedAt !== "");
  const state = merged ? "merged" : thing.state === "open" || thing.state === "closed" ? thing.state : null;
  return { kind, title, state };
}

export function toWebhookPayload(body: Record<string, unknown>, eventType: string): WebhookPayload {
  const sender = body.sender as { login?: string; type?: "Bot" | "User" } | undefined;
  const label = body.label as { name?: string } | undefined;
  const comment = body.comment as
    | { body?: string; author_association?: string; user?: { type?: "Bot" | "User" } }
    | undefined;
  const issue = body.issue as { state?: "open" | "closed"; pull_request?: unknown } | undefined;
  const review = body.review as { state?: "approved" | "changes_requested" | "commented" } | undefined;
  const pullRequest = body.pull_request as { merged?: boolean } | undefined;
  const checkSuite = body.check_suite as
    | { conclusion?: "success" | "failure" | null; status?: "completed" | "in_progress" }
    | undefined;

  return {
    action: combineEventAction(eventType, body.action as string | undefined),
    sender: sender?.login ? { login: sender.login, type: sender.type ?? "User" } : undefined,
    label: label?.name ? { name: label.name } : undefined,
    comment:
      comment?.body !== undefined
        ? { body: comment.body, author_association: comment.author_association, user_type: comment.user?.type }
        : undefined,
    // GitHub sends PR conversation comments as issue_comment too; only a PR
    // "issue" carries a pull_request key.
    issue: issue ? { state: issue.state, is_pr: issue.pull_request !== undefined } : undefined,
    review: review?.state ? { state: review.state } : undefined,
    pull_request: pullRequest ? { merged: pullRequest.merged } : undefined,
    check_suite: checkSuite
      ? { conclusion: checkSuite.conclusion ?? null, status: checkSuite.status ?? "completed" }
      : undefined,
  };
}

/**
 * GitHub signs the raw request body with HMAC-SHA256 using the webhook
 * secret, sent as `X-Hub-Signature-256: sha256=<hex>`. Constant-time
 * compare via XOR-accumulation rather than `===`, so a partial match
 * can't be timed to guess the signature byte by byte.
 */
export async function verifySignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!signatureHeader) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected =
    "sha256=" +
    [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");

  if (expected.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }
  return diff === 0;
}
