// index.ts's fetch() is a plain function over `(Request, Env)` — no real
// Workers runtime needed to test it, just fakes for the one thing it
// actually touches: env.ISSUE_COORDINATOR (idFromName + get().fetch()).
// Avoids @cloudflare/vitest-pool-workers (which would force a vitest 2->4
// major bump — see worker/README.md) in favor of the same fake-deps
// pattern coordinate/*.test.ts already established for this codebase.

import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { ANSWER_WITHIN_MS, type Env } from "../src/index";
import { LABELS } from "@orchestrator/graph/constants/labels";

function fakeEnv(overrides: Partial<Env> = {}): {
  env: Env;
  idFromName: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  stubFetch: ReturnType<typeof vi.fn>;
} {
  const stubFetch = vi.fn(async () => new Response(JSON.stringify({ outcome: "no_event" }), { status: 200 }));
  const stub = { fetch: stubFetch };
  const get = vi.fn(() => stub);
  const idFromName = vi.fn((name: string) => ({ toString: () => name }));

  const env = {
    ISSUE_COORDINATOR: { idFromName, get } as unknown as Env["ISSUE_COORDINATOR"],
    DB: {} as unknown as Env["DB"],
    GITHUB_APP_TOKEN: "test-token",
    REPO_ROUTINES_JSON: "{}",
    ...overrides,
  };
  return { env, idFromName, get, stubFetch };
}

function labeledIssuePayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "labeled",
    repository: { name: "umbraco-mcp-ops", owner: { login: "hifi-phil" } },
    issue: { number: 412 },
    label: { name: LABELS.AI_READY },
    sender: { login: "phil", type: "User" },
    ...overrides,
  };
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://worker.example/", {
    method: "POST",
    headers: { "X-GitHub-Event": "issues", "X-GitHub-Delivery": "d-1", ...headers },
    body: JSON.stringify(body),
  });
}

