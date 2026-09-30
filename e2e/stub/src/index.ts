// The stub agent: the e2e sandbox's Fire URL. The orchestrator Worker fires
// it exactly as it fires a real loop-dispatch routine (same body, same
// bearer token), and the stub does what that loop does in orchestrated
// mode, through the GitHub API, with no LLM (see loops.ts). What it does is
// scripted by the issue's or PR's hint, `<!-- e2e: <hint> -->`. See
// docs/agent-orchestration/14-e2e-testing.md.
//
// Two routes:
// - POST /         a fire from the orchestrator (bearer FIRE_TOKEN)
// - POST /webhook  the sandbox's check_suite webhook (HMAC HOOK_SECRET), so
//                  merge-flow can merge once CI goes green, as the real one
//                  does by polling
//
// Only the sandbox repo (E2E_REPO) is ever acted on, whatever a request says.

import { act, mergeIfGreen, type Fire, type Gh, type Signal } from "./loops";

export { outcomeComment, type Action, type Fire, type Gh, type Signal } from "./loops";

export type StubEnv = {
  GITHUB_TOKEN: string;
  FIRE_TOKEN: string;
  HOOK_SECRET: string;
  E2E_REPO: string;
  // The orchestrator, for heartbeat and completion signals: a service
  // binding, since a Worker can't fetch another on the same workers.dev.
  ORCHESTRATOR: { fetch: (input: string, init?: RequestInit) => Promise<Response> };
  ROUTINE_SIGNAL_SECRET: string;
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
  return { route: m[1]!, owner: m[2]!, repo: m[3]!, number: Number(m[4]) };
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
  gh: Gh = github(env.GITHUB_TOKEN),
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

  defer(
    logged(`${fire.route} #${fire.number}`, async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      const { body } = (await gh("GET", `/repos/${fire.owner}/${fire.repo}/issues/${fire.number}`)) as {
        body: string | null;
      };
      return act(gh, fire, parseHint(body), signalFor(fire.owner, fire.repo));
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

/** CI finished on a sandbox PR: if it carries auto-merge, run merge-flow's
 * gate again, as the real merge-flow's polling would. */
export async function handleWebhook(
  request: Request,
  env: StubEnv,
  defer: (work: Promise<unknown>) => void,
  gh: Gh = github(env.GITHUB_TOKEN),
): Promise<Response> {
  const raw = await request.text();
  if (!(await verifySignature(env.HOOK_SECRET, raw, request.headers.get("X-Hub-Signature-256")))) {
    return new Response("invalid signature", { status: 401 });
  }
  if (request.headers.get("X-GitHub-Event") !== "check_suite") return Response.json({ ignored: "not check_suite" });
  const body = JSON.parse(raw) as {
    action?: string;
    repository?: { name: string; owner: { login: string } };
    check_suite?: { pull_requests?: { number: number }[] };
  };
  const owner = body.repository?.owner.login ?? "";
  const repo = body.repository?.name ?? "";
  if (body.action !== "completed" || !isSandbox(env, owner, repo)) return Response.json({ ignored: true });

  const prs = (body.check_suite?.pull_requests ?? []).map((p) => p.number);
  for (const number of prs) {
    defer(
      logged(`check_suite -> merge-flow #${number}`, async () => {
        // A silent merge-flow stays silent here too (the watchdog scenarios).
        const { body: prBody } = (await gh("GET", `/repos/${owner}/${repo}/issues/${number}`)) as { body: string | null };
        if (parseHint(prBody) === "silent") return "none";
        return mergeIfGreen(gh, { route: "merge-flow", owner, repo, number });
      }),
    );
  }
  return Response.json({ prs });
}

export default {
  fetch(request: Request, env: StubEnv, ctx: ExecutionContext): Promise<Response> | Response {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const defer = (work: Promise<unknown>) => ctx.waitUntil(work);
    if (new URL(request.url).pathname === "/webhook") return handleWebhook(request, env, defer);
    return handleFire(request, env, defer);
  },
};
