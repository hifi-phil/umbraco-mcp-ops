import { describe, expect, it } from "vitest";
import { attachedRepos, effectText, handleStatus, renderStatus, when, type StatusRow } from "../src/status-page";
import { setControl } from "../src/controls";

const REPOS = JSON.stringify({ "Hifi-Phil/umbraco-mcp-ops": { fireUrl: "x", token: "secret-token" }, "hifi-phil/mcp-ops-e2e-testing": {} });

const row = (overrides: Partial<StatusRow> = {}): StatusRow => ({
  owner: "hifi-phil",
  repo: "umbraco-mcp-ops",
  issue_number: 412,
  state: "ready-for-ai",
  routine: "issue-build-loop",
  attempt: 1,
  running: 1,
  last_step: null,
  last_step_at: null,
  rework_count: 0,
  updated_at: "2026-10-03 10:00:00",
  ...overrides,
});

/** A fake D1 that answers by SQL: issue_status, transitions, repo_controls. */
function fakeDb(data: { status?: StatusRow[]; log?: unknown[]; controls?: unknown[] } = {}) {
  const writes: { sql: string; args: unknown[] }[] = [];
  const answer = (sql: string, args: unknown[]) => ({
    all: async () => ({
      results: sql.includes("FROM transitions") ? (data.log ?? []) : sql.includes("FROM repo_controls") ? (data.controls ?? []) : (data.status ?? []),
    }),
    first: async () => (data.status ?? []).find((r) => r.issue_number === args[2]) ?? null,
    run: async () => (writes.push({ sql, args }), { success: true }),
  });
  const db = {
    prepare: (sql: string) => ({ ...answer(sql, []), bind: (...args: unknown[]) => ({ ...answer(sql, args), sql, args }) }),
    batch: async (stmts: { sql: string; args: unknown[] }[]) => stmts.map((s) => (writes.push({ sql: s.sql, args: s.args }), { success: true })),
  } as unknown as D1Database;
  return { db, writes };
}

const KEY = { Authorization: "Bearer s3cret" };
const env = (db: D1Database) => ({ DB: db, STATUS_SECRET: "s3cret", REPO_ROUTINES_JSON: REPOS });
const get = (path: string, headers: Record<string, string> = KEY) => {
  const req = new Request(`https://w.dev${path}`, { headers });
  return { req, url: new URL(req.url) };
};

describe("attachedRepos — the repos the switcher lists", () => {
  it("REPO_ROUTINES_JSON's keys, lowercased and sorted (never its values: they hold fire tokens)", () => {
    expect(attachedRepos({ DB: {} as D1Database, REPO_ROUTINES_JSON: REPOS })).toEqual(["hifi-phil/mcp-ops-e2e-testing", "hifi-phil/umbraco-mcp-ops"]);
    expect(attachedRepos({ DB: {} as D1Database, REPO_ROUTINES_JSON: "not json" })).toEqual([]);
  });
});

describe("the overview's repository switcher", () => {
  const now = Date.parse("2026-10-03T10:10:00Z");
  const rows = [row(), row({ repo: "mcp-ops-e2e-testing", issue_number: 9, running: 0 })];
  const nav = { repos: ["hifi-phil/mcp-ops-e2e-testing", "hifi-phil/umbraco-mcp-ops"], current: null as string | null };

  it("lists every attached repo with its count; All is current by default", () => {
    const html = renderStatus(rows, now, "octo", nav);
    expect(html).toContain('<a href="/status" aria-current="page">All repositories <span class="count">2</span></a>');
    expect(html).toContain('<a href="/status?repo=hifi-phil%2Fumbraco-mcp-ops">hifi-phil/umbraco-mcp-ops <span class="count">1</span></a>');
    expect(html).toContain('<a href="/status?repo=hifi-phil%2Fmcp-ops-e2e-testing">hifi-phil/mcp-ops-e2e-testing <span class="count">1</span></a>');
  });

  it("a picked repo shows only its issues, marks its tab, and links its settings", () => {
    const html = renderStatus(rows, now, "octo", { ...nav, current: "hifi-phil/mcp-ops-e2e-testing" });
    expect(html).toContain('aria-current="page">hifi-phil/mcp-ops-e2e-testing');
    expect(html).toContain("n=9");
    expect(html).not.toContain("n=412");
    expect(html).toContain('href="/status/repo?repo=hifi-phil%2Fmcp-ops-e2e-testing">Repository settings</a>');
    expect(html).toContain('<div class="stat-title">Tracked</div><div class="stat-value">1</div>');
  });

  it("?repo= for a repo that isn't attached is ignored (all shown)", async () => {
    const { db } = fakeDb({ status: rows });
    const { req, url } = get("/status?repo=evil/repo");
    const html = await (await handleStatus(req, env(db), url)).text();
    expect(html).toContain('<a href="/status" aria-current="page">');
  });
});

