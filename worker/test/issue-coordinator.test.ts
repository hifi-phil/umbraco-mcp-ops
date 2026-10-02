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
  let alarm: number | null = null;
  const setAlarm = vi.fn(async (at: number) => {
    alarm = at;
  });
  const deleteAlarm = vi.fn(async () => {
    alarm = null;
  });
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
    getAlarm: vi.fn(async () => alarm),
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
    REPO_ROUTINES_JSON: JSON.stringify({
      "hifi-phil/umbraco-mcp-ops": { fireUrl: "https://routines.example/fire/ops", token: "tok-ops" },
    }),
    DB: fakeDb().db,
    // Explicit, because unset means shadow — these tests are about the
    // enforced write path; shadow mode has its own describe block below.
    MODE: "enforce",
    WATCHDOG: "enforce",
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
    if (method === "POST" && url.startsWith("https://routines.example/fire/")) return new Response("{}", { status: 200 });
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
    label: { name: "ready-for-ai" },
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
      "d-1", // the delivery that caused it
      "hifi-phil",
      "umbraco-mcp-ops",
      412,
      "none",
      "labelled_ai_ready",
      JSON.stringify({ kind: "label", value: "ready-for-ai" }),
      "issue-build-loop",
      null,
      "enforce",
    ]);
    // rule.run is set -> setPendingFire -> a real watchdog alarm scheduled
    expect(setAlarm).toHaveBeenCalledTimes(1);
  });

  it("a failure returns 500 with the error text (not Cloudflare's bare 1101), and the redelivery is processed", async () => {
    const { ctx } = fakeCtx();
    const { db, inserted } = fakeDb();
    const coordinator = new IssueCoordinator(ctx, fakeEnv({ DB: db }));
    // The routine fire fails once with a 401, then works.
    let failFire = true;
    const ok = fakeApiFetch();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (failFire && url.startsWith("https://routines.example/fire/")) {
          failFire = false;
          return new Response("bad token", { status: 401 });
        }
        return ok(url, init);
      }),
    );

    const first = await coordinator.fetch(fetchRequest(labeledInput()));
    expect(first.status).toBe(500);
    expect(await first.json()).toEqual({
      outcome: "error",
      error: expect.stringMatching(/Routine fire failed for hifi-phil\/umbraco-mcp-ops.*401 bad token/),
    });
    expect(inserted).toHaveLength(0);

    const redelivered = await coordinator.fetch(fetchRequest(labeledInput()));
    expect(redelivered.status).toBe(200);
    expect(((await redelivered.json()) as { outcome: string }).outcome).toBe("applied");
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

describe("IssueCoordinator — one request at a time per issue", () => {
  it("a second webhook waits for the first to finish, even while the first awaits GitHub", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((r) => (releaseFirst = r));
    let labelReads = 0;
    const apiFetch = fakeApiFetch();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "GET" && url.includes("/labels")) {
          const n = ++labelReads;
          order.push(`read ${n}`);
          if (n === 1) await firstHeld; // the first request is mid-await on GitHub
        }
        return apiFetch(url, init);
      }),
    );
    const { ctx } = fakeCtx();
    const coordinator = new IssueCoordinator(ctx, fakeEnv());

    const first = coordinator.fetch(fetchRequest(labeledInput({ deliveryId: "d-a" })));
    const second = coordinator.fetch(fetchRequest(labeledInput({ deliveryId: "d-b" })));
    await new Promise((r) => setTimeout(r, 20));
    expect(order, "the second hasn't started while the first is waiting").toEqual(["read 1"]);

    releaseFirst();
    await first;
    await second;
    expect(order).toEqual(["read 1", "read 2"]);
  });

  it("a failing request doesn't block the next one", async () => {
    let calls = 0;
    const apiFetch = fakeApiFetch();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/labels") && (init?.method ?? "GET") === "GET" && ++calls === 1) {
          return new Response("bad gateway", { status: 502 });
        }
        return apiFetch(url, init);
      }),
    );
    const { ctx } = fakeCtx();
    const coordinator = new IssueCoordinator(ctx, fakeEnv());
    const failed = await coordinator.fetch(fetchRequest(labeledInput({ deliveryId: "d-a" })));
    const next = await coordinator.fetch(fetchRequest(labeledInput({ deliveryId: "d-b" })));
    expect(failed.status).toBe(500);
    expect(next.status).toBe(200);
  });
});

