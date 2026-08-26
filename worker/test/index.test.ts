// index.ts's fetch() is a plain function over `(Request, Env)` — no real
// Workers runtime needed to test it, just fakes for the one thing it
// actually touches: env.ISSUE_COORDINATOR (idFromName + get().fetch()).
// Avoids @cloudflare/vitest-pool-workers (which would force a vitest 2->4
// major bump — see worker/README.md) in favor of the same fake-deps
// pattern coordinate.test.ts already established for this codebase.

import { describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";

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
    CLAUDE_API_KEY: "test-key",
    ROUTINE_IDS_JSON: "{}",
    ...overrides,
  };
  return { env, idFromName, get, stubFetch };
}

function labeledIssuePayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "labeled",
    repository: { name: "umbraco-mcp-ops", owner: { login: "hifi-phil" } },
    issue: { number: 412 },
    label: { name: "ai-ready" },
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

  it("passes through the DO's response verbatim", async () => {
    const { env, stubFetch } = fakeEnv();
    stubFetch.mockResolvedValueOnce(new Response(JSON.stringify({ outcome: "applied" }), { status: 200 }));
    const res = await worker.fetch(request(labeledIssuePayload()), env);
    expect(await res.json()).toEqual({ outcome: "applied" });
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
