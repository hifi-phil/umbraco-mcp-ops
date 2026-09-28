// Turns a raw GitHub webhook delivery (headers + JSON body) into the
// routing info and WebhookPayload shape graph/'s translate() expects. Pure
// functions, tested with plain vitest — no live request/DO/crypto-context
// needed beyond what Node's global Web Crypto already provides.

import type { WebhookPayload } from "../../graph/github/from-github";

export type RoutingInfo = { owner: string; repo: string; issueNumber: number } | null;

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
  const issueNumber = issue?.number ?? pullRequest?.number;

  if (!owner || !repo || issueNumber === undefined) return null;
  return { owner, repo, issueNumber };
}

export function toWebhookPayload(body: Record<string, unknown>, eventType: string): WebhookPayload {
  const sender = body.sender as { login?: string; type?: "Bot" | "User" } | undefined;
  const label = body.label as { name?: string } | undefined;
  const comment = body.comment as { body?: string } | undefined;
  const review = body.review as { state?: "approved" | "changes_requested" | "commented" } | undefined;
  const pullRequest = body.pull_request as { merged?: boolean } | undefined;
  const checkSuite = body.check_suite as
    | { conclusion?: "success" | "failure" | null; status?: "completed" | "in_progress" }
    | undefined;

  return {
    action: combineEventAction(eventType, body.action as string | undefined),
    sender: sender?.login ? { login: sender.login, type: sender.type ?? "User" } : undefined,
    label: label?.name ? { name: label.name } : undefined,
    comment: comment?.body !== undefined ? { body: comment.body } : undefined,
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