describe("index.ts fetch() — basic request validation", () => {
  it("rejects non-POST methods", async () => {
    const { env } = fakeEnv();
    const res = await worker.fetch(new Request("https://worker.example/", { method: "GET" }), env);
    expect(res.status).toBe(405);
  });

  it("rejects a request with no X-GitHub-Event header", async () => {
    const { env } = fakeEnv();
    const res = await worker.fetch(
      new Request("https://worker.example/", { method: "POST", body: "{}" }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("rejects invalid JSON", async () => {
    const { env } = fakeEnv();
    const res = await worker.fetch(
      new Request("https://worker.example/", {
        method: "POST",
        headers: { "X-GitHub-Event": "issues" },
        body: "not json",
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("drops a payload with no routable issue/PR number, never reaching the DO", async () => {
    const { env, get } = fakeEnv();
    const res = await worker.fetch(request({ action: "labeled", repository: { name: "r", owner: { login: "o" } } }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, dropped: "no routable issue/PR number" });
    expect(get).not.toHaveBeenCalled();
  });
});

describe("index.ts fetch() — answering GitHub within its 10 s", () => {
  afterEach(() => vi.useRealTimers());
  const ctx = () => {
    const waitUntil = vi.fn();
    return { ctx: { waitUntil, passThroughOnException() {} } as unknown as ExecutionContext, waitUntil };
  };

  it("work done in time: the coordinator's own answer, nothing left running", async () => {
    const { env } = fakeEnv();
    const { ctx: c, waitUntil } = ctx();
    const res = await worker.fetch(request(labeledIssuePayload()), env, c);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "no_event" });
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("work still running at the deadline: 202 at once, and the work goes on (waitUntil) to finish", async () => {
    vi.useFakeTimers();
    let finish!: (r: Response) => void;
    const { env, stubFetch } = fakeEnv();
    stubFetch.mockImplementationOnce(() => new Promise<Response>((r) => (finish = r)));
    const { ctx: c, waitUntil } = ctx();
    const pending = worker.fetch(request(labeledIssuePayload()), env, c);
    await vi.advanceTimersByTimeAsync(ANSWER_WITHIN_MS);
    const res = await pending;
    expect(res.status).toBe(202);
    expect(waitUntil).toHaveBeenCalledOnce();
    finish(Response.json({ outcome: "applied" }));
    await waitUntil.mock.calls[0]![0];
  });

  it("the deadline is under GitHub's 10 s", () => {
    expect(ANSWER_WITHIN_MS).toBeLessThan(10_000);
  });

  it("work that fails in time still fails the delivery (GitHub's log shows it; it can be redelivered)", async () => {
    const { env, stubFetch } = fakeEnv();
    stubFetch.mockImplementationOnce(async () => {
      throw new Error("DO exploded");
    });
    const { ctx: c } = ctx();
    const res = await worker.fetch(request(labeledIssuePayload()), env, c);
    expect(res.status).toBe(500);
  });
});

describe("index.ts fetch() — webhook signature verification", () => {
  it("no GITHUB_WEBHOOK_SECRET configured -> skips the check entirely", async () => {
    const { env, stubFetch } = fakeEnv();
    const res = await worker.fetch(request(labeledIssuePayload()), env);
    expect(res.status).toBe(200);
    expect(stubFetch).toHaveBeenCalledTimes(1);
  });

  it("GITHUB_WEBHOOK_SECRET set, no signature header -> 401, never reaches the DO", async () => {
    const { env, get } = fakeEnv({ GITHUB_WEBHOOK_SECRET: "shh" });
    const res = await worker.fetch(request(labeledIssuePayload()), env);
    expect(res.status).toBe(401);
    expect(get).not.toHaveBeenCalled();
  });

  it("GITHUB_WEBHOOK_SECRET set, wrong signature -> 401, never reaches the DO", async () => {
    const { env, get } = fakeEnv({ GITHUB_WEBHOOK_SECRET: "shh" });
    const res = await worker.fetch(
      request(labeledIssuePayload(), { "X-Hub-Signature-256": "sha256=deadbeef" }),
      env,
    );
    expect(res.status).toBe(401);
    expect(get).not.toHaveBeenCalled();
  });

  it("GITHUB_WEBHOOK_SECRET set, correct signature -> reaches the DO", async () => {
    const secret = "shh";
    const { env, stubFetch } = fakeEnv({ GITHUB_WEBHOOK_SECRET: secret });
    const body = JSON.stringify(labeledIssuePayload());
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const signature = "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");

    const res = await worker.fetch(
      new Request("https://worker.example/", {
        method: "POST",
        headers: { "X-GitHub-Event": "issues", "X-Hub-Signature-256": signature },
        body,
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(stubFetch).toHaveBeenCalledTimes(1);
  });
});

describe("index.ts fetch() — DO routing and isolation", () => {
  it("routes to a DO keyed by owner/repo#issueNumber, and forwards the parsed CoordinateInput", async () => {
    const { env, idFromName, get, stubFetch } = fakeEnv();
    await worker.fetch(request(labeledIssuePayload()), env);

    expect(idFromName).toHaveBeenCalledWith("hifi-phil/umbraco-mcp-ops#412");
    expect(get).toHaveBeenCalledTimes(1);
    const [, init] = stubFetch.mock.calls[0]!;
    const forwarded = JSON.parse((init as RequestInit).body as string);
    expect(forwarded).toEqual({
      deliveryId: "d-1",
      owner: "hifi-phil",
      repo: "umbraco-mcp-ops",
      issueNumber: 412,
      payload: expect.objectContaining({ action: "issues.labeled" }),
    });
  });

  it("two different issues route to two textually distinct DO keys and two independent stub calls", async () => {
    const { env, idFromName, get } = fakeEnv();
    await worker.fetch(request(labeledIssuePayload({ issue: { number: 1 } })), env);
    await worker.fetch(request(labeledIssuePayload({ issue: { number: 2 } })), env);

    expect(idFromName).toHaveBeenNthCalledWith(1, "hifi-phil/umbraco-mcp-ops#1");
    expect(idFromName).toHaveBeenNthCalledWith(2, "hifi-phil/umbraco-mcp-ops#2");
    // Real isolation (independent storage once the ids differ) is a
    // Cloudflare DO namespace platform guarantee, not something a fake
    // stub can further prove — this confirms the KEY CONSTRUCTION is
    // correct and injective for these inputs, which is the one place a
    // same-repo bug could actually cause two issues to collide.
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("two different repos with the same issue number route to two distinct keys", async () => {
    const { env, idFromName } = fakeEnv();
    await worker.fetch(request(labeledIssuePayload({ repository: { name: "repo-a", owner: { login: "o" } } })), env);
    await worker.fetch(request(labeledIssuePayload({ repository: { name: "repo-b", owner: { login: "o" } } })), env);

    const keys = idFromName.mock.calls.map((c) => c[0]);
    expect(new Set(keys).size).toBe(2);
  });

  it("the DO key ignores owner/repo case, as GitHub does", async () => {
    const { env, idFromName } = fakeEnv();
    await worker.fetch(
      request(labeledIssuePayload({ repository: { name: "Umbraco-MCP-Ops", owner: { login: "Hifi-Phil" } } })),
      env,
    );
    expect(idFromName).toHaveBeenCalledWith("hifi-phil/umbraco-mcp-ops#412");
  });

  it("a check_suite goes to each of its PRs' DOs; any failure fails the delivery", async () => {
    const { env, idFromName, stubFetch } = fakeEnv();
    stubFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ outcome: "no_event" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ outcome: "error", error: "boom" }), { status: 500 }));
    const res = await worker.fetch(
      request(
        {
          action: "completed",
          repository: { name: "umbraco-mcp-ops", owner: { login: "hifi-phil" } },
          check_suite: { status: "completed", conclusion: "failure", pull_requests: [{ number: 7 }, { number: 8 }] },
        },
        { "X-GitHub-Event": "check_suite" },
      ),
      env,
    );
    expect(idFromName).toHaveBeenNthCalledWith(1, "hifi-phil/umbraco-mcp-ops#7");
    expect(idFromName).toHaveBeenNthCalledWith(2, "hifi-phil/umbraco-mcp-ops#8");
    const [, init] = stubFetch.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      issueNumber: 7,
      payload: { action: "check_suite.completed", check_suite: { status: "completed", conclusion: "failure" } },
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ routed: [{ issueNumber: 7, status: 200 }, { issueNumber: 8, status: 500 }] });
  });

  it("a check_suite GitHub sent without pull_requests -> routed to the open PRs on its commit", async () => {
    const { env, idFromName } = fakeEnv();
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("/repos/hifi-phil/umbraco-mcp-ops/commits/abc123/pulls")
        ? new Response(JSON.stringify([{ number: 7, state: "open" }, { number: 8, state: "closed" }]), { status: 200 })
        : new Response("unexpected", { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await worker.fetch(
        request(
          {
            action: "completed",
            repository: { name: "umbraco-mcp-ops", owner: { login: "hifi-phil" } },
            check_suite: { status: "completed", conclusion: "failure", head_sha: "abc123", pull_requests: [] },
          },
          { "X-GitHub-Event": "check_suite" },
        ),
        env,
      );
      expect(idFromName).toHaveBeenCalledTimes(1);
      expect(idFromName).toHaveBeenCalledWith("hifi-phil/umbraco-mcp-ops#7");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a published release -> routed to the open release issue titled `release <version>` (the release split)", async () => {
    const { env, idFromName, stubFetch } = fakeEnv();
    const fetchMock = vi.fn(async (url: string) =>
      url.includes(`/repos/hifi-phil/umbraco-mcp-ops/issues?state=open`) && url.includes(`labels=${LABELS.AUTO_RELEASING}`)
        ? new Response(JSON.stringify([{ number: 218, title: "release 2.0.9", updated_at: "x" }, { number: 219, title: "Release 2.1.0", updated_at: "x" }]), {
            status: 200,
          })
        : new Response("unexpected", { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const release = (tag: string, action = "published") =>
        request(
          { action, repository: { name: "umbraco-mcp-ops", owner: { login: "hifi-phil" } }, release: { tag_name: tag, html_url: "https://x" } },
          { "X-GitHub-Event": "release" },
        );
      await worker.fetch(release("v2.1.0"), env);
      expect(idFromName).toHaveBeenCalledWith("hifi-phil/umbraco-mcp-ops#219");
      const [, init] = stubFetch.mock.calls[0]!;
      expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
        issueNumber: 219,
        payload: { action: "release.published", release: { version: "2.1.0", url: "https://x" } },
      });

      // No matching release issue, or a release only drafted: nothing to route.
      idFromName.mockClear();
      expect(await (await worker.fetch(release("v9.9.9"), env)).json()).toMatchObject({ dropped: "no routable issue/PR number" });
      expect(await (await worker.fetch(release("v2.1.0", "created"), env)).json()).toMatchObject({ dropped: "no routable issue/PR number" });
      expect(idFromName).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("passes through the DO's response verbatim", async () => {
    const { env, stubFetch } = fakeEnv();
    stubFetch.mockResolvedValueOnce(new Response(JSON.stringify({ outcome: "applied" }), { status: 200 }));
    const res = await worker.fetch(request(labeledIssuePayload()), env);
    expect(await res.json()).toEqual({ outcome: "applied" });
  });
});

describe("index.ts fetch() — GET /transitions (the sandbox's log read)", () => {
  const rows = [{ id: 1, event: "labelled_ai_ready", mode: "enforce" }];
  const logEnv = () => {
    const bind = vi.fn(() => ({ all: vi.fn(async () => ({ results: rows })) }));
    const prepare = vi.fn(() => ({ bind }));
    const { env } = fakeEnv({
      DB: { prepare } as unknown as Env["DB"],
      LOG_READ_SECRET: "log",
      LOG_READ_REPOS: "hifi-phil/mcp-ops-e2e-testing",
    });
    return { env, prepare, bind };
  };
  const get = (query: string, token = "log") =>
    new Request(`https://worker.example/transitions?${query}`, { headers: { Authorization: `Bearer ${token}` } });

  it("the sandbox's rows for one issue, with the secret", async () => {
    const { env, bind } = logEnv();
    const res = await worker.fetch(get("owner=Hifi-Phil&repo=mcp-ops-e2e-testing&issue=7"), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rows });
    expect(bind).toHaveBeenCalledWith("Hifi-Phil", "mcp-ops-e2e-testing", 7, 1000);
  });

  it("any repo not in LOG_READ_REPOS -> 403, the DB never read", async () => {
    const { env, prepare } = logEnv();
    const res = await worker.fetch(get("owner=hifi-phil&repo=umbraco-mcp-ops&issue=7"), env);
    expect(res.status).toBe(403);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("wrong secret -> 401; missing params -> 400", async () => {
    const { env } = logEnv();
    expect((await worker.fetch(get("owner=hifi-phil&repo=mcp-ops-e2e-testing&issue=7", "nope"), env)).status).toBe(401);
    expect((await worker.fetch(get("owner=hifi-phil&repo=mcp-ops-e2e-testing"), env)).status).toBe(400);
  });

  it("no LOG_READ_SECRET (every Worker but the e2e one) -> 404", async () => {
    const { env } = fakeEnv();
    expect((await worker.fetch(get("owner=hifi-phil&repo=mcp-ops-e2e-testing&issue=7"), env)).status).toBe(404);
  });

  it("other GETs are still refused", async () => {
    const { env } = logEnv();
    expect((await worker.fetch(new Request("https://worker.example/", { method: "GET" }), env)).status).toBe(405);
  });
});

describe("index.ts fetch() — the Scheduler", () => {
  const schedulerNs = () => {
    const calls: string[] = [];
    const ns = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({
        fetch: vi.fn(async (url: string) => {
          calls.push(new URL(url).pathname);
          return Response.json({ checked: 0 });
        }),
      }),
    } as unknown as Env["ISSUE_COORDINATOR"];
    return { ns, calls };
  };

  it("every webhook re-arms the sweep's alarm (/ensure) before routing", async () => {
    const { ns, calls } = schedulerNs();
    const { env, stubFetch } = fakeEnv({ SCHEDULER: ns });
    await worker.fetch(request(labeledIssuePayload()), env);
    expect(calls).toEqual(["/ensure"]);
    expect(stubFetch).toHaveBeenCalledOnce();
  });

  it("POST /sweep: the sandbox key runs a sweep for the sandbox repos only; anything else is refused", async () => {
    const { ns, calls } = schedulerNs();
    const { env } = fakeEnv({ SCHEDULER: ns, LOG_READ_SECRET: "log", LOG_READ_REPOS: "hifi-phil/mcp-ops-e2e-testing" });
    const sweep = (token: string) =>
      worker.fetch(new Request("https://worker.example/sweep", { method: "POST", headers: { Authorization: `Bearer ${token}` } }), env);
    expect((await sweep("nope")).status).toBe(401);
    expect((await sweep("log")).status).toBe(200);
    expect(calls).toEqual(["/sweep"]);
    const { env: noKey } = fakeEnv({ SCHEDULER: ns });
    expect((await worker.fetch(new Request("https://worker.example/sweep", { method: "POST" }), noKey)).status).toBe(404);
  });
});

function routineSignalRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://worker.example/routine-signal", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const heartbeat = (overrides: Record<string, unknown> = {}) => ({
  owner: "hifi-phil",
  repo: "umbraco-mcp-ops",
  signal: { kind: "process", routine: "issue-build-loop", issue: 412, step: "driving CI green" },
  ...overrides,
});

describe("index.ts fetch() — POST /routine-signal", () => {
  it("no ROUTINE_SIGNAL_SECRET configured -> skips auth, routes to the DO's /routine-signal path", async () => {
    const { env, get, stubFetch } = fakeEnv();
    stubFetch.mockResolvedValueOnce(new Response(JSON.stringify({ outcome: "heartbeat_extended" }), { status: 200 }));

    const res = await worker.fetch(routineSignalRequest(heartbeat()), env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "heartbeat_extended" });
    expect(get).toHaveBeenCalledTimes(1);
    const [url, init] = stubFetch.mock.calls[0]!;
    expect(url).toBe("https://issue-coordinator/routine-signal");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual(heartbeat());
  });

  it("ROUTINE_SIGNAL_SECRET set, no/wrong Authorization header -> 401, never reaches the DO", async () => {
    const { env, get } = fakeEnv({ ROUTINE_SIGNAL_SECRET: "shh" });

    const noAuth = await worker.fetch(routineSignalRequest(heartbeat()), env);
    expect(noAuth.status).toBe(401);

    const wrongAuth = await worker.fetch(
      routineSignalRequest(heartbeat(), { Authorization: "Bearer wrong" }),
      env,
    );
    expect(wrongAuth.status).toBe(401);
    expect(get).not.toHaveBeenCalled();
  });

  it("ROUTINE_SIGNAL_SECRET set, correct bearer token -> reaches the DO", async () => {
    const { env, stubFetch } = fakeEnv({ ROUTINE_SIGNAL_SECRET: "shh" });
    const res = await worker.fetch(
      routineSignalRequest(heartbeat(), { Authorization: "Bearer shh" }),
      env,
    );
    expect(res.status).toBe(200);
    expect(stubFetch).toHaveBeenCalledTimes(1);
  });

  it("routes on owner/repo/signal.issue, same key shape as the webhook path", async () => {
    const { env, idFromName } = fakeEnv();
    await worker.fetch(routineSignalRequest(heartbeat()), env);
    expect(idFromName).toHaveBeenCalledWith("hifi-phil/umbraco-mcp-ops#412");
  });

  it("missing owner/repo/signal -> 400, never reaches the DO", async () => {
    const { env, get } = fakeEnv();
    const res = await worker.fetch(routineSignalRequest({ owner: "hifi-phil" }), env);
    expect(res.status).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });

  it("invalid JSON body -> 400", async () => {
    const { env } = fakeEnv();
    const res = await worker.fetch(
      new Request("https://worker.example/routine-signal", { method: "POST", body: "not json" }),
      env,
    );
    expect(res.status).toBe(400);
  });
});