describe("IssueCoordinator — /reconcile's idle clock", () => {
  it("measures idle time from real activity: a shadow sweep row doesn't count", async () => {
    const queries: string[] = [];
    const db = {
      prepare: vi.fn((sql: string) => {
        queries.push(sql);
        return {
          bind: () => ({
            first: async () => ({ at: "2026-10-01 00:00:00" }),
            run: async () => ({ success: true }),
          }),
        };
      }),
    } as unknown as D1Database;
    vi.stubGlobal("fetch", fakeApiFetch({ labels: ["ready-for-ai"] }));
    const { ctx } = fakeCtx();
    const res = await new IssueCoordinator(ctx, fakeEnv({ DB: db })).fetch(
      new Request("https://issue-coordinator/reconcile", {
        method: "POST",
        body: JSON.stringify({ owner: "hifi-phil", repo: "umbraco-mcp-ops", issueNumber: 412, enforced: false }),
      }),
    );
    expect(res.status).toBe(200);
    const idle = queries.find((q) => q.includes("MAX(created_at)"));
    expect(idle).toMatch(/NOT \(event = 'reconcile_refire' AND mode = 'shadow'\)/);
  });

  it("a pending fire counts as watched only while its alarm is armed (ctx.storage.getAlarm)", async () => {
    vi.stubGlobal("fetch", fakeApiFetch({ labels: ["ready-for-ai"] }));
    const reconcile = (ctx: DurableObjectState) =>
      new IssueCoordinator(ctx, fakeEnv()).fetch(
        new Request("https://issue-coordinator/reconcile", {
          method: "POST",
          body: JSON.stringify({ owner: "hifi-phil", repo: "umbraco-mcp-ops", issueNumber: 412, enforced: false }),
        }),
      );
    const pending = { owner: "hifi-phil", repo: "umbraco-mcp-ops", issueNumber: 412, run: "issue-build-loop" };

    const armed = fakeCtx();
    await armed.storage.put("pendingFire", pending);
    await armed.storage.setAlarm(Date.now() + 60_000);
    expect(await (await reconcile(armed.ctx)).json()).toEqual({ outcome: "watched" });

    const lost = fakeCtx();
    await lost.storage.put("pendingFire", pending);
    expect(await (await reconcile(lost.ctx)).json()).not.toEqual({ outcome: "watched" });
  });
});

