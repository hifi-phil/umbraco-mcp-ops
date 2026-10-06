// The Worker's front door, routed by Hono: the GitHub webhook (any other
// POST), the dashboard and its sign-in (dashboard/app.tsx), routine
// signals, and the e2e sandbox's log read and on-demand sweep. The webhook
// path is thin on purpose, same as issue-coordinator.ts: verifies the
// signature, parses the payload (webhook-parse.ts, unit tested), and
// forwards to the right DO instance. Covered by test/index.test.ts — a fake DurableObjectNamespace
// (idFromName/get as spies) is enough, no real Workers runtime needed.
// Covers: method/JSON validation, the signature-verification branch
// end-to-end (missing/wrong/correct/no-secret), routing to the correct
// DO key, and that distinct issues/repos always produce distinct keys.

import { IssueCoordinator } from "./issue-coordinator";
import { extractItemMeta, extractRoutingInfo, toWebhookPayload, verifySignature, type RoutingInfo } from "./webhook-parse";
import { openPullsForCommit } from "./github-client";
import type { CoordinateInput, RoutineSignalInput } from "./coordinate";

import { Scheduler } from "./scheduler";
import { Hono } from "hono";
import { dashboard } from "./dashboard/app";
import { upsertMeta } from "./db/items";
import * as transitions from "./db/transitions";

export { IssueCoordinator, Scheduler };

export type Env = {
  ISSUE_COORDINATOR: DurableObjectNamespace;
  // The one Scheduler DO (scheduler.ts): the reconciliation sweep's alarm.
  SCHEDULER?: DurableObjectNamespace;
  DB: D1Database;
  GITHUB_APP_TOKEN?: string; // local runs and tests only (github-client.ts)
  GITHUB_APP_ID?: string; // the Worker's GitHub App — see github-app.ts
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_API_BASE_URL?: string; // local smoke-testing seam — see github-client.ts
  GITHUB_WEBHOOK_SECRET?: string;
  // {"owner/repo": {"fireUrl", "token"}} — each repo's loop-dispatch routine.
  // See routines-client.ts.
  REPO_ROUTINES_JSON: string;
  // Auth for POST /routine-signal (see coordinate/routine-signal.ts's coordinateRoutineSignal
  // doc comment). Same permissive-when-unset shape as GITHUB_WEBHOOK_SECRET —
  // easy local dev, a real secret required once actually deployed.
  ROUTINE_SIGNAL_SECRET?: string;
  // GET /transitions: a read of the D1 log for one issue, so the e2e suite
  // can check what the Worker logged. Off unless LOG_READ_SECRET is set, and
  // only for the repos in LOG_READ_REPOS (comma-separated "owner/repo"):
  // tofu sets both for the e2e sandbox alone.
  LOG_READ_SECRET?: string;
  LOG_READ_REPOS?: string;
  // GET /status, the live-status dashboard (dashboard/app.tsx). Off unless set;
  // also the Bearer key for scripts.
  STATUS_SECRET?: string;
  // Its GitHub sign-in (auth.ts): the GitHub App's client ID and a client
  // secret, the session cookie's signing key, and the email domains let in.
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  SIGN_IN_DOMAINS?: string;
  // Read by the dashboard's repository page, to say what a repo's sweep does.
  SWEEP_MODE?: string;
  SWEEP_ENFORCE_REPOS?: string;
};

/** One DO per issue/PR. Lowercased: GitHub treats owner/repo names
 * case-insensitively, so a routine signal spelling the repo differently
 * from the webhook must still reach the same DO (and its watchdog). */
function doKey(owner: string, repo: string, issueNumber: number): string {
  return `${owner}/${repo}`.toLowerCase() + `#${issueNumber}`;
}

const app = new Hono<{ Bindings: Env }>();

// The dashboard first: its routes (and its POST /status/controls) aren't webhooks.
app.route("/", dashboard);
app.post("/sweep", (c) => handleSweep(c.req.raw, c.env));
app.get("/transitions", (c) => handleTransitions(c.req.raw, c.env, new URL(c.req.url)));
app.post("/routine-signal", (c) => handleRoutineSignal(c.req.raw, c.env));
// GitHub delivers webhooks to the Worker's root; any other POST is read as one.
app.post("*", (c) => answerInTime(handleWebhook(c.req.raw, c.env), c.executionCtx));
app.all("*", (c) => c.text("method not allowed", 405));

