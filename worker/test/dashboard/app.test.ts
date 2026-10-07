// The dashboard through its Hono routes, against a real SQLite database
// seeded through the repositories: what a request gets, and what it writes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { dashboard } from "../../src/dashboard/app";
import type { DashboardEnv } from "../../src/dashboard/model";
import { signSession } from "../../src/auth";
import * as controls from "../../src/db/controls";
import * as issueStatus from "../../src/db/issue-status";
import * as items from "../../src/db/items";
import * as transitions from "../../src/db/transitions";
import * as logEntries from "../../src/db/log-entries";
import type { TransitionRow } from "../../src/coordinate";
import { testDb, type TestDb } from "../db/sqlite-d1";
import { LABELS } from "@orchestrator/graph/constants/labels";

afterEach(() => vi.unstubAllGlobals());

const OPS = "hifi-phil/umbraco-mcp-ops";
const SANDBOX = "hifi-phil/mcp-ops-e2e-testing";
const SIGN_IN = { GITHUB_OAUTH_CLIENT_ID: "Iv1", GITHUB_OAUTH_CLIENT_SECRET: "cs", SESSION_SECRET: "sess-key" };
const KEY = { Authorization: "Bearer s3cret" };

function env(db: TestDb, extra: Partial<DashboardEnv> = {}): DashboardEnv {
  return {
    DB: db,
    STATUS_SECRET: "s3cret",
    REPO_ROUTINES_JSON: JSON.stringify({ [OPS]: {}, [SANDBOX]: {} }),
    LOG_READ_REPOS: SANDBOX,
    ...SIGN_IN,
    ...extra,
  };
}

const person = async (login = "octo") => ({
  Cookie: `ao_session=${encodeURIComponent(await signSession({ login, email: `${login}@umbraco.dk`, exp: Math.floor(Date.now() / 1000) + 60 }, "sess-key"))}`,
});

/** A log row, and the summary the issue DO keeps with it. */
async function log(db: TestDb, n: number, event: string, o: Partial<TransitionRow> = {}, repo = "umbraco-mcp-ops") {
  const row: TransitionRow = {
    deliveryId: `d-${n}-${event}`,
    owner: "hifi-phil",
    repo,
    issueNumber: n,
    fromState: "none",
    event,
    toEffect: null,
    run: null,
    droppedReason: null,
    mode: "enforce",
    actor: null,
    ...o,
  };
  await transitions.insert(db, row);
  await items.recordLogged(db, row.owner, row.repo, n, event);
}

const get = (db: TestDb, path: string, headers: Record<string, string> = KEY, extra: Partial<DashboardEnv> = {}, ctx?: ExecutionContext) =>
  dashboard.request(path, { headers }, env(db, extra), ctx);

describe("who gets in", () => {
  it("off (404) without STATUS_SECRET", async () => {
    expect((await get(testDb(), "/status", KEY, { STATUS_SECRET: undefined })).status).toBe(404);
  });

  it("no session: a GET goes to sign-in and comes back; a POST is refused", async () => {
    const db = testDb();
    const res = await get(db, "/status?type=pr", {});
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/login?next=%2Fstatus%3Ftype%3Dpr");
    const post = await dashboard.request("/status/controls", { method: "POST", headers: { Origin: "http://localhost" } }, env(db));
    expect(post.status).toBe(401);
  });

  it("no sign-in set up: a plain 401", async () => {
    const res = await get(testDb(), "/status", {}, { GITHUB_OAUTH_CLIENT_ID: undefined });
    expect(res.status).toBe(401);
  });

  it("a session: the page, never cached, script-free, naming who's signed in", async () => {
    const res = await get(testDb(), "/status", await person());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Security-Policy")).toMatch(/default-src 'none'.*form-action 'self'/);
    const html = await res.text();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toMatch(/octo<a href="\/auth\/logout">Sign out<\/a>/);
    expect(html).not.toMatch(/<script/i);
  });

  it("a session signed with another key isn't one", async () => {
    const forged = `ao_session=${encodeURIComponent(await signSession({ login: "x", email: "x@umbraco.dk", exp: Math.floor(Date.now() / 1000) + 60 }, "other"))}`;
    expect((await get(testDb(), "/status", { Cookie: forged })).status).toBe(302);
  });
});

