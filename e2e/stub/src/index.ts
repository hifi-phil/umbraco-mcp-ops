// The stub agent: the e2e sandbox's Fire URL. The orchestrator Worker fires
// it exactly as it fires a real loop-dispatch routine (same body, same
// bearer token), and the stub does what that loop does in orchestrated
// mode, through the GitHub API, with no LLM. What it does is scripted by
// the issue's or PR's hint, `<!-- e2e: <hint> -->`. See
// docs/agent-orchestration/14-e2e-testing.md.
//
// Only the sandbox repo (E2E_REPO) is ever acted on, whatever the fire says.

import type { Outcome } from "../../../graph/outcomes";

export type StubEnv = {
  GITHUB_TOKEN: string;
  FIRE_TOKEN: string;
  E2E_REPO: string;
};

export type Fire = { route: string; owner: string; repo: string; number: number };

export type Gh = (method: string, path: string, body?: unknown) => Promise<unknown>;

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

/** plugins/agent-outcomes's comment format, which from-github.ts parses. */
export function outcomeComment(loop: string, outcome: Outcome): string {
  return (
    `e2e stub (${loop}): ${outcome.outcome}.\n\n` +
    `<!-- agent-outcome:${loop} -->\n\`\`\`json\n${JSON.stringify(outcome)}\n\`\`\``
  );
}

/** What the stub did, for its response and the tests. `none` covers both a
 * `silent` hint and a route or hint it doesn't script yet: either way the
 * orchestrator sees a loop that never reported back. */
export type Action = "build_blocked" | "none";

export async function act(gh: Gh, fire: Fire, hint: string | null): Promise<Action> {
  const issue = `/repos/${fire.owner}/${fire.repo}/issues/${fire.number}`;
  if (fire.route === "issue-build-loop" && hint === "blocked") {
    await gh("POST", `${issue}/comments`, {
      body: outcomeComment("issue-build-loop", { outcome: "build_blocked", reason: "e2e stub: scripted block" }),
    });
    return "build_blocked";
  }
  return "none";
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

export async function handleFire(
  request: Request,
  env: StubEnv,
  defer: (work: Promise<unknown>) => void,
  gh: Gh = github(env.GITHUB_TOKEN),
  delayMs = STUB_DELAY_MS,
): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
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
  if (`${fire.owner}/${fire.repo}`.toLowerCase() !== env.E2E_REPO.toLowerCase()) {
    return new Response(`not the e2e repo: ${fire.owner}/${fire.repo}`, { status: 403 });
  }

  defer(
    (async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      const { body } = (await gh("GET", `/repos/${fire.owner}/${fire.repo}/issues/${fire.number}`)) as {
        body: string | null;
      };
      const action = await act(gh, fire, parseHint(body));
      console.log(`e2e stub: ${fire.route} #${fire.number} -> ${action}`);
    })().catch((e) => console.error("e2e stub failed:", e instanceof Error ? e.message : e)),
  );
  return Response.json({ accepted: true, route: fire.route, number: fire.number });
}

export default {
  fetch(request: Request, env: StubEnv, ctx: ExecutionContext): Promise<Response> {
    return handleFire(request, env, (work) => ctx.waitUntil(work));
  },
};
