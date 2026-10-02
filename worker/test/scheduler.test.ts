import { afterEach, describe, expect, it, vi } from "vitest";
import { Scheduler, type SchedulerEnv } from "../src/scheduler";

afterEach(() => vi.unstubAllGlobals());

function fakeCtx(alarmAt: number | null = null) {
  let alarm = alarmAt;
  const order: string[] = [];
  const storage = {
    getAlarm: vi.fn(async () => alarm),
    setAlarm: vi.fn(async (at: number) => {
      order.push("setAlarm");
      alarm = at;
    }),
  };
  return { ctx: { storage } as unknown as DurableObjectState, storage, order };
}

function fakeEnv(reconcile: (body: { issueNumber: number; enforced: boolean }) => unknown, overrides: Partial<SchedulerEnv> = {}) {
  const inserted: unknown[][] = [];
  const asked: { key: string; body: { issueNumber: number; enforced: boolean } }[] = [];
  const env: SchedulerEnv = {
    GITHUB_APP_TOKEN: "t",
    REPO_ROUTINES_JSON: JSON.stringify({ "hifi-phil/umbraco-mcp-ops": {}, "hifi-phil/mcp-ops-e2e-testing": {} }),
    DB: {
      prepare: () => ({ bind: (...args: unknown[]) => (inserted.push(args), { run: async () => ({}) }) }),
    } as unknown as D1Database,
    ISSUE_COORDINATOR: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (id: { toString(): string }) => ({
        fetch: async (_url: string, init: RequestInit) => {
          const body = JSON.parse(init.body as string);
          asked.push({ key: id.toString(), body });
          return Response.json(reconcile(body));
        },
      }),
    } as unknown as DurableObjectNamespace,
    ...overrides,
  };
  return { env, inserted, asked };
}

/** GitHub: issue #7 has ready-for-ai on the ops repo; nothing else anywhere. */
const github = () =>
  vi.fn(async (url: string) => {
    if (url.includes("/repos/hifi-phil/umbraco-mcp-ops/issues?") && url.includes("labels=ready-for-ai")) {
      return Response.json([{ number: 7 }]);
    }
    return Response.json([]);
  });

describe("Scheduler", () => {
  it("each alarm sets the next one before sweeping, so a failed sweep can't end the chain", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const { ctx, storage, order } = fakeCtx();
    const { env } = fakeEnv(() => ({}));
    await new Scheduler(ctx, env).alarm(); // the sweep's GitHub calls fail; alarm() mustn't throw
    expect(order[0]).toBe("setAlarm");
    expect(storage.setAlarm).toHaveBeenCalledWith(expect.any(Number));
  });

  it("the next alarm is SWEEP_MINUTES out (default 15)", async () => {
    vi.stubGlobal("fetch", github());
    const before = Date.now();
    for (const [minutes, expected] of [[undefined, 15], ["5", 5]] as const) {
      const { ctx, storage } = fakeCtx();
      await new Scheduler(ctx, fakeEnv(() => ({}), { SWEEP_MINUTES: minutes }).env).alarm();
      const at = storage.setAlarm.mock.calls[0]![0] as number;
      expect(Math.round((at - before) / 60_000)).toBe(expected);
    }
  });

  it("/ensure arms a missing alarm, and leaves an existing one alone", async () => {
    const empty = fakeCtx(null);
    await new Scheduler(empty.ctx, fakeEnv(() => ({})).env).fetch(new Request("https://s/ensure", { method: "POST" }));
    expect(empty.storage.setAlarm).toHaveBeenCalledOnce();
    const armed = fakeCtx(Date.now() + 60_000);
    await new Scheduler(armed.ctx, fakeEnv(() => ({})).env).fetch(new Request("https://s/ensure", { method: "POST" }));
    expect(armed.storage.setAlarm).not.toHaveBeenCalled();
  });

  it("asks each candidate's own DO, in shadow unless enforced for that repo, and logs a sweep row", async () => {
    vi.stubGlobal("fetch", github());
    const { ctx } = fakeCtx();
    const { env, inserted, asked } = fakeEnv(() => ({ outcome: "would_refire", run: "issue-build-loop", idleMinutes: null }));
    const summary = await new Scheduler(ctx, env).sweep();
    expect(asked).toEqual([{ key: "hifi-phil/umbraco-mcp-ops#7", body: { owner: "hifi-phil", repo: "umbraco-mcp-ops", issueNumber: 7, enforced: false } }]);
    expect(summary).toMatchObject({ checked: 1, wouldRefire: ["hifi-phil/umbraco-mcp-ops#7"], refired: [], errors: [] });
    expect(inserted[0]).toEqual(expect.arrayContaining(["_scheduler", "sweep", "shadow"]));
  });

  it("SWEEP_ENFORCE_REPOS enforces for just that repo; a sweep can be limited to some repos", async () => {
    vi.stubGlobal("fetch", github());
    const { ctx } = fakeCtx();
    const { env, asked } = fakeEnv(() => ({ outcome: "refired" }), { SWEEP_ENFORCE_REPOS: "hifi-phil/umbraco-mcp-ops" });
    const summary = await new Scheduler(ctx, env).sweep(["hifi-phil/umbraco-mcp-ops"]);
    expect(summary.repos).toEqual(["hifi-phil/umbraco-mcp-ops"]);
    expect(asked[0]!.body.enforced).toBe(true);
    expect(summary.refired).toEqual(["hifi-phil/umbraco-mcp-ops#7"]);
  });
});