describe("GET /status/issue — one issue's D1 log", () => {
  const log = [
    { id: 2, delivery_id: null, from_state: "ready-for-ai", event: "watchdog_expired", to_effect: '{"kind":"label","value":"ai-stuck"}', run: null, dropped_reason: null, mode: "enforce", created_at: "2026-10-03 10:05:00" },
    { id: 1, delivery_id: "d0c1e2f3-aaaa", from_state: "none", event: "labelled_ai_ready", to_effect: '{"kind":"label","value":"ready-for-ai"}', run: "issue-build-loop", dropped_reason: null, mode: "enforce", created_at: "2026-10-03 10:00:00" },
  ];

  it("shows its current status and every row, newest first, with time, event, effect, routine, mode and delivery", async () => {
    const { db } = fakeDb({ status: [row()], log });
    const { req, url } = get("/status/issue?repo=HIFI-PHIL/umbraco-mcp-ops&n=412");
    const res = await handleStatus(req, env(db), url);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("hifi-phil/umbraco-mcp-ops#412");
    expect(html.indexOf("watchdog_expired")).toBeLessThan(html.indexOf("labelled_ai_ready"));
    expect(html).toContain("03-10-2026 10:00:00 UTC");
    expect(html).toContain("→ ai-stuck");
    expect(html).toContain("delivery d0c1e2f3");
    expect(html).toContain("no delivery");
    expect(html).toContain('<meta http-equiv="refresh"');
  });

  it("an issue that isn't tracked still shows its log, saying it's not tracked", async () => {
    const { db } = fakeDb({ log });
    const { req, url } = get("/status/issue?repo=hifi-phil/umbraco-mcp-ops&n=7");
    const html = await (await handleStatus(req, env(db), url)).text();
    expect(html).toContain("Not tracked right now");
    expect(html).toContain("labelled_ai_ready");
  });

  it("a repo that isn't attached, or no number -> 400 with the lookup form, nothing read", async () => {
    const { db } = fakeDb({ log });
    for (const q of ["?repo=evil/repo&n=1", "?repo=hifi-phil/umbraco-mcp-ops", "?repo=hifi-phil/umbraco-mcp-ops&n=-3", "?repo=hifi-phil/umbraco-mcp-ops&n=1.5"]) {
      const { req, url } = get(`/status/issue${q}`);
      const res = await handleStatus(req, env(db), url);
      expect(res.status, q).toBe(400);
      expect(await res.text()).toContain('action="/status/issue"');
    }
  });
});

