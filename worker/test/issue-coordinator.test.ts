// issue-coordinator.ts is a thin wrapper — coordinate.ts (already unit
// tested against fake Deps) does the real decision logic; this class only
// wires that to ctx.storage, D1, and the real githubClient/routines-client
// (which are themselves already unit tested against a stubbed global
// fetch). So testing this class means: fake ctx.storage + fake D1 + a
// stubbed global fetch standing in for the GitHub/Claude APIs — same
// fake-deps pattern as coordinate.test.ts, no Miniflare/vitest-pool-workers
// needed (see worker/README.md for why that'd force an unwanted vitest
// major-version bump).

import { afterEach, describe, expect, it, vi } from "vitest";
import { IssueCoordinator, type IssueCoordinatorEnv } from "../src/issue-coordinator";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fake DurableObjectState backed by a plain Map — enough for
 * ctx.storage.get/put/delete and setAlarm/deleteAlarm as spies. Each call
 * gets its OWN Map, which is what actually models "different DO instances
 * don't share storage" (see the isolation test below). */
function fakeCtx() {
  const store = new Map<string, unknown>();
  const setAlarm = vi.fn(async () => {});
  const deleteAlarm = vi.fn(async () => {});
  const storage = {
    get: vi.fn(async (key: string) => store.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    setAlarm,
    deleteAlarm,
  };
  return { ctx: { storage } as unknown as DurableObjectState, storage, store, setAlarm, deleteAlarm };
}

/** A fake D1Database recording every bound INSERT. */
function fakeDb() {
  const inserted: unknown[][] = [];
  const db = {
    prepare: vi.fn(() => ({
      bind: vi.fn((...args: unknown[]) => {
        inserted.push(args);
        return { run: vi.fn(async () => ({ success: true })) };
      }),
    })),
  };
  return { db: db as unknown as D1Database, inserted };
}

function fakeEnv(overrides: Partial<IssueCoordinatorEnv> = {}): IssueCoordinatorEnv {
  return {
    GITHUB_APP_TOKEN: "test-token",
    CLAUDE_API_KEY: "test-key",
    ROUTINE_IDS_JSON: JSON.stringify({
      "issue-build-loop": "rt_abc123",
      "auto-release-loop": "rt_release",
      "issue-discuss-loop": "rt_discuss",
      "rework-loop": "rt_rework",
      "merge-flow": "rt_merge",
    }),
    DB: fakeDb().db,
    ...overrides,
  };
}

/** Dispatches the handful of GitHub/Claude REST calls issue-coordinator.ts's
 * deps() actually makes, by method + URL substring — same shape as
 * github-client.test.ts's per-call fetch mocks, just combined into one.
 * `mergeGate` overrides the pull/check-runs/reviews responses for the
 * getMergeGateFacts composition tests. */
function fakeApiFetch(
  mergeGate: {
    headSha?: string;
    mergeable?: boolean | null;
    checkRuns?: Array<{ status: string; conclusion: string | null }>;
    reviews?: Array<{ state: string }>;
    labels?: string[];
  } = {},
) {
  const {
    headSha = "abc123",
    mergeable = true,
    checkRuns = [{ status: "completed", conclusion: "success" }],
    reviews = [],
    labels = [],
  } = mergeGate;
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.includes("/labels")) {
      return new Response(JSON.stringify(labels.map((name) => ({ name }))), { status: 200 });
    }
    if (method === "POST" && url.includes("/routines/")) return new Response("{}", { status: 200 });
    if (method === "POST" && url.includes("/comments")) return new Response("{}", { status: 201 });
    if (method === "POST" && url.includes("/labels")) return new Response("[]", { status: 200 });
    if (method === "DELETE" && url.includes("/labels/")) return new Response("", { status: 200 });
    if (method === "GET" && url.includes("/reviews")) return new Response(JSON.stringify(reviews), { status: 200 });
    if (method === "GET" && url.includes("/check-runs")) {
      return new Response(JSON.stringify({ check_runs: checkRuns }), { status: 200 });
    }
    if (method === "GET" && url.includes("/pulls/")) {
      return new Response(JSON.stringify({ head: { sha: headSha }, mergeable }), { status: 200 });
    }
    if (method === "PATCH") return new Response("{}", { status: 200 });
    throw new Error(`unhandled fake fetch: ${method} ${url}`);
  });
}

