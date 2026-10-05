import { afterEach, describe, expect, it, vi } from "vitest";
import { Scheduler, type SchedulerEnv } from "../src/scheduler";
import { LABELS } from "@orchestrator/graph/constants/labels";

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
    deleteAlarm: vi.fn(async () => {
      order.push("deleteAlarm");
      alarm = null;
    }),
  };
  return { ctx: { storage } as unknown as DurableObjectState, storage, order };
}

function fakeEnv(
  reconcile: (body: { issueNumber: number; enforced: boolean }) => unknown,
  overrides: Partial<SchedulerEnv> = {},
  sweepOff: { owner: string; repo: string }[] = [],
) {
  const inserted: unknown[][] = [];
  const asked: { key: string; body: { issueNumber: number; enforced: boolean } }[] = [];
  const env: SchedulerEnv = {
    GITHUB_APP_TOKEN: "t",
    REPO_ROUTINES_JSON: JSON.stringify({ "hifi-phil/umbraco-mcp-ops": {}, "hifi-phil/mcp-ops-e2e-testing": {} }),
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) =>
          sql.includes("repo_controls")
            ? { all: async () => ({ results: sweepOff }) }
            : (inserted.push(args), { run: async () => ({}) }),
      }),
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

/** GitHub: issue #7 has {@link LABELS.AI_READY} on the ops repo; nothing else anywhere. */
const github = () =>
  vi.fn(async (url: string) => {
    if (url.includes("/repos/hifi-phil/umbraco-mcp-ops/issues?") && url.includes(`labels=${LABELS.AI_READY}`)) {
      return Response.json([{ number: 7 }]);
    }
    return Response.json([]);
  });