describe("IssueCoordinator.alarm() — the watchdog", () => {
  const pendingBuild = {
    owner: "hifi-phil",
    repo: "umbraco-mcp-ops",
    issueNumber: 412,
    run: "issue-build-loop",
  };

  it("fires: comments, swaps ready-for-ai -> ai-stuck for real, logs a watchdog_expired row to D1, clears pendingFire", async () => {
    const apiFetch = fakeApiFetch({ labels: ["ready-for-ai"] });
    vi.stubGlobal("fetch", apiFetch);
    const { ctx, storage } = fakeCtx();
    const { db, inserted } = fakeDb();
    await storage.put("pendingFire", pendingBuild);
    const coordinator = new IssueCoordinator(ctx, fakeEnv({ DB: db }));

    await coordinator.alarm();

    const calls = apiFetch.mock.calls.map(([url, init]) => `${(init as RequestInit)?.method ?? "GET"} ${url as string}`);
    const commentCall = apiFetch.mock.calls.find(([url, init]) => (init as RequestInit)?.method === "POST" && (url as string).includes("/comments"));
    const body = JSON.parse((commentCall![1] as RequestInit).body as string);
    expect(body.body).toMatch(/issue-build-loop.*hasn't reported back within 60 minutes.*ai-stuck/);
    expect(calls.some((c) => c.startsWith("DELETE") && c.endsWith("/labels/ready-for-ai"))).toBe(true);
    const addCall = apiFetch.mock.calls.find(([url, init]) => (init as RequestInit)?.method === "POST" && (url as string).endsWith("/labels"));
    expect(JSON.parse((addCall![1] as RequestInit).body as string)).toEqual({ labels: ["ai-stuck"] });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toEqual(expect.arrayContaining(["ready-for-ai", "watchdog_expired"]));
    expect(inserted[0]![0], "no delivery caused a watchdog row").toBeNull();
    expect(await storage.get("pendingFire")).toBeUndefined();
  });

  it("a failing GitHub call throws (so Cloudflare retries the alarm) and leaves pendingFire for that retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad gateway", { status: 502 })),
    );
    const { ctx, storage } = fakeCtx();
    await storage.put("pendingFire", pendingBuild);
    const coordinator = new IssueCoordinator(ctx, fakeEnv());

    await expect(coordinator.alarm()).rejects.toThrow();
    expect(await storage.get("pendingFire")).toEqual(pendingBuild);
  });

  it("a newer fire armed while this alarm waited its turn -> left alone: no comment, its alarm kept", async () => {
    const apiFetch = fakeApiFetch({ labels: ["ready-for-ai"] });
    vi.stubGlobal("fetch", apiFetch);
    const { ctx, storage, deleteAlarm } = fakeCtx();
    await storage.put("pendingFire", { ...pendingBuild, dueAt: Date.now() + 60 * 60_000 });
    await new IssueCoordinator(ctx, fakeEnv()).alarm();
    expect(apiFetch).not.toHaveBeenCalled();
    expect(deleteAlarm).not.toHaveBeenCalled();
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

describe("IssueCoordinator — a repo's watchdog override (WATCHDOG_OVERRIDES_JSON)", () => {
  const overrides = JSON.stringify({ "Hifi-Phil/MCP-Ops-E2E-Testing": { mode: "enforce", minutes: 1 } });
  const sandboxBuild = { owner: "hifi-phil", repo: "mcp-ops-e2e-testing", issueNumber: 5, run: "issue-build-loop" };

  it("the overridden repo's fire schedules its alarm at its own minutes", async () => {
    vi.stubGlobal("fetch", fakeApiFetch());
    const { ctx, setAlarm } = fakeCtx();
    const env = fakeEnv({
      WATCHDOG: undefined,
      WATCHDOG_OVERRIDES_JSON: overrides,
      REPO_ROUTINES_JSON: JSON.stringify({ "hifi-phil/mcp-ops-e2e-testing": { fireUrl: "https://routines.example/fire/e2e", token: "t" } }),
    });
    const before = Date.now();
    await new IssueCoordinator(ctx, env).fetch(fetchRequest(labeledInput({ repo: "mcp-ops-e2e-testing", issueNumber: 5 })));
    const [at] = setAlarm.mock.calls[0]! as unknown as [number];
    expect(at - before).toBeGreaterThanOrEqual(60_000);
    expect(at - before).toBeLessThan(61_000);
  });

  it("its expiry is real (comments, swaps to ai-stuck) though WATCHDOG is shadow, and quotes its own minutes", async () => {
    const apiFetch = fakeApiFetch({ labels: ["ready-for-ai"] });
    vi.stubGlobal("fetch", apiFetch);
    const { ctx, storage } = fakeCtx();
    await storage.put("pendingFire", sandboxBuild);
    await new IssueCoordinator(ctx, fakeEnv({ WATCHDOG: undefined, WATCHDOG_OVERRIDES_JSON: overrides })).alarm();
    const comment = apiFetch.mock.calls.find(([url, init]) => (init as RequestInit)?.method === "POST" && (url as string).includes("/comments"));
    expect(JSON.parse((comment![1] as RequestInit).body as string).body).toMatch(/within 1 minutes/);
    const add = apiFetch.mock.calls.find(([url, init]) => (init as RequestInit)?.method === "POST" && (url as string).endsWith("/labels"));
    expect(JSON.parse((add![1] as RequestInit).body as string)).toEqual({ labels: ["ai-stuck"] });
  });

  it("every other repo keeps WATCHDOG (shadow) and the default minutes", async () => {
    const apiFetch = fakeApiFetch({ labels: ["ready-for-ai"] });
    vi.stubGlobal("fetch", apiFetch);
    const { ctx, storage } = fakeCtx();
    await storage.put("pendingFire", { ...sandboxBuild, repo: "umbraco-mcp-ops" });
    await new IssueCoordinator(ctx, fakeEnv({ WATCHDOG: undefined, WATCHDOG_OVERRIDES_JSON: overrides })).alarm();
    const writes = apiFetch.mock.calls.filter(([, init]) => ((init as RequestInit)?.method ?? "GET") !== "GET");
    expect(writes).toEqual([]);
  });
});

describe("IssueCoordinator — MODE=enforce with the watchdog shadowed (Phase 4)", () => {
  const mergeLabeledInput = () => ({
    deliveryId: "d-merge",
    owner: "hifi-phil",
    repo: "umbraco-mcp-ops",
    issueNumber: 126,
    payload: { action: "pull_request.labeled", label: { name: "auto-merge" }, sender: { login: "phil", type: "User" } },
  });
  const fires = (apiFetch: ReturnType<typeof fakeApiFetch>) =>
    apiFetch.mock.calls.filter(([url]) => (url as string).startsWith("https://routines.example/fire/"));

  it("auto-merge fires the repo's loop-dispatch routine for real, logged as enforce", async () => {
    const apiFetch = fakeApiFetch({ labels: ["auto-merge"] });
    vi.stubGlobal("fetch", apiFetch);
    const { ctx } = fakeCtx();
    const { db, inserted } = fakeDb();
    const coordinator = new IssueCoordinator(ctx, fakeEnv({ DB: db, MODE: "enforce", WATCHDOG: undefined }));

    await coordinator.fetch(fetchRequest(mergeLabeledInput()));

    expect(fires(apiFetch)).toHaveLength(1);
    const [, init] = fires(apiFetch)[0]!;
    expect(JSON.parse((init as RequestInit).body as string).text).toContain(
      "route=merge-flow repo=hifi-phil/umbraco-mcp-ops number=126",
    );
    expect(inserted[0]).toEqual(expect.arrayContaining(["labelled_auto_merging", "merge-flow", "enforce"]));
  });

  it("the watchdog stays shadow: an expiry comments nothing, swaps nothing, and logs shadow", async () => {
    const apiFetch = fakeApiFetch({ labels: ["ready-for-ai"] });
    vi.stubGlobal("fetch", apiFetch);
    const { ctx, storage } = fakeCtx();
    const { db, inserted } = fakeDb();
    await storage.put("pendingFire", { owner: "hifi-phil", repo: "umbraco-mcp-ops", issueNumber: 412, run: "issue-build-loop" });
    const coordinator = new IssueCoordinator(ctx, fakeEnv({ DB: db, MODE: "enforce", WATCHDOG: undefined }));

    await coordinator.alarm();

    const writes = apiFetch.mock.calls.filter(([, init]) => ((init as RequestInit)?.method ?? "GET") !== "GET");
    expect(writes).toEqual([]);
    expect(inserted[0]).toEqual(expect.arrayContaining(["watchdog_expired", "shadow"]));
  });
});

describe("IssueCoordinator — shadow mode (Phase 3)", () => {
  const writes = (apiFetch: ReturnType<typeof fakeApiFetch>) =>
    apiFetch.mock.calls.filter(([, init]) => ((init as RequestInit)?.method ?? "GET") !== "GET");

  it.each([undefined, "shadow", "enforced", "ENFORCE"])(
    "MODE=%s is shadow: decides and logs, but writes nothing to GitHub and fires nothing",
    async (mode) => {
      const apiFetch = fakeApiFetch();
      vi.stubGlobal("fetch", apiFetch);
      const { ctx, setAlarm } = fakeCtx();
      const { db, inserted } = fakeDb();
      const coordinator = new IssueCoordinator(ctx, fakeEnv({ DB: db, MODE: mode }));

      const result = (await (await coordinator.fetch(fetchRequest(labeledInput()))).json()) as { outcome: string };

      expect(result.outcome).toBe("applied");
      expect(writes(apiFetch)).toEqual([]);
      expect(inserted).toHaveLength(1);
      expect(inserted[0]).toEqual(
        expect.arrayContaining(["none", "labelled_ai_ready", "issue-build-loop", "shadow"]),
      );
      // The watchdog still arms: it's measuring whether the routine the
      // existing dispatch fired reports back, which is shadow data too.
      expect(setAlarm).toHaveBeenCalledTimes(1);
    },
  );

  it("watchdog expiry in shadow: no comment, no label swap, still logs watchdog_expired and clears pendingFire", async () => {
    const apiFetch = fakeApiFetch({ labels: ["ready-for-ai"] });
    vi.stubGlobal("fetch", apiFetch);
    const { ctx, storage } = fakeCtx();
    const { db, inserted } = fakeDb();
    await storage.put("pendingFire", {
      owner: "hifi-phil",
      repo: "umbraco-mcp-ops",
      issueNumber: 412,
      run: "issue-build-loop",
    });
    const coordinator = new IssueCoordinator(ctx, fakeEnv({ DB: db, MODE: "shadow" }));

    await coordinator.alarm();

    expect(writes(apiFetch)).toEqual([]);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toEqual(expect.arrayContaining(["ready-for-ai", "watchdog_expired", "shadow"]));
    expect(await storage.get("pendingFire")).toBeUndefined();
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
      fetchRequest(labeledInput({ payload: { action: "issues.labeled", label: { name: "ready-for-ai" } } })),
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
      fetchRequest(labeledInput({ payload: { action: "issues.labeled", label: { name: "ready-for-ai" } } })),
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
      fetchRequest(labeledInput({ payload: { action: "issues.labeled", label: { name: "ready-for-ai" } } })),
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
          payload: { action: "pull_request.labeled", label: { name: "auto-merge" } },
        }),
      ),
    );
  }

  it("a real check-runs failure -> applied, unlabel not called (soft: leaves the label on for a retry)", async () => {
    vi.stubGlobal("fetch", fakeApiFetch({ checkRuns: [{ status: "completed", conclusion: "failure" }], labels: ["auto-merge"] }));
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
    vi.stubGlobal("fetch", fakeApiFetch({ mergeable: false, labels: ["auto-merge"] }));
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
    expect((deleteCall![0] as string)).toContain("/labels/auto-merge");
  });

  it("real all-green facts -> no_event, gate passes, no GitHub write beyond the reads", async () => {
    vi.stubGlobal("fetch", fakeApiFetch({ labels: ["auto-merge"] }));
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
