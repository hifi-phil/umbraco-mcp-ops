// The stub agent: the e2e sandbox's Fire URL. The orchestrator Worker fires
// it exactly as it fires a real loop-dispatch routine (same body, same
// bearer token), and the stub does what that loop does in orchestrated
// mode, through the GitHub API, with no LLM (see loops.ts). What it does is
// scripted by the issue's or PR's hint, `<!-- e2e: <hint> -->`. See
// docs/agent-orchestration/14-e2e-testing.md.
//
// Two routes:
// - POST /         a fire from the orchestrator (bearer FIRE_TOKEN)
// - POST /webhook  the sandbox's check_suite webhook (HMAC HOOK_SECRET),
//                  signature-checked and ignored (see handleWebhook)
//
// Only the sandbox repo (E2E_REPO) is ever acted on, whatever a request says.

import { act, mergeIfGreen, type Fire, type Gh, type LogWriter, type Signal } from "./loops";
import { forgetInstallationToken, installationToken } from "../../../worker/src/github-app";
import type { LABELS } from "@orchestrator/graph/constants/labels"; // for the {@link LABELS.…} references in its doc comments

export { outcomeComment, type Action, type Fire, type Gh, type Signal } from "./loops";

export type StubEnv = {
  FIRE_TOKEN: string;
  HOOK_SECRET: string;
  E2E_REPO: string;
  // The orchestrator, for heartbeat and completion signals: a service
  // binding, since a Worker can't fetch another on the same workers.dev.
  ORCHESTRATOR: { fetch: (input: string, init?: RequestInit) => Promise<Response> };
  ROUTINE_SIGNAL_SECRET: string;
  // The orchestrator's GitHub App: every GitHub call the stub makes goes as
  // its bot (installed on the sandbox, with Contents, Issues and Pull
  // requests write). Also a different identity from the driver, who opens
  // the scenarios' PRs, so it can review them (POST /review).
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
};

export function routineSignal(env: StubEnv, owner: string, repo: string): Signal {
  return async (signal) => {
    const res = await env.ORCHESTRATOR.fetch("https://orchestrator/routine-signal", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.ROUTINE_SIGNAL_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ owner, repo, signal }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`routine-signal failed: ${res.status} ${text}`);
    return text;
  };
}

/** A real routine takes seconds to start. Acting at once would let the
 * outcome's webhook reach the orchestrator before its fire call returns,
 * a race real traffic never produces. */
export const STUB_DELAY_MS = 2000;

/** The `route=… repo=… number=…` line from routines-client.ts's dispatchText. */
export function parseFire(text: string): Fire | null {
  const m = text.match(/route=([\w-]+) repo=([\w.-]+)\/([\w.-]+) number=(\d+)/);
  if (!m) return null;
  const logToken = text.match(/log_token=([\w-]+\.[\w-]+)/)?.[1];
  return { route: m[1]!, owner: m[2]!, repo: m[3]!, number: Number(m[4]), ...(logToken ? { logToken } : {}) };
}