describe("GET /status/repo and POST /status/controls — a repo's switches", () => {
  it("the sweep is on by default, with a Turn off form for that repo; says what it does there", async () => {
    const { db } = fakeDb();
    const { req, url } = get("/status/repo?repo=hifi-phil/umbraco-mcp-ops");
    const html = await (await handleStatus(req, env(db), url)).text();
    expect(html).toContain("Reconciliation sweep");
    expect(html).toContain('<span class="tag positive">On</span>');
    expect(html).toContain('<input type="hidden" name="enabled" value="0">');
    expect(html).toContain("Default: never changed");
    expect(html).toContain("only logs what it would re-fire (shadow)");
  });

  it("switched off -> says so, who did it, and offers Turn on", async () => {
    const { db } = fakeDb({ controls: [{ owner: "hifi-phil", repo: "umbraco-mcp-ops", control: "sweep", enabled: 0, updated_by: "octo", updated_at: "2026-10-03 09:00:00" }] });
    const { req, url } = get("/status/repo?repo=hifi-phil/umbraco-mcp-ops");
    const html = await (await handleStatus(req, env(db), url)).text();
    expect(html).toContain('<span class="tag quiet">Off</span>');
    expect(html).toContain("Changed by octo");
    expect(html).toContain('<input type="hidden" name="enabled" value="1">');
  });

  const post = (body: Record<string, string>, headers: Record<string, string>) => {
    const req = new Request("https://w.dev/status/controls", { method: "POST", headers, body: new URLSearchParams(body) });
    return { req, url: new URL(req.url) };
  };

  it("a form from this origin switches it, logs a control_changed row, and goes back to the repo page", async () => {
    const { db, writes } = fakeDb();
    const { req, url } = post({ repo: "Hifi-Phil/umbraco-mcp-ops", control: "sweep", enabled: "0" }, { ...KEY, Origin: "https://w.dev" });
    const res = await handleStatus(req, env(db), url);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/status/repo?repo=hifi-phil%2Fumbraco-mcp-ops&saved=1");
    expect(writes.find((w) => w.sql.includes("INSERT INTO repo_controls"))!.args).toEqual(["hifi-phil", "umbraco-mcp-ops", "sweep", 0, "script"]);
    expect(writes.find((w) => w.sql.includes("control_changed"))!.args).toEqual(["hifi-phil", "umbraco-mcp-ops", '{"control":"sweep","enabled":false,"by":"script"}']);
  });

  it("refuses: a signed-in person's post from another origin (or none), a repo not attached, an unknown control, a bad value", async () => {
    const { db, writes } = fakeDb();
    const { signSession } = await import("../src/auth");
    const token = await signSession({ login: "octo", email: "octo@umbraco.dk", exp: Math.floor(Date.now() / 1000) + 60 }, "k");
    const person = { Cookie: `ao_session=${encodeURIComponent(token)}` };
    const signIn = { GITHUB_OAUTH_CLIENT_ID: "Iv1", GITHUB_OAUTH_CLIENT_SECRET: "cs", SESSION_SECRET: "k" };
    const cases: [Record<string, string>, Record<string, string>, number][] = [
      [{ repo: "hifi-phil/umbraco-mcp-ops", control: "sweep", enabled: "0" }, { ...person, Origin: "https://evil.io" }, 403],
      [{ repo: "hifi-phil/umbraco-mcp-ops", control: "sweep", enabled: "0" }, person, 403],
      [{ repo: "evil/repo", control: "sweep", enabled: "0" }, { ...KEY }, 400],
      [{ repo: "hifi-phil/umbraco-mcp-ops", control: "deploy", enabled: "0" }, { ...KEY }, 400],
      [{ repo: "hifi-phil/umbraco-mcp-ops", control: "sweep", enabled: "maybe" }, { ...KEY }, 400],
    ];
    for (const [body, headers, status] of cases) {
      const { req, url } = post(body, headers);
      expect((await handleStatus(req, { ...env(db), ...signIn }, url)).status, JSON.stringify([body, headers])).toBe(status);
    }
    expect(writes).toEqual([]);
  });

  it("a signed-in person's post from this origin is recorded under their login", async () => {
    const { db, writes } = fakeDb();
    const { signSession } = await import("../src/auth");
    const token = await signSession({ login: "octo", email: "octo@umbraco.dk", exp: Math.floor(Date.now() / 1000) + 60 }, "k");
    const { req, url } = post({ repo: "hifi-phil/umbraco-mcp-ops", control: "sweep", enabled: "1" }, { Cookie: `ao_session=${encodeURIComponent(token)}`, Origin: "https://w.dev" });
    const res = await handleStatus(req, { ...env(db), GITHUB_OAUTH_CLIENT_ID: "Iv1", GITHUB_OAUTH_CLIENT_SECRET: "cs", SESSION_SECRET: "k" }, url);
    expect(res.status).toBe(303);
    expect(writes.find((w) => w.sql.includes("INSERT INTO repo_controls"))!.args).toEqual(["hifi-phil", "umbraco-mcp-ops", "sweep", 1, "octo"]);
  });

  it("not signed in -> a POST is refused (401), never sent to sign-in", async () => {
    const { db } = fakeDb();
    const { req, url } = post({ repo: "hifi-phil/umbraco-mcp-ops", control: "sweep", enabled: "0" }, { Origin: "https://w.dev" });
    const res = await handleStatus(req, { ...env(db), GITHUB_OAUTH_CLIENT_ID: "Iv1", GITHUB_OAUTH_CLIENT_SECRET: "cs", SESSION_SECRET: "k" }, url);
    expect(res.status).toBe(401);
  });
});

describe("setControl", () => {
  it("upserts the switch and logs it, in one batch", async () => {
    const { db, writes } = fakeDb();
    await setControl(db, "Hifi-Phil", "Repo", "sweep", true, "octo");
    expect(writes).toHaveLength(2);
    expect(writes[0]!.sql).toMatch(/ON CONFLICT \(owner, repo, control\) DO UPDATE/);
  });
});

describe("log formatting", () => {
  it("effects in words", () => {
    expect(effectText('{"kind":"label","value":"ai-stuck"}')).toBe("→ ai-stuck");
    expect(effectText('{"kind":"close"}')).toBe("closed");
    expect(effectText('{"kind":"unlabel"}')).toBe("label removed");
    expect(effectText('{"kind":"noop"}')).toBe("no change");
    expect(effectText('{"kind":"noop","held":"mode_shadow"}')).toBe("nothing (held: mode_shadow)");
    expect(effectText('{"kind":"manual","change":"-ai-blocked"}')).toBe("by hand: -ai-blocked");
    expect(effectText(null)).toBe("");
    expect(effectText("not json")).toBe("not json");
  });

  it("times as DD-MM-YYYY HH:MM:SS UTC", () => {
    expect(when("2026-10-03 09:05:07")).toBe("03-10-2026 09:05:07 UTC");
    expect(when("2026-10-03T09:05:07.000Z")).toBe("03-10-2026 09:05:07 UTC");
  });
});