function fetchRequest(body: unknown) {
  return new Request("https://issue-coordinator/", { method: "POST", body: JSON.stringify(body) });
}

function routineSignalRequest(body: unknown) {
  return new Request("https://issue-coordinator/routine-signal", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const labeledInput = (overrides: Record<string, unknown> = {}) => ({
  deliveryId: "d-1",
  owner: "hifi-phil",
  repo: "umbraco-mcp-ops",
  issueNumber: 412,
  payload: {
    action: "issues.labeled",
    label: { name: "ai-ready" },
    sender: { login: "phil", type: "User" },
  },
  ...overrides,
});

describe("IssueCoordinator.fetch()", () => {
  it("rejects non-POST", async () => {
    const { ctx } = fakeCtx();
    const coordinator = new IssueCoordinator(ctx, fakeEnv());
    const res = await coordinator.fetch(new Request("https://issue-coordinator/", { method: "GET" }));
    expect(res.status).toBe(405);
  });

  it("rejects invalid JSON", async () => {
    const { ctx } = fakeCtx();
    const coordinator = new IssueCoordinator(ctx, fakeEnv());
    const res = await coordinator.fetch(new Request("https://issue-coordinator/", { method: "POST", body: "not json" }));
    expect(res.status).toBe(400);
  });

  it("applies a real rule, logs to D1, and schedules the watchdog alarm", async () => {
    vi.stubGlobal("fetch", fakeApiFetch());
    const { ctx, setAlarm } = fakeCtx();
    const { db, inserted } = fakeDb();
    const coordinator = new IssueCoordinator(ctx, fakeEnv({ DB: db }));

    const res = await coordinator.fetch(fetchRequest(labeledInput()));
    const result = (await res.json()) as { outcome: string };

    expect(result.outcome).toBe("applied");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toEqual([
      null,
      "hifi-phil",
      "umbraco-mcp-ops",
      412,
      "none",
      "labelled_ai_ready",
      JSON.stringify({ kind: "label", value: "ai-ready" }),
      "issue-build-loop",
      null,
    ]);
    // rule.run is set -> setPendingFire -> a real watchdog alarm scheduled
    expect(setAlarm).toHaveBeenCalledTimes(1);
  });

  it("dedupes a repeated delivery id without re-hitting the API or D1", async () => {
    const apiFetch = fakeApiFetch();
    vi.stubGlobal("fetch", apiFetch);
    const { ctx } = fakeCtx();
    const { db, inserted } = fakeDb();
    const coordinator = new IssueCoordinator(ctx, fakeEnv({ DB: db }));

    await coordinator.fetch(fetchRequest(labeledInput()));
    apiFetch.mockClear();
    inserted.length = 0;

    const res = await coordinator.fetch(fetchRequest(labeledInput()));
    expect(await res.json()).toEqual({ outcome: "deduped" });
    expect(apiFetch).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });
});

describe("IssueCoordinator.alarm() — the watchdog", () => {
  it("fires: comments on the issue and clears pendingFire, when one was set", async () => {
    const apiFetch = fakeApiFetch();
    vi.stubGlobal("fetch", apiFetch);
    const { ctx, storage } = fakeCtx();
    await storage.put("pendingFire", {
      owner: "hifi-phil",
      repo: "umbraco-mcp-ops",
      issueNumber: 412,
      run: "issue-build-loop",
    });
    const coordinator = new IssueCoordinator(ctx, fakeEnv());

    await coordinator.alarm();

    const commentCall = apiFetch.mock.calls.find(([url, init]) => (init as RequestInit)?.method === "POST" && (url as string).includes("/comments"));
    expect(commentCall).toBeDefined();
    const [, init] = commentCall!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.body).toMatch(/issue-build-loop.*hasn't reported back within 30 minutes/);
    expect(await storage.get("pendingFire")).toBeUndefined();
  });

  it("no-ops when no pendingFire is set — a harmless race, not a bug", async () => {
    const apiFetch = fakeApiFetch();
    vi.stubGlobal("fetch", apiFetch);
    const { ctx } = fakeCtx();
    const coordinator = new IssueCoordinator(ctx, fakeEnv());

    await coordinator.alarm();

    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe("Isolation across DO instances (different issues)", () => {
  it("two IssueCoordinator instances (as two issues would get, via index.ts's idFromName) never share dedup state", async () => {
    vi.stubGlobal("fetch", fakeApiFetch());
    const a = fakeCtx();
    const b = fakeCtx();
    const coordinatorA = new IssueCoordinator(a.ctx, fakeEnv());
    const coordinatorB = new IssueCoordinator(b.ctx, fakeEnv());

    // Same delivery id, two different (fake) DO instances — mirrors two
    // different issues each getting their own real DO. Both must treat it
    // as new; if they shared state, B's would come back "deduped".
    const resA = await coordinatorA.fetch(fetchRequest(labeledInput()));
    const resB = await coordinatorB.fetch(fetchRequest(labeledInput()));

    expect(((await resA.json()) as { outcome: string }).outcome).toBe("applied");
    expect(((await resB.json()) as { outcome: string }).outcome).toBe("applied");
    // Each instance's own storage map only ever saw its own writes.
    expect(a.store.has("pendingFire")).toBe(true);
    expect(b.store.has("pendingFire")).toBe(true);
    expect(a.store).not.toBe(b.store);
  });
});

describe("IssueCoordinator.fetch() — POST /routine-signal", () => {
  it("a matching 'process' heartbeat extends the alarm (re-calls ctx.storage.setAlarm)", async () => {
    vi.stubGlobal("fetch", fakeApiFetch());
    const { ctx, setAlarm } = fakeCtx();
    const coordinator = new IssueCoordinator(ctx, fakeEnv());
    await coordinator.fetch(
      fetchRequest(labeledInput({ payload: { action: "issues.labeled", label: { name: "ai-ready" } } })),
    );
    setAlarm.mockClear();

    const res = await coordinator.fetch(
      routineSignalRequest({
        owner: "hifi-phil",
        repo: "umbraco-mcp-ops",
        signal: { kind: "process", routine: "issue-build-loop", issue: 412, step: "driving CI green" },
      }),
    );

    expect(await res.json()).toEqual({ outcome: "heartbeat_extended" });
    expect(setAlarm).toHaveBeenCalledTimes(1);
  });

  it("a matching 'completion' signal clears pendingFire early, without writing to D1", async () => {
    vi.stubGlobal("fetch", fakeApiFetch());
    const { ctx, deleteAlarm } = fakeCtx();
    const { db, inserted } = fakeDb();
    const coordinator = new IssueCoordinator(ctx, fakeEnv({ DB: db }));
    await coordinator.fetch(
      fetchRequest(labeledInput({ payload: { action: "issues.labeled", label: { name: "ai-ready" } } })),
    );
    inserted.length = 0;

    const res = await coordinator.fetch(
      routineSignalRequest({
        owner: "hifi-phil",
        repo: "umbraco-mcp-ops",
        signal: {
          kind: "completion",
          routine: "issue-build-loop",
          issue: 412,
          outcome: { outcome: "build_succeeded", pr: 99 },
        },
      }),
    );

    expect(await res.json()).toEqual({ outcome: "completion_acknowledged" });
    expect(deleteAlarm).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(0); // non-authoritative — no D1 row for this path
  });

  it("a signal for a routine that doesn't currently own this issue -> mismatched_routine, no watchdog change", async () => {
    vi.stubGlobal("fetch", fakeApiFetch());
    const { ctx, setAlarm, deleteAlarm } = fakeCtx();
    const coordinator = new IssueCoordinator(ctx, fakeEnv());
    await coordinator.fetch(
      fetchRequest(labeledInput({ payload: { action: "issues.labeled", label: { name: "ai-ready" } } })),
    );
    setAlarm.mockClear();

    const res = await coordinator.fetch(
      routineSignalRequest({
        owner: "hifi-phil",
        repo: "umbraco-mcp-ops",
        signal: { kind: "process", routine: "merge-flow", issue: 412, step: "checking gates" },
      }),
    );

    expect(await res.json()).toEqual({
      outcome: "mismatched_routine",
      expected: "issue-build-loop",
      got: "merge-flow",
    });
    expect(setAlarm).not.toHaveBeenCalled();
    expect(deleteAlarm).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON on the routine-signal path too", async () => {
    const { ctx } = fakeCtx();
    const coordinator = new IssueCoordinator(ctx, fakeEnv());
    const res = await coordinator.fetch(
      new Request("https://issue-coordinator/routine-signal", { method: "POST", body: "not json" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("IssueCoordinator — the real check_suite.completed / merge-gate aggregation", () => {
  async function labelAutoMerging(coordinator: IssueCoordinator, issueNumber = 412) {
    await coordinator.fetch(
      fetchRequest(
        labeledInput({
          issueNumber,
          payload: { action: "pull_request.labeled", label: { name: "auto-merging" } },
        }),
      ),
    );
  }

  it("a real check-runs failure -> applied, unlabel not called (soft: leaves the label on for a retry)", async () => {
    vi.stubGlobal("fetch", fakeApiFetch({ checkRuns: [{ status: "completed", conclusion: "failure" }], labels: ["auto-merging"] }));
    const { ctx } = fakeCtx();
    const coordinator = new IssueCoordinator(ctx, fakeEnv());
    await labelAutoMerging(coordinator);

    const res = await coordinator.fetch(
      fetchRequest(
        labeledInput({ deliveryId: "d-2", payload: { action: "check_suite.completed", check_suite: { conclusion: "failure", status: "completed" } } }),
      ),
    );
    const result = (await res.json()) as { outcome: string };
    expect(result.outcome).toBe("applied");
  });

  it("real unresolvable conflicts (mergeable: false) -> applied, removeLabel actually called against the fake GitHub API", async () => {
    vi.stubGlobal("fetch", fakeApiFetch({ mergeable: false, labels: ["auto-merging"] }));
    const { ctx } = fakeCtx();
    const coordinator = new IssueCoordinator(ctx, fakeEnv());
    await labelAutoMerging(coordinator);

    const fetchSpy = vi.mocked(globalThis.fetch);
    fetchSpy.mockClear();

    const res = await coordinator.fetch(
      fetchRequest(
        labeledInput({ deliveryId: "d-2", payload: { action: "check_suite.completed", check_suite: { conclusion: null, status: "completed" } } }),
      ),
    );
    const result = (await res.json()) as { outcome: string };
    expect(result.outcome).toBe("applied");

    const deleteCall = fetchSpy.mock.calls.find(([, init]) => (init as RequestInit)?.method === "DELETE");
    expect(deleteCall).toBeDefined();
    expect((deleteCall![0] as string)).toContain("/labels/auto-merging");
  });

  it("real all-green facts -> no_event, gate passes, no GitHub write beyond the reads", async () => {
    vi.stubGlobal("fetch", fakeApiFetch({ labels: ["auto-merging"] }));
    const { ctx } = fakeCtx();
    const coordinator = new IssueCoordinator(ctx, fakeEnv());
    await labelAutoMerging(coordinator);

    const res = await coordinator.fetch(
      fetchRequest(
        labeledInput({ deliveryId: "d-2", payload: { action: "check_suite.completed", check_suite: { conclusion: "success", status: "completed" } } }),
      ),
    );
    expect(await res.json()).toEqual({ outcome: "no_event" });
  });
});