/** The work log's POST /log, with the fire's token (work-log.ts). */
export function logWriter(env: StubEnv, token: string): LogWriter {
  return async (entry) => {
    const res = await env.ORCHESTRATOR.fetch("https://orchestrator/log", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
    if (!res.ok) throw new Error(`log failed: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { id: number }).id;
  };
}

export function parseHint(body: string | null | undefined): string | null {
  return body?.match(/<!--\s*e2e:\s*([\w-]+)\s*-->/)?.[1] ?? null;
}

export function github(token: string): Gh {
  return async (method, path, body) => {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "agent-orchestration-e2e-stub",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };
}

/** The stub's GitHub access: the orchestrator's App, on an installation
 * token for the sandbox (cached until shortly before it expires). A 403 is
 * retried once on a fresh token, as the Worker's own calls are: a cached
 * token can predate a permission the App has since been granted. */
export function stubGitHub(
  env: StubEnv,
  appToken: () => Promise<string> = () => installationTokenFor(env),
  forget: () => void = () => forgetInstallationToken(...(env.E2E_REPO.split("/") as [string, string])),
): Gh {
  return async (method, path, body) => {
    try {
      return await github(await appToken())(method, path, body);
    } catch (e) {
      if (!(e instanceof Error && / 403 /.test(e.message))) throw e;
      forget();
      return github(await appToken())(method, path, body);
    }
  };
}

function installationTokenFor(env: StubEnv): Promise<string> {
  const [owner, repo] = env.E2E_REPO.split("/") as [string, string];
  return installationToken(env, owner, repo);
}

const isSandbox = (env: StubEnv, owner: string, repo: string) =>
  `${owner}/${repo}`.toLowerCase() === env.E2E_REPO.toLowerCase();

const logged = (label: string, work: () => Promise<unknown>) =>
  work()
    .then((result) => console.log(`e2e stub: ${label} -> ${result}`))
    .catch((e) => console.error(`e2e stub failed (${label}):`, e instanceof Error ? e.message : e));

export async function handleFire(
  request: Request,
  env: StubEnv,
  defer: (work: Promise<unknown>) => void,
  gh: Gh = stubGitHub(env),
  delayMs = STUB_DELAY_MS,
  signalFor: (owner: string, repo: string) => Signal = (o, r) => routineSignal(env, o, r),
): Promise<Response> {
  if (request.headers.get("Authorization") !== `Bearer ${env.FIRE_TOKEN}`) {
    return new Response("unauthorized", { status: 401 });
  }
  let text: unknown;
  try {
    ({ text } = (await request.json()) as { text?: unknown });
  } catch {
    return new Response("invalid JSON body", { status: 400 });
  }
  const fire = typeof text === "string" ? parseFire(text) : null;
  if (!fire) return new Response("no route=… repo=… number=… in text", { status: 400 });
  if (!isSandbox(env, fire.owner, fire.repo)) {
    return new Response(`not the e2e repo: ${fire.owner}/${fire.repo}`, { status: 403 });
  }

  // `fail_fire`: refuse the fire itself, a fire that never got out (no
  // watchdog, no log row): what the reconciliation sweep is for.
  const { body: now } = (await gh("GET", `/repos/${fire.owner}/${fire.repo}/issues/${fire.number}`)) as { body: string | null };
  if (parseHint(now) === "fail_fire") return new Response("e2e stub: scripted fire failure", { status: 500 });

  defer(
    logged(`${fire.route} #${fire.number}`, async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      const { body } = (await gh("GET", `/repos/${fire.owner}/${fire.repo}/issues/${fire.number}`)) as {
        body: string | null;
      };
      return act(gh, fire, parseHint(body), signalFor(fire.owner, fire.repo), fire.logToken ? logWriter(env, fire.logToken) : undefined);
    }),
  );
  return Response.json({ accepted: true, route: fire.route, number: fire.number });
}

export async function verifySignature(secret: string, rawBody: string, header: string | null): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice("sha256=".length);
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/**
 * The sandbox's check_suite webhook. It used to run merge-flow's gate again
 * when CI finished, which hid a gap in the orchestrator: a merge-flow that
 * ran while a check was queued finished without merging, and nothing else
 * retried (PR #228, 05-10-2026). The orchestrator now fires merge-flow again
 * on green CI itself, so this only checks the signature and ignores the
 * event. The hook stays: the e2e driver finds the stub by its URL.
 */
export async function handleWebhook(request: Request, env: StubEnv): Promise<Response> {
  const raw = await request.text();
  if (!(await verifySignature(env.HOOK_SECRET, raw, request.headers.get("X-Hub-Signature-256")))) {
    return new Response("invalid signature", { status: 401 });
  }
  return Response.json({ ignored: "the orchestrator fires merge-flow again when CI finishes green" });
}

export type ReviewEvent = "REQUEST_CHANGES" | "APPROVE";

/**
 * POST /review {number, event}: the e2e driver asks for a review on a
 * sandbox PR, submitted as the orchestrator's App bot. GitHub won't let a
 * PR's author request changes on it, and every sandbox PR is opened by the
 * driver's own account, so a requested-changes scenario needs a second
 * identity; the App is one. Same bearer as a fire.
 */
export async function handleReview(
  request: Request,
  env: StubEnv,
  gh: (token: string) => Gh = github,
  appToken: (owner: string, repo: string) => Promise<string> = (o, r) => installationToken(env, o, r),
): Promise<Response> {
  if (request.headers.get("Authorization") !== `Bearer ${env.FIRE_TOKEN}`) return new Response("unauthorized", { status: 401 });
  let body: { number?: unknown; event?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return new Response("invalid JSON body", { status: 400 });
  }
  const number = body.number;
  const event = body.event;
  if (typeof number !== "number" || (event !== "REQUEST_CHANGES" && event !== "APPROVE")) {
    return new Response("number and event (REQUEST_CHANGES | APPROVE) are required", { status: 400 });
  }
  const [owner, repo] = env.E2E_REPO.split("/") as [string, string];
  const review = (await gh(await appToken(owner, repo))("POST", `/repos/${owner}/${repo}/pulls/${number}/reviews`, {
    event,
    body: event === "REQUEST_CHANGES" ? "e2e stub: changes requested." : "e2e stub: approved.",
  })) as { id: number; state: string; user?: { login: string } };
  return Response.json({ id: review.id, state: review.state, by: review.user?.login });
}

export default {
  fetch(request: Request, env: StubEnv, ctx: ExecutionContext): Promise<Response> | Response {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const defer = (work: Promise<unknown>) => ctx.waitUntil(work);
    const path = new URL(request.url).pathname;
    if (path === "/webhook") return handleWebhook(request, env);
    if (path === "/review") return handleReview(request, env);
    return handleFire(request, env, defer);
  },
};
