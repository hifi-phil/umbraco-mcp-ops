// The webhook receiver — the front door GitHub actually talks to. Thin on
// purpose, same as issue-coordinator.ts: verifies the signature, parses
// the payload (webhook-parse.ts, unit tested), and forwards to the right
// DO instance. Not covered by these tests — see issue-coordinator.ts's
// header for what `wrangler dev --local` did and didn't verify instead.

import { IssueCoordinator } from "./issue-coordinator";
import { extractRoutingInfo, toWebhookPayload, verifySignature } from "./webhook-parse";
import type { CoordinateInput } from "./coordinate";

export { IssueCoordinator };

export type Env = {
  ISSUE_COORDINATOR: DurableObjectNamespace;
  DB: D1Database;
  GITHUB_APP_TOKEN: string;
  GITHUB_API_BASE_URL?: string; // local smoke-testing seam — see github-client.ts
  GITHUB_WEBHOOK_SECRET?: string;
  CLAUDE_API_KEY: string;
  CLAUDE_API_BASE_URL?: string; // local smoke-testing seam — see routines-client.ts
  ROUTINE_IDS_JSON: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

    const rawBody = await request.text();

    if (env.GITHUB_WEBHOOK_SECRET) {
      const signature = request.headers.get("X-Hub-Signature-256");
      if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, rawBody, signature))) {
        return new Response("invalid signature", { status: 401 });
      }
    }

    const eventType = request.headers.get("X-GitHub-Event");
    if (!eventType) return new Response("missing X-GitHub-Event header", { status: 400 });
    const deliveryId = request.headers.get("X-GitHub-Delivery") ?? "";

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return new Response("invalid JSON body", { status: 400 });
    }

    const routing = extractRoutingInfo(body);
    if (!routing) return Response.json({ ok: true, dropped: "no routable issue/PR number" });

    const input: CoordinateInput = {
      deliveryId,
      owner: routing.owner,
      repo: routing.repo,
      issueNumber: routing.issueNumber,
      payload: toWebhookPayload(body, eventType),
    };

    const id = env.ISSUE_COORDINATOR.idFromName(`${routing.owner}/${routing.repo}#${routing.issueNumber}`);
    const stub = env.ISSUE_COORDINATOR.get(id);
    return stub.fetch("https://issue-coordinator/", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
};
