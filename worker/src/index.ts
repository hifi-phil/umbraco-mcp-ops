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
  // {"owner/repo": {"fireUrl", "token"}} — each repo's loop-dispatch routine.
  // See routines-client.ts.
  REPO_ROUTINES_JSON: string;
  // Auth for POST /routine-signal (see coordinate.ts's coordinateRoutineSignal
  // doc comment). Same permissive-when-unset shape as GITHUB_WEBHOOK_SECRET —
  // easy local dev, a real secret required once actually deployed.
  ROUTINE_SIGNAL_SECRET?: string;
  // GET /transitions: a read of the D1 log for one issue, so the e2e suite
  // can check what the Worker logged. Off unless LOG_READ_SECRET is set, and
  // only for the repos in LOG_READ_REPOS (comma-separated "owner/repo"):
  // tofu sets both for the e2e sandbox alone.
  LOG_READ_SECRET?: string;
  LOG_READ_REPOS?: string;
};

/** One DO per issue/PR. Lowercased: GitHub treats owner/repo names
 * case-insensitively, so a routine signal spelling the repo differently
 * from the webhook must still reach the same DO (and its watchdog). */
function doKey(owner: string, repo: string, issueNumber: number): string {
  return `${owner}/${repo}`.toLowerCase() + `#${issueNumber}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/transitions") return handleTransitions(request, env, url);
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

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

    const payload = toWebhookPayload(body, eventType);
    const forward = (issueNumber: number) => {
      const input: CoordinateInput = { deliveryId, owner: routing.owner, repo: routing.repo, issueNumber, payload };
      const id = env.ISSUE_COORDINATOR.idFromName(doKey(routing.owner, routing.repo, issueNumber));
      return env.ISSUE_COORDINATOR.get(id).fetch("https://issue-coordinator/", {
        method: "POST",
        body: JSON.stringify(input),
      });
    };

    const [only, ...more] = routing.issueNumbers;
    if (more.length === 0) return forward(only!);

    // A check_suite on a commit several PRs share: each PR's DO decides for
    // itself. Any failure fails the delivery so it can be redelivered, and
    // each DO's own dedupe makes the redelivery safe for the ones that passed.
    const results = [];
    for (const issueNumber of routing.issueNumbers) {
      const res = await forward(issueNumber);
      results.push({ issueNumber, status: res.status, body: await res.json().catch(() => null) });
    }
    const failed = results.some((r) => r.status >= 400);
    return Response.json({ routed: results }, { status: failed ? 500 : 200 });
  },
};

export type TransitionLogRow = {
  id: number;
  delivery_id: string | null;
  from_state: string;
  event: string;
  to_effect: string | null;
  run: string | null;
  dropped_reason: string | null;
  mode: string;
  created_at: string;
};

/** One issue's transition rows, oldest first. Read-only, and refused for
 * any repo not named in LOG_READ_REPOS. */
async function handleTransitions(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.LOG_READ_SECRET) return new Response("not found", { status: 404 });
  if (request.headers.get("Authorization") !== `Bearer ${env.LOG_READ_SECRET}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const owner = url.searchParams.get("owner") ?? "";
  const repo = url.searchParams.get("repo") ?? "";
  const issue = Number(url.searchParams.get("issue"));
  if (!owner || !repo || !Number.isInteger(issue) || issue <= 0) {
    return new Response("owner, repo and issue are required", { status: 400 });
  }
  const allowed = (env.LOG_READ_REPOS ?? "")
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.includes(`${owner}/${repo}`.toLowerCase())) {
    return new Response(`the log isn't readable for ${owner}/${repo}`, { status: 403 });
  }
  const { results } = await env.DB.prepare(
    `SELECT id, delivery_id, from_state, event, to_effect, run, dropped_reason, mode, created_at
       FROM transitions
      WHERE LOWER(owner) = LOWER(?) AND LOWER(repo) = LOWER(?) AND issue_number = ?
      ORDER BY id`,
  )
    .bind(owner, repo, issue)
    .all<TransitionLogRow>();
  return Response.json({ rows: results });
}

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

  const id = env.ISSUE_COORDINATOR.idFromName(doKey(input.owner, input.repo, input.signal.issue));
  const stub = env.ISSUE_COORDINATOR.get(id);
  return stub.fetch("https://issue-coordinator/routine-signal", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