describe("GET /status — the list", () => {
  async function seeded() {
    const db = testDb();
    await log(db, 1, "labelled_ai_ready", { run: "issue-build-loop" });
    await issueStatus.upsertTransition(db, { owner: "hifi-phil", repo: "umbraco-mcp-ops", issueNumber: 1 }, { state: LABELS.AI_READY, run: "issue-build-loop", running: true, reworkCount: 0 });
    await items.upsertMeta(db, "hifi-phil", "umbraco-mcp-ops", 1, { kind: "issue", title: "Build <the> thing", state: "open" });
    await log(db, 2, "labelled_auto_merging");
    await log(db, 3, "watchdog_expired", { actor: "watchdog" });
    await issueStatus.upsertTransition(db, { owner: "hifi-phil", repo: "umbraco-mcp-ops", issueNumber: 3 }, { state: LABELS.AI_STUCK, run: null, running: false, reworkCount: 0 });
    await log(db, 9, "build_blocked", {}, "mcp-ops-e2e-testing");
    return db;
  }

  it("every logged item, titles escaped, running and stuck first, the sandbox tagged", async () => {
    const html = await (await get(await seeded(), "/status")).text();
    expect(html).toContain("Build &lt;the&gt; thing");
    const order = [1, 3].map((n) => html.indexOf(`<span class="num">#${n}</span>`));
    expect(order[0]).toBeGreaterThan(0);
    expect(order[0]).toBeLessThan(order[1]!);
    expect(html).toMatch(/hifi-phil\/mcp-ops-e2e-testing <span class="e2e">e2e<\/span>/);
    expect(html).toContain("Showing all 4");
  });

  it("pills count within the other filters, and narrow the list", async () => {
    const db = await seeded();
    const all = await (await get(db, "/status")).text();
    expect(all).toMatch(/Pull requests <span class="count">1<\/span>/);
    expect(all).toMatch(/Needs attention <span class="count">1<\/span>/);
    const prs = await (await get(db, "/status?type=pr")).text();
    expect(prs).toContain('<span class="num">#2</span>');
    expect(prs).not.toContain('<span class="num">#1</span>');
  });

  it("?open= shows that item's log, newest first, and who caused each row", async () => {
    const db = await seeded();
    await log(db, 3, "labelled_ai_ready", { actor: "hifi-phil" });
    const html = await (await get(db, `/status?open=${OPS}/3`)).text();
    expect(html).toMatch(/Transitions <span class="muted">\(2, newest first\)/);
    expect(html.indexOf("labelled_ai_ready</code>")).toBeLessThan(html.indexOf("watchdog_expired</code>"));
    expect(html).toContain('by <span class="person">hifi-phil</span>');
    expect(html).toContain("by the watchdog");
  });

  it("Find with one match opens it; Close drops the Find", async () => {
    const html = await (await get(await seeded(), "/status?n=2")).text();
    expect(html).toContain('<div class="panel-log-title">');
    expect(html).toContain(`href="/status#i-hifi-phil-umbraco-mcp-ops-2" aria-label="Close the log"`);
  });

  it("pages at 100, Show more landing on the first new row", async () => {
    const db = testDb();
    for (let n = 1; n <= 130; n++) await log(db, n, "labelled_ai_ready");
    const html = await (await get(db, "/status")).text();
    expect(html.match(/class="row"/g)).toHaveLength(100);
    expect(html).toContain("Showing 1–100 of 130");
    expect(html).toMatch(/<a class="more" href="\/status\?limit=200#i-hifi-phil-umbraco-mcp-ops-\d+">Show 30 more of 30<\/a>/);
  });

  it("refreshes itself every 5 minutes, and says when it was updated", async () => {
    const html = await (await get(testDb(), "/status")).text();
    expect(html).toMatch(/<meta http-equiv="refresh" content="300"\s*\/?>/);
    expect(html).toMatch(/Updated \d\d:\d\d UTC · <a href="\/status">Refresh<\/a> · every 5 minutes/);
  });

  it("a repo whose sweep is off is flagged on its pill", async () => {
    const db = testDb();
    await controls.set(db, "hifi-phil", "umbraco-mcp-ops", "sweep", false, "octo");
    expect(await (await get(db, "/status")).text()).toContain(">sweep off</span>");
  });

  it("items with no title yet are looked up on GitHub after responding (the open one first); known ones aren't", async () => {
    const db = testDb();
    await log(db, 1, "labelled_ai_ready");
    await log(db, 2, "labelled_ai_ready");
    await items.upsertMeta(db, "hifi-phil", "umbraco-mcp-ops", 2, { kind: "issue", title: "Known", state: "open" });
    const looked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => (looked.push(String(url)), Response.json({ number: 1, title: "Looked up", state: "closed" })));
    const deferred: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => deferred.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    await get(db, "/status", KEY, { GITHUB_APP_TOKEN: "t" }, ctx);
    await Promise.all(deferred);
    expect(looked).toEqual(["https://api.github.com/repos/hifi-phil/umbraco-mcp-ops/issues/1"]);
    expect((await items.listSummaries(db)).find((i) => i.issue_number === 1)).toMatchObject({ title: "Looked up", gh_state: "closed" });
  });

  it("a list load never reads the transition log, or the work log", async () => {
    const db = testDb();
    await log(db, 1, "labelled_ai_ready");
    const sql: string[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = ((q: string) => (sql.push(q), prepare(q))) as typeof db.prepare;
    await get(db, "/status");
    expect(sql.some((q) => /FROM transitions/.test(q))).toBe(false);
    expect(sql.some((q) => /FROM log_entries/.test(q))).toBe(false);
  });

  const entry = (db: TestDb, item: number, kind: "journal" | "decision" | "build", body: string, refs?: number[]) =>
    logEntries.add(db, {
      owner: "hifi-phil",
      repo: "umbraco-mcp-ops",
      item,
      kind,
      category: kind === "build" ? null : "assumption",
      refs,
      routine: "issue-build-loop",
      body,
      tokenId: "t1",
    });
  it("a row with a work log shows its counts, from its items row", async () => {
    const db = await seeded();
    await entry(db, 1, "journal", "Decided: a.");
    await entry(db, 1, "journal", "Decided: b.");
    await entry(db, 1, "decision", "a — it matters", [1]);
    await entry(db, 1, "build", "Commit: c");
    const html = await (await get(db, "/status")).text();
    expect(html).toContain('<span class="work-log-count">1 decision, 2 journal entries, 1 build entry</span>');
  });

  it("?open= shows that item's work log too, oldest first: each entry's kind, category, id, refs and text", async () => {
    const db = await seeded();
    const journal = await entry(db, 3, "journal", "Decided: <cursors>.\nWhy: rows.");
    await entry(db, 3, "decision", "Cursors — it matters", [journal]);
    await entry(db, 3, "build", "Commit: abc");
    const html = await (await get(db, `/status?open=${OPS}/3`)).text();
    expect(html).toMatch(/Work log <span class="muted">\(3, oldest first\)/);
    expect(html).toContain('<span class="tag quiet">journal · assumption</span> <span class="muted">#1</span><pre class="entry">Decided: &lt;cursors&gt;.\nWhy: rows.</pre>');
    expect(html).toContain('<span class="tag default">decision · assumption</span> <span class="muted">#2</span><span class="sub"> from journal #1</span>');
    expect(html.indexOf("Decided:")).toBeLessThan(html.indexOf("Commit: abc"));
    expect(html.indexOf("Work log")).toBeLessThan(html.indexOf("Transitions"));
  });

  it("?open= an item with no work log says so", async () => {
    const html = await (await get(await seeded(), `/status?open=${OPS}/3`)).text();
    expect(html).toContain("Nothing in the work log yet.");
  });

  it("?format=json: the issue_status rows (scripts, e2e)", async () => {
    const db = testDb();
    await issueStatus.upsertTransition(db, { owner: "o", repo: "r", issueNumber: 1 }, { state: LABELS.AI_READY, run: "x", running: true, reworkCount: 0 });
    expect(await (await get(db, "/status?format=json")).json()).toMatchObject({ rows: [{ owner: "o", issue_number: 1 }] });
  });

  it("the old /status/issue link redirects into the list with it open", async () => {
    const res = await get(testDb(), `/status/issue?repo=${OPS}&n=412`);
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`/status?open=${encodeURIComponent(`${OPS}/412`)}`);
  });
});