describe("Scheduler", () => {
  it("each alarm sets the next one before sweeping, so a failed sweep keeps the chain going", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const { ctx, storage, order } = fakeCtx();
    const { env } = fakeEnv(() => ({}));
    await new Scheduler(ctx, env).alarm(); // the sweep's GitHub calls fail; alarm() mustn't throw
    expect(order).toEqual(["setAlarm"]);
    expect(await storage.getAlarm()).not.toBeNull();
  });

  it("a sweep with candidates keeps the 15-minute pace; a quiet one slows to hourly (not a stop) and logs nothing", async () => {
    vi.stubGlobal("fetch", github());
    const before = Date.now();
    const busy = fakeCtx();
    await new Scheduler(busy.ctx, fakeEnv(() => ({ outcome: "watched" })).env).alarm();
    expect(Math.round(((await busy.storage.getAlarm())! - before) / 60_000)).toBe(15);

    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
    const quiet = fakeCtx();
    const { env, inserted } = fakeEnv(() => ({}));
    await new Scheduler(quiet.ctx, env).alarm();
    expect(Math.round(((await quiet.storage.getAlarm())! - before) / 60_000), "still armed, hourly").toBe(60);
    expect(inserted, "no sweep row for a quiet sweep").toEqual([]);
  });

  it("only settled candidates (completed, already reported) -> not news: no row, nothing counted, and it slows to hourly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/repos/hifi-phil/umbraco-mcp-ops/issues?") && url.includes(`labels=${LABELS.AI_READY}`)
          ? Response.json([{ number: 1 }, { number: 2 }, { number: 3 }])
          : Response.json([]),
      ),
    );
    const before = Date.now();
    const { ctx, storage } = fakeCtx();
    const { env, inserted } = fakeEnv((b) =>
      b.issueNumber === 1
        ? { outcome: "completed" }
        : b.issueNumber === 2
          ? { outcome: "would_refire", run: "issue-build-loop", idleMinutes: 90, alreadyLogged: true }
          : { outcome: "not_triggered", state: LABELS.AI_STUCK },
    );
    await new Scheduler(ctx, env).alarm();
    expect(Math.round(((await storage.getAlarm())! - before) / 60_000)).toBe(60);
    expect(inserted, "no sweep row for repeats").toEqual([]);
    expect(await new Scheduler(ctx, env).sweep()).toMatchObject({ checked: 3, live: 0, wouldRefire: [] });
  });

  it("a recently active candidate keeps the 15-minute pace (it could be left behind soon)", async () => {
    vi.stubGlobal("fetch", github());
    const before = Date.now();
    const { ctx, storage } = fakeCtx();
    const { env, inserted } = fakeEnv(() => ({ outcome: "recent", idleMinutes: 3 }));
    await new Scheduler(ctx, env).alarm();
    expect(Math.round(((await storage.getAlarm())! - before) / 60_000)).toBe(15);
    expect(inserted).toEqual([]);
  });

  it("/ensure brings a slowed (hourly) alarm back to the normal interval", async () => {
    const { ctx, storage } = fakeCtx(Date.now() + 60 * 60_000);
    await new Scheduler(ctx, fakeEnv(() => ({})).env).fetch(new Request("https://s/ensure", { method: "POST" }));
    expect(Math.round(((await storage.getAlarm())! - Date.now()) / 60_000)).toBe(15);
  });

  it("/ensure never waits on a running sweep (webhooks must stay fast)", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await held;
        return Response.json([]);
      }),
    );
    const { ctx } = fakeCtx(Date.now() + 60_000);
    const scheduler = new Scheduler(ctx, fakeEnv(() => ({})).env);
    const sweeping = scheduler.alarm();
    const res = await scheduler.fetch(new Request("https://s/ensure", { method: "POST" })); // resolves with the sweep still held
    expect(res.status).toBe(200);
    release();
    await sweeping;
  });

  it("a webhook landing during a quiet sweep keeps the normal pace", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await held; // the sweep is mid-listing when the webhook's /ensure arrives
        return Response.json([]);
      }),
    );
    const { ctx, storage } = fakeCtx();
    const scheduler = new Scheduler(ctx, fakeEnv(() => ({})).env);
    const sweeping = scheduler.alarm();
    const ensuring = scheduler.fetch(new Request("https://s/ensure", { method: "POST" }));
    release();
    await sweeping;
    await ensuring;
    expect(Math.round(((await storage.getAlarm())! - Date.now()) / 60_000), "kept at the normal pace").toBe(15);
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

  it("at most SWEEP_MAX_REFIRES re-fires per sweep; the rest are asked in shadow for next time", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/repos/hifi-phil/umbraco-mcp-ops/issues?") && url.includes(`labels=${LABELS.AI_READY}`)
          ? Response.json([{ number: 1 }, { number: 2 }, { number: 3 }])
          : Response.json([]),
      ),
    );
    const { ctx } = fakeCtx();
    const { env, asked } = fakeEnv((b) => ({ outcome: b.enforced ? "refired" : "would_refire" }), {
      SWEEP_MODE: "enforce",
      SWEEP_MAX_REFIRES: "2",
    });
    const summary = await new Scheduler(ctx, env).sweep();
    expect(asked.map((a) => a.body.enforced)).toEqual([true, true, false]);
    expect(summary.refired).toHaveLength(2);
    expect(summary.wouldRefire).toEqual(["hifi-phil/umbraco-mcp-ops#3"]);
  });

  it("one issue's DO failing is recorded, and the rest of the sweep still runs and logs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/repos/hifi-phil/umbraco-mcp-ops/issues?") && url.includes(`labels=${LABELS.AI_READY}`)
          ? Response.json([{ number: 1 }, { number: 2 }])
          : Response.json([]),
      ),
    );
    const { ctx } = fakeCtx();
    const { env, inserted } = fakeEnv((b) => {
      if (b.issueNumber === 1) throw new Error("DO reset");
      return { outcome: "watched" };
    });
    const summary = await new Scheduler(ctx, env).sweep();
    expect(summary.checked).toBe(2);
    expect(summary.errors).toEqual([expect.stringContaining("#1: DO reset")]);
    expect(inserted).toHaveLength(1);
  });

  it("a sweep that really re-fired (via SWEEP_ENFORCE_REPOS) logs its row as enforce, never shadow", async () => {
    vi.stubGlobal("fetch", github());
    const { ctx } = fakeCtx();
    const { env, inserted } = fakeEnv(() => ({ outcome: "refired" }), { SWEEP_ENFORCE_REPOS: "hifi-phil/umbraco-mcp-ops" });
    await new Scheduler(ctx, env).sweep();
    expect(inserted[0]).toEqual(expect.arrayContaining(["sweep", "enforce"]));
  });

  it("a repo whose sweep is switched off on the dashboard is skipped, never asked; the rest still sweep", async () => {
    vi.stubGlobal("fetch", github());
    const { ctx } = fakeCtx();
    const { env, asked } = fakeEnv(() => ({ outcome: "watched" }), {}, [{ owner: "hifi-phil", repo: "umbraco-mcp-ops" }]);
    const summary = await new Scheduler(ctx, env).sweep();
    expect(summary.paused).toEqual(["hifi-phil/umbraco-mcp-ops"]);
    expect(asked).toEqual([]);
    expect(summary.checked).toBe(0);
  });

  it("the switches can't be read -> nothing swept this time (never one that was turned off), and an error recorded", async () => {
    vi.stubGlobal("fetch", github());
    const { ctx } = fakeCtx();
    const { env, asked } = fakeEnv(() => ({ outcome: "watched" }));
    const broken = env.DB;
    env.DB = {
      prepare: (sql: string) => (sql.includes("repo_controls") ? { bind: () => ({ all: async () => { throw new Error("D1 down"); } }) } : broken.prepare(sql)),
    } as unknown as D1Database;
    const summary = await new Scheduler(ctx, env).sweep();
    expect(asked).toEqual([]);
    expect(summary.errors).toEqual([expect.stringContaining("controls: D1 down")]);
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
