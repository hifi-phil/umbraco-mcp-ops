// The webhook receiver — the front door GitHub actually talks to. Thin on
// purpose, same as issue-coordinator.ts: verifies the signature, parses
// the payload (webhook-parse.ts, unit tested), and forwards to the right
// DO instance. Covered by test/index.test.ts — a fake DurableObjectNamespace
// (idFromName/get as spies) is enough, no real Workers runtime needed.
// Covers: method/JSON validation, the signature-verification branch
// end-to-end (missing/wrong/correct/no-secret), routing to the correct
// DO key, and that distinct issues/repos always produce distinct keys.

import { IssueCoordinator } from "./issue-coordinator";
import { extractRoutingInfo, toWebhookPayload, verifySignature } from "./webhook-parse";
import type { CoordinateInput, RoutineSignalInput } from "./coordinate";

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
  // Auth for POST /routine-signal (see coordinate.ts's coordinateRoutineSignal
  // doc comment). Same permissive-when-unset shape as GITHUB_WEBHOOK_SECRET —
  // easy local dev, a real secret required once actually deployed.
  ROUTINE_SIGNAL_SECRET?: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

    const url = new URL(request.url);
    if (url.pathname === "/routine-signal") {
      return handleRoutineSignal(request, env);
    }

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

/**
 * The direct routine-to-DO heartbeat channel (see coordinate.ts's
 * coordinateRoutineSignal). Not a GitHub webhook — no X-GitHub-Event, no
 * HMAC signature; a bearer secret instead, since this is a routine
 * calling in directly, not GitHub delivering a signed payload.
 */
async function handleRoutineSignal(request: Request, env: Env): Promise<Response> {
  if (env.ROUTINE_SIGNAL_SECRET) {
    const auth = request.headers.get("Authorization");
    if (auth !== `Bearer ${env.ROUTINE_SIGNAL_SECRET}`) {
      return new Response("unauthorized", { status: 401 });
    }
  }

  let input: RoutineSignalInput;
  try {
    input = await request.json();
  } catch {
    return new Response("invalid JSON body", { status: 400 });
  }
  if (!input.owner || !input.repo || !input.signal) {
    return new Response("owner, repo, and signal are required", { status: 400 });
  }

  const id = env.ISSUE_COORDINATOR.idFromName(`${input.owner}/${input.repo}#${input.signal.issue}`);
  const stub = env.ISSUE_COORDINATOR.get(id);
  return stub.fetch("https://issue-coordinator/routine-signal", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