describe("a repo's settings and switches", () => {
  const post = (db: TestDb, body: Record<string, string>, headers: Record<string, string>) =>
    dashboard.request("/status/controls", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body).toString() }, env(db));

  it("the sweep is on by default, with a Turn off form, saying what it does there", async () => {
    const html = await (await get(testDb(), `/status/repo?repo=${OPS}`)).text();
    expect(html).toContain("Reconciliation sweep");
    expect(html).toContain('<span class="tag positive">On</span>');
    expect(html).toMatch(/name="enabled" value="0"/);
    expect(html).toContain("Default: never changed");
    expect(html).toContain("only logs what it would re-fire (shadow)");
  });

  it("not an attached repo: a 404 page", async () => {
    const res = await get(testDb(), "/status/repo?repo=evil/repo");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("That isn&#39;t an attached repository.");
  });

  it("a person's post from this origin switches it, under their login, and says so back on the page", async () => {
    const db = testDb();
    const res = await post(db, { repo: "Hifi-Phil/umbraco-mcp-ops", control: "sweep", enabled: "0" }, { ...(await person()), Origin: "http://localhost" });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`/status/repo?repo=${encodeURIComponent(OPS)}&saved=sweep-off`);
    expect(await controls.forRepo(db, "hifi-phil", "umbraco-mcp-ops")).toMatchObject([{ control: "sweep", enabled: 0, updated_by: "octo" }]);
    const page = await (await get(db, res.headers.get("Location")!)).text();
    expect(page).toContain("Reconciliation sweep is now off.");
    expect(page).toContain("Changed by octo");
    expect(page).toContain("sweep turned off by octo");
  });

  it("the Bearer key can switch it too, as \"script\"", async () => {
    const db = testDb();
    expect((await post(db, { repo: OPS, control: "sweep", enabled: "0" }, KEY)).status).toBe(303);
    expect(await controls.forRepo(db, "hifi-phil", "umbraco-mcp-ops")).toMatchObject([{ updated_by: "script" }]);
  });

  it("refuses: another origin (or none), a repo not attached, an unknown control, a bad value; nothing written", async () => {
    const db = testDb();
    const p = await person();
    const cases: [Record<string, string>, Record<string, string>, number][] = [
      [{ repo: OPS, control: "sweep", enabled: "0" }, { ...p, Origin: "https://evil.io" }, 403],
      [{ repo: OPS, control: "sweep", enabled: "0" }, p, 403],
      [{ repo: "evil/repo", control: "sweep", enabled: "0" }, KEY, 400],
      [{ repo: OPS, control: "deploy", enabled: "0" }, KEY, 400],
      [{ repo: OPS, control: "sweep", enabled: "maybe" }, KEY, 400],
    ];
    for (const [body, headers, code] of cases) expect((await post(db, body, headers)).status, JSON.stringify([body, headers])).toBe(code);
    expect(await controls.forRepo(db, "hifi-phil", "umbraco-mcp-ops")).toEqual([]);
  });
});

describe("sign-in pages", () => {
  it("signed out: the shared layout, with a way back in", async () => {
    const res = await dashboard.request("/auth/signed-out", {}, env(testDb()));
    const html = await res.text();
    expect(html).toContain("You&#39;re signed out.");
    expect(html).toContain('href="/auth/login?next=/status"');
    expect(html).toContain('class="top-bar"');
  });
});
