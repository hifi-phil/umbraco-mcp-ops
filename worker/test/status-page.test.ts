import { describe, expect, it } from "vitest";
import { ago, handleStatus, renderStatus, type StatusRow } from "../src/status-page";

const row = (overrides: Partial<StatusRow> = {}): StatusRow => ({
  owner: "hifi-phil",
  repo: "umbraco-mcp-ops",
  issue_number: 412,
  state: "ready-for-ai",
  routine: "issue-build-loop",
  attempt: 1,
  running: 1,
  last_step: "running tests",
  last_step_at: "2026-10-02T10:00:00.000Z",
  rework_count: 0,
  updated_at: "2026-10-02 10:00:00",
  ...overrides,
});

function fakeDb(rows: StatusRow[]) {
  const queries: string[] = [];
  const db = {
    prepare: (sql: string) => {
      queries.push(sql);
      return { all: async () => ({ results: rows }) };
    },
  } as unknown as D1Database;
  return { db, queries };
}

const get = (headers: Record<string, string> = {}, query = "") =>
  new Request(`https://worker/status${query}`, { headers });
const basic = (password: string) => ({ Authorization: `Basic ${btoa(`anyone:${password}`)}` });

describe("GET /status — the live-status dashboard", () => {
  it("off (404) unless STATUS_SECRET is set", async () => {
    const { db } = fakeDb([]);
    const res = await handleStatus(get(basic("x")), { DB: db }, new URL("https://worker/status"));
    expect(res.status).toBe(404);
  });

  it("no or wrong credentials -> 401 with a Basic challenge (the browser's own prompt)", async () => {
    const { db } = fakeDb([]);
    const env = { DB: db, STATUS_SECRET: "s3cret" };
    for (const headers of [{}, basic("wrong"), { Authorization: "Bearer wrong" }, { Authorization: "Basic !!notbase64" }]) {
      const res = await handleStatus(get(headers), env, new URL("https://worker/status"));
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toMatch(/^Basic /);
    }
  });

  it("Basic (any user name) or Bearer with the secret -> the page, never cached", async () => {
    const { db } = fakeDb([row()]);
    const env = { DB: db, STATUS_SECRET: "s3cret" };
    for (const headers of [basic("s3cret"), { Authorization: "Bearer s3cret" }]) {
      const res = await handleStatus(get(headers), env, new URL("https://worker/status"));
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(await res.text()).toContain('issues/412">#412</a>');
    }
  });

  it("?format=json -> the rows, running first then most recent", async () => {
    const { db, queries } = fakeDb([row()]);
    const res = await handleStatus(get(basic("s3cret")), { DB: db, STATUS_SECRET: "s3cret" }, new URL("https://worker/status?format=json"));
    expect(await res.json()).toEqual({ rows: [row()] });
    expect(queries[0]).toMatch(/ORDER BY running DESC, updated_at DESC/);
  });
});

describe("renderStatus", () => {
  const now = Date.parse("2026-10-02T10:12:00Z");

  it("shows each row's state, routine, attempt, step and age; a running row is marked", () => {
    const html = renderStatus([row({ attempt: 2, rework_count: 1 })], now);
    expect(html).toContain('<span class="tag running"><span class="dot"></span>Running</span>');
    expect(html).toContain("issue-build-loop");
    expect(html).toContain("running tests");
    expect(html).toContain("12 min ago");
    expect(html).toContain('href="https://github.com/hifi-phil/umbraco-mcp-ops/issues/412"');
    expect(html).toContain('<div class="stat-title">Tracked</div><div class="stat-value">1</div>');
    expect(html).toContain('<div class="stat-title">Running</div><div class="stat-value">1</div>');
  });

  it("tags trouble red, waiting-on-a-person amber, done green", () => {
    const html = renderStatus([row({ state: "ai-stuck" }), row({ state: "ai-blocked" }), row({ state: "generated-by-ai" })], now);
    expect(html).toContain('<span class="tag danger">ai-stuck</span>');
    expect(html).toContain('<span class="tag warning">ai-blocked</span>');
    expect(html).toContain('<span class="tag positive">generated-by-ai</span>');
  });

  it("escapes what came from a routine (a heartbeat step is free text)", () => {
    const html = renderStatus([row({ last_step: '<img src=x onerror="alert(1)">' })], now);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("reloads itself every 30 seconds", () => {
    expect(renderStatus([], now)).toContain('<meta http-equiv="refresh" content="30">');
  });

  it("nothing tracked -> says so", () => {
    expect(renderStatus([], now)).toContain("Nothing tracked right now.");
  });
});

describe("ago", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  it("reads D1's datetime and ISO strings alike", () => {
    expect(ago("2026-10-02 11:59:40", now)).toBe("just now");
    expect(ago("2026-10-02T11:30:00.000Z", now)).toBe("30 min ago");
    expect(ago("2026-10-02 09:00:00", now)).toBe("3 h ago");
    expect(ago("2026-09-28 12:00:00", now)).toBe("4 d ago");
    expect(ago(null, now)).toBe("");
  });
});