// A plain call (the tests) has no ExecutionContext; give it one that does nothing.
const noCtx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

export default {
  fetch: (request: Request, env: Env, ctx?: ExecutionContext) => app.fetch(request, env, ctx ?? noCtx),
};

export const ANSWER_WITHIN_MS = 8_000;

// GitHub drops a webhook it gets no answer to within 10 s, and never retries
// it (e2e #689, 05-10-2026). So answer by 8 s: the work's own answer if it's
// done, else 202 while it finishes in the background.
async function answerInTime(work: Promise<Response>, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
  const late = Response.json({ accepted: true }, { status: 202 });
  const res = await Promise.race([work, new Promise<Response>((r) => setTimeout(() => r(late), ANSWER_WITHIN_MS))]);
  if (res === late) ctx.waitUntil(work);
  return res;
}

/** A GitHub webhook: verify, parse, route to the issue's (or each PR's) DO. */
async function handleWebhook(request: Request, env: Env): Promise<Response> {
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

  await ensureScheduler(env);
  const routing = extractRoutingInfo(body) ?? (eventType === "check_suite" ? await routeByCommit(env, body) : null);
  if (!routing) return Response.json({ ok: true, dropped: "no routable issue/PR number" });

  await recordItem(env, routing, body);
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
}

export type { LogRow as TransitionLogRow } from "./db/transitions";

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
  return Response.json({ rows: await transitions.forIssue(env.DB, owner, repo, issue) });
}

/** The dashboard's items table (migrations/0006): an issue or PR's kind,
 * title and GitHub state, as this webhook gives them. Display only; never
 * fails the webhook. */
async function recordItem(env: Env, routing: NonNullable<RoutingInfo>, body: Record<string, unknown>): Promise<void> {
  const meta = routing.issueNumbers.length === 1 ? extractItemMeta(body) : null;
  if (!meta) return;
  try {
    await upsertMeta(env.DB, routing.owner, routing.repo, routing.issueNumbers[0]!, meta);
  } catch (e) {
    console.error("item write failed:", e instanceof Error ? e.message : e);
  }
}

const scheduler = (env: Env) => env.SCHEDULER!.get(env.SCHEDULER!.idFromName("scheduler"));

/** Every webhook re-arms the sweep's alarm if it's missing (scheduler.ts):
 * a chain that somehow broke restarts with the next GitHub event. Never
 * fails the webhook. */
async function ensureScheduler(env: Env): Promise<void> {
  if (!env.SCHEDULER) return;
  try {
    await scheduler(env).fetch("https://scheduler/ensure", { method: "POST" });
  } catch (e) {
    console.error("scheduler ensure failed:", e instanceof Error ? e.message : e);
  }
}

/** POST /sweep: an on-demand sweep for the e2e sandbox. The same key and
 * repo list as GET /transitions, so it's off for every other repo. */
async function handleSweep(request: Request, env: Env): Promise<Response> {
  if (!env.LOG_READ_SECRET || !env.SCHEDULER) return new Response("not found", { status: 404 });
  if (request.headers.get("Authorization") !== `Bearer ${env.LOG_READ_SECRET}`) return new Response("unauthorized", { status: 401 });
  const repos = (env.LOG_READ_REPOS ?? "").split(",").map((r) => r.trim()).filter(Boolean);
  return scheduler(env).fetch("https://scheduler/sweep", { method: "POST", body: JSON.stringify({ repos }) });
}

/**
 * GitHub sometimes sends a check_suite with an empty pull_requests (found by
 * e2e: with two CI runs per commit, the second suite's webhook came without
 * its PR, so the final red result never reached the PR and the watchdog
 * fired instead). Route it to the open PRs on its commit.
 */
async function routeByCommit(env: Env, body: Record<string, unknown>): Promise<RoutingInfo> {
  const repository = body.repository as { name?: string; owner?: { login?: string } } | undefined;
  const sha = (body.check_suite as { head_sha?: string } | undefined)?.head_sha;
  const owner = repository?.owner?.login;
  const repo = repository?.name;
  if (!owner || !repo || !sha) return null;
  const issueNumbers = await openPullsForCommit(env, owner, repo, sha);
  return issueNumbers.length > 0 ? { owner, repo, issueNumbers } : null;
}

/**
 * The direct routine-to-DO heartbeat channel (see coordinate/routine-signal.ts's
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
