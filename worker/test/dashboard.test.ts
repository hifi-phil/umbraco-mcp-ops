import { describe, expect, it } from "vitest";
import {
  attachedRepos,
  buildItems,
  effectText,
  handleStatus,
  listHref,
  readFilters,
  renderDashboard,
  when,
  type ActivityRow,
  type Filters,
  type Item,
  type ItemRow,
  type StatusRow,
} from "../src/status-page";
import { setControl } from "../src/controls";
import { signSession } from "../src/auth";

const OPS = "hifi-phil/umbraco-mcp-ops";
const SANDBOX = "hifi-phil/mcp-ops-e2e-testing";
const REPOS_JSON = JSON.stringify({ "Hifi-Phil/umbraco-mcp-ops": { fireUrl: "x", token: "secret-token" }, [SANDBOX]: {} });
const REPOS = [SANDBOX, OPS];

const status = (o: Partial<StatusRow> = {}): StatusRow => ({
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
  ...o,
});
const activity = (o: Partial<ActivityRow> = {}): ActivityRow => ({
  owner: "hifi-phil",
  repo: "umbraco-mcp-ops",
  issue_number: 412,
  event: "labelled_ai_ready",
  last_at: "2026-10-03 10:00:00",
  events: 1,
  pr_hint: 0,
  ...o,
});
const meta = (o: Partial<ItemRow> = {}): ItemRow => ({ owner: "hifi-phil", repo: "umbraco-mcp-ops", issue_number: 412, kind: "issue", title: "Add a thing", gh_state: "open", ...o });
const NO_FILTERS: Filters = { repo: null, type: "all", status: "all", n: null, open: null, limit: 100 };

describe("attachedRepos — the repos the pills list", () => {
  it("REPO_ROUTINES_JSON's keys, lowercased and sorted (never its values: they hold fire tokens)", () => {
    expect(attachedRepos({ DB: {} as D1Database, REPO_ROUTINES_JSON: REPOS_JSON })).toEqual(REPOS);
    expect(attachedRepos({ DB: {} as D1Database, REPO_ROUTINES_JSON: "not json" })).toEqual([]);
  });
});

describe("buildItems — the log's issues and PRs, with what's live and known", () => {
  it("joins the live status and the item's kind and title", () => {
    const [i] = buildItems([activity()], [status()], [meta()], REPOS);
    expect(i).toMatchObject({ repo: OPS, n: 412, kind: "issue", title: "Add a thing", closed: false, status: { state: "ready-for-ai" } });
  });

  it("an item from before the items table: a PR-only event makes it a PR; a closing last event makes it closed", () => {
    const [pr] = buildItems([activity({ event: "merged", pr_hint: 1 })], [], [], REPOS);
    expect(pr).toMatchObject({ kind: "pr", closed: true, merged: true, title: null });
    const [unknown] = buildItems([activity({ event: "build_blocked" })], [], [], REPOS);
    expect(unknown).toMatchObject({ kind: "issue", closed: false, known: false });
  });

  it("GitHub's state wins: a closed item never shows a stale live status", () => {
    const [i] = buildItems([activity()], [status()], [meta({ gh_state: "closed" })], REPOS);
    expect(i).toMatchObject({ closed: true, status: null });
  });

  it("drops a repo that isn't attached; matches case-insensitively", () => {
    expect(buildItems([activity({ owner: "evil", repo: "repo" })], [], [], REPOS)).toEqual([]);
    expect(buildItems([activity({ owner: "Hifi-Phil" })], [], [], REPOS)).toHaveLength(1);
  });
});

describe("filters in the URL", () => {
  it("reads them, dropping anything unknown to its default", () => {
    const f = readFilters(new URL(`https://w/status?type=pr&status=attention&repo=${encodeURIComponent(OPS.toUpperCase())}&n=7&open=${OPS}/7`), REPOS);
    expect(f).toEqual({ repo: OPS, type: "pr", status: "attention", n: 7, open: { repo: OPS, n: 7 }, limit: 100 });
    expect(readFilters(new URL("https://w/status?limit=300"), REPOS).limit).toBe(300);
    expect(readFilters(new URL("https://w/status?limit=99999"), REPOS).limit).toBe(1000);
    expect(readFilters(new URL("https://w/status?type=x&status=y&repo=evil/repo&n=-1&open=evil/repo/3"), REPOS)).toEqual(NO_FILTERS);
  });

  it("writes them back with the defaults left out", () => {
    expect(listHref(NO_FILTERS)).toBe("/status");
    expect(listHref(NO_FILTERS, { type: "pr", open: { repo: OPS, n: 9 } })).toBe(`/status?type=pr&open=${encodeURIComponent(`${OPS}/9`)}`);
  });
});

describe("renderDashboard — one list, pills, and the log beside it", () => {
  const now = Date.parse("2026-10-03T10:10:00Z");
  const items: Item[] = buildItems(
    [
      activity({ issue_number: 1, last_at: "2026-10-03 10:05:00" }),
      activity({ issue_number: 2, event: "labelled_auto_merging", pr_hint: 1, last_at: "2026-10-03 10:06:00" }),
      activity({ issue_number: 3, event: "watchdog_expired", last_at: "2026-10-03 10:07:00" }),
      activity({ issue_number: 4, event: "merged", pr_hint: 1, last_at: "2026-10-03 10:08:00" }),
      activity({ repo: "mcp-ops-e2e-testing", issue_number: 5, last_at: "2026-10-03 10:09:00" }),
    ],
    [status({ issue_number: 1, running: 1 }), status({ issue_number: 2, state: "auto-merge", running: 0 }), status({ issue_number: 3, state: "ai-stuck", running: 0 })],
    [meta({ issue_number: 1, title: "Build <the> thing" }), meta({ issue_number: 2, kind: "pr", title: "The thing" })],
    REPOS,
  );
  const render = (f: Partial<Filters> = {}, selected: Parameters<typeof renderDashboard>[0]["selected"] = null) =>
    renderDashboard({ items, filters: { ...NO_FILTERS, ...f }, repos: REPOS, selected, now, user: "octo" });

  it("lists everything, running first, then needing attention, then open, then the rest by latest activity", () => {
    const html = render();
    const order = [1, 3, 2, 5, 4].map((n) => html.indexOf(`<span class="num">#${n}</span>`));
    expect(order.every((x) => x >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("pills count within the other filters, and each is a link keeping them", () => {
    const html = render({ repo: OPS });
    expect(html).toContain(`>Pull requests <span class="count">2</span></a>`);
    // #1 known; #3 not known yet but has no PR-only event, so counted as an issue
    expect(html).toContain(`>Issues <span class="count">2</span></a>`);
    expect(html).toContain(`>Needs attention <span class="count">1</span></a>`);
    expect(html).toContain(`>Closed <span class="count">1</span></a>`);
    expect(html).toContain(`href="/status?repo=${encodeURIComponent(OPS)}&amp;type=pr"`);
    expect(html).toContain(`>All repositories <span class="count">5</span></a>`);
  });

  it("a filter narrows the list; the current pill is marked", () => {
    const html = render({ type: "pr" });
    expect(html).toContain('<span class="num">#2</span>');
    expect(html).not.toContain('<span class="num">#1</span>');
    expect(html).toMatch(/aria-current="true">Pull requests/);
    const attention = render({ status: "attention" });
    expect(attention).toContain('<span class="num">#3</span>');
    expect(attention).not.toContain('<span class="num">#2</span>');
  });

  it("each row opens its log in the panel; titles are escaped; an untitled one says its title is on its way", () => {
    const html = render();
    expect(html).toContain(`id="i-hifi-phil-umbraco-mcp-ops-1" href="/status?open=${encodeURIComponent(`${OPS}/1`)}#i-hifi-phil-umbraco-mcp-ops-1"`);
    expect(html).toContain("Build &lt;the&gt; thing");
    expect(html).toContain("Title on its way");
    expect(html).toContain("Pick an issue or pull request to see its log.");
  });

  it("the open one is marked, and its log shows beside the list, newest first", () => {
    const log = [
      { id: 2, delivery_id: null, from_state: "ready-for-ai", event: "watchdog_expired", to_effect: '{"kind":"label","value":"ai-stuck"}', run: null, dropped_reason: null, mode: "enforce", created_at: "2026-10-03 10:07:00" },
      { id: 1, delivery_id: "d0c1e2f3-aaaa", from_state: "none", event: "labelled_ai_ready", to_effect: '{"kind":"label","value":"ready-for-ai"}', run: "issue-build-loop", dropped_reason: null, mode: "enforce", created_at: "2026-10-03 10:00:00" },
    ];
    const html = render({ open: { repo: OPS, n: 3 } }, { item: items.find((i) => i.n === 3)!, log });
    expect(html).toMatch(/class="row selected"[^>]*>\s*<span class="row-main"><span class="num">#3</);
    expect(html.indexOf("watchdog_expired</code><div")).toBeLessThan(html.indexOf("labelled_ai_ready</code><div"));
    expect(html).toContain("03-10-2026 10:00:00 UTC");
    expect(html).toContain("→ ai-stuck");
    expect(html).toContain("delivery d0c1e2f3");
    expect(html).toContain(`href="/status#i-hifi-phil-umbraco-mcp-ops-3" aria-label="Close the log"`);
    // the selected row's own link closes it again, and its log is also under it for narrow screens
    expect(html).toContain(`id="i-hifi-phil-umbraco-mcp-ops-3" href="/status#i-hifi-phil-umbraco-mcp-ops-3"`);
    expect(html).toContain('<div class="inline-log"><div class="box panel">');
  });

  it("pages the list: the first 100, then Show more", () => {
    const many: Item[] = buildItems(
      Array.from({ length: 130 }, (_, k) => activity({ issue_number: k + 1, last_at: `2026-10-03 0${Math.floor(k / 60)}:${String(k % 60).padStart(2, "0")}:00` })),
      [],
      [],
      REPOS,
    );
    const html = renderDashboard({ items: many, filters: NO_FILTERS, repos: REPOS, selected: null, now });
    expect(html.match(/class="row"/g)).toHaveLength(100);
    expect(html).toContain('<div class="list-head">Showing 1–100 of 130</div>');
    expect(html).toMatch(/<a class="more" href="\/status\?limit=200#i-hifi-phil-umbraco-mcp-ops-\d+">Show 30 more of 30<\/a>/);
    expect(html).toContain('>All types <span class="count">130</span>');
  });

  it("a repo whose sweep is off is flagged on its pill", () => {
    const html = renderDashboard({ items, filters: NO_FILTERS, repos: [OPS], sweepOff: [OPS], selected: null, now });
    expect(html).toContain('<span class="paused" title="Its reconciliation sweep is switched off">sweep off</span>');
  });

  it("the e2e sandbox is tagged, in its pill and its rows", () => {
    const html = renderDashboard({ items, filters: NO_FILTERS, repos: [OPS, SANDBOX], sandbox: [SANDBOX], selected: null, now });
    expect(html).toContain(`${SANDBOX} <span class="e2e">e2e</span> <span class="count">1</span>`);
    expect(html).toContain(`${SANDBOX} <span class="e2e">e2e</span> · <code>`);
  });

  it("an item GitHub no longer has says so; one open on GitHub counts as open though untracked", () => {
    const [gone, open] = buildItems(
      [activity({ issue_number: 8 }), activity({ issue_number: 9, event: "build_blocked" })],
      [],
      [meta({ issue_number: 8, title: "", gh_state: null }), meta({ issue_number: 9, gh_state: "open" })],
      REPOS,
    );
    const html = renderDashboard({ items: [gone!, open!], filters: { ...NO_FILTERS, status: "open" }, repos: REPOS, selected: null, now });
    expect(html).toContain('<span class="num">#9</span>');
    expect(html).not.toContain('<span class="num">#8</span>');
    expect(renderDashboard({ items: [gone!], filters: NO_FILTERS, repos: REPOS, selected: null, now })).toContain("Not on GitHub any more");
  });
});

/** A fake D1 answering by SQL. */
function fakeDb(data: { activity?: ActivityRow[]; status?: StatusRow[]; items?: ItemRow[]; log?: unknown[]; controls?: unknown[] } = {}) {
  const writes: { sql: string; args: unknown[] }[] = [];
  // The list reads the items summary: each activity row, with its item's
  // kind, title and state where there is one.
  const summary = () =>
    (data.activity ?? []).map((a) => {
      const m = (data.items ?? []).find((i) => i.issue_number === a.issue_number && i.repo === a.repo);
      return { ...a, last_event: a.event, kind: m?.kind ?? null, title: m?.title ?? null, gh_state: m?.gh_state ?? null };
    });
  const results = (sql: string) =>
    sql.includes("FROM items WHERE events > 0")
      ? summary()
      : sql.includes("FROM transitions")
        ? (data.log ?? [])
        : sql.includes("FROM repo_controls")
          ? (data.controls ?? [])
          : (data.status ?? []);
  const stmt = (sql: string, args: unknown[]) => ({
    sql,
    args,
    all: async () => ({ results: results(sql) }),
    run: async () => (writes.push({ sql, args }), { success: true }),
  });
  const db = {
    prepare: (sql: string) => ({ ...stmt(sql, []), bind: (...args: unknown[]) => stmt(sql, args) }),
    batch: async (stmts: { sql: string; args: unknown[] }[]) => stmts.map((s) => (writes.push({ sql: s.sql, args: s.args }), { success: true })),
  } as unknown as D1Database;
  return { db, writes };
}

const KEY = { Authorization: "Bearer s3cret" };
const env = (db: D1Database) => ({ DB: db, STATUS_SECRET: "s3cret", REPO_ROUTINES_JSON: REPOS_JSON });
const get = (path: string, headers: Record<string, string> = KEY) => {
  const req = new Request(`https://w.dev${path}`, { headers });
  return { req, url: new URL(req.url) };
};

describe("GET /status — the handler", () => {
  it("items with no title yet on this page are looked up on GitHub after responding; known ones aren't", async () => {
    const { db } = fakeDb({ activity: [activity({ issue_number: 1 }), activity({ issue_number: 2 })], items: [meta({ issue_number: 2 })] });
    const deferred: Promise<unknown>[] = [];
    const looked: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      looked.push(String(url));
      return Response.json({ number: 1, title: "Looked up", state: "closed" });
    }) as typeof fetch;
    try {
      const { req, url } = get("/status");
      await handleStatus(req, { ...env(db), GITHUB_APP_TOKEN: "t" }, url, (w) => deferred.push(w));
      await Promise.all(deferred);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(looked).toEqual(["https://api.github.com/repos/hifi-phil/umbraco-mcp-ops/issues/1"]);
  });

  it("?open= reads that item's log and shows it", async () => {
    const { db } = fakeDb({
      activity: [activity()],
      status: [status()],
      log: [{ id: 1, delivery_id: null, from_state: "none", event: "labelled_ai_ready", to_effect: null, run: "issue-build-loop", dropped_reason: null, mode: "enforce", created_at: "2026-10-03 10:00:00" }],
    });
    const { req, url } = get(`/status?open=${OPS}/412`);
    const html = await (await handleStatus(req, env(db), url)).text();
    expect(html).toContain('<div class="panel-log-title">Transitions <span class="muted">(1, newest first)');
  });

  it("Find with exactly one match opens its log", async () => {
    const { db } = fakeDb({ activity: [activity({ issue_number: 7 }), activity({ issue_number: 8 })], log: [] });
    const { req, url } = get("/status?n=7");
    const html = await (await handleStatus(req, env(db), url)).text();
    expect(html).toContain('<div class="panel-log-title">');
    expect(html).toContain("<h2>#7");
    // Close drops the Find too, or the one match would open again
    expect(html).toContain('href="/status#i-hifi-phil-umbraco-mcp-ops-7" aria-label="Close the log"');
  });

  it("the old /status/issue link redirects to the list with that one open", async () => {
    const { db } = fakeDb();
    const { req, url } = get(`/status/issue?repo=${OPS}&n=412`);
    const res = await handleStatus(req, env(db), url);
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`/status?open=${encodeURIComponent(`${OPS}/412`)}`);
  });
});

describe("GET /status/repo and POST /status/controls — a repo's switches", () => {
  it("the sweep is on by default, with a Turn off form; says what it does there; shows repository activity", async () => {
    const { db } = fakeDb({ log: [{ id: 9, delivery_id: null, from_state: "-", event: "control_changed", to_effect: '{"control":"sweep","enabled":true,"by":"octo"}', run: null, dropped_reason: null, mode: "enforce", created_at: "2026-10-03 09:00:00" }] });
    const { req, url } = get(`/status/repo?repo=${OPS}`);
    const html = await (await handleStatus(req, env(db), url)).text();
    expect(html).toContain("Reconciliation sweep");
    expect(html).toContain('<span class="tag positive">On</span>');
    expect(html).toContain('<input type="hidden" name="enabled" value="0">');
    expect(html).toContain("Default: never changed");
    expect(html).toContain("only logs what it would re-fire (shadow)");
    expect(html).toContain("sweep turned on by octo");
  });

  it("switched off -> says so, who did it, and offers Turn on", async () => {
    const { db } = fakeDb({ controls: [{ owner: "hifi-phil", repo: "umbraco-mcp-ops", control: "sweep", enabled: 0, updated_by: "octo", updated_at: "2026-10-03 09:00:00" }] });
    const { req, url } = get(`/status/repo?repo=${OPS}`);
    const html = await (await handleStatus(req, env(db), url)).text();
    expect(html).toContain('<span class="tag quiet">Off</span>');
    expect(html).toContain("Changed by octo");
    expect(html).toContain('<input type="hidden" name="enabled" value="1">');
  });

  const post = (body: Record<string, string>, headers: Record<string, string>) => {
    const req = new Request("https://w.dev/status/controls", { method: "POST", headers, body: new URLSearchParams(body) });
    return { req, url: new URL(req.url) };
  };
  const signIn = { GITHUB_OAUTH_CLIENT_ID: "Iv1", GITHUB_OAUTH_CLIENT_SECRET: "cs", SESSION_SECRET: "k" };
  const person = async () => ({
    Cookie: `ao_session=${encodeURIComponent(await signSession({ login: "octo", email: "octo@umbraco.dk", exp: Math.floor(Date.now() / 1000) + 60 }, "k"))}`,
  });

  it("the key's post switches it, logs a control_changed row, and goes back to the repo page", async () => {
    const { db, writes } = fakeDb();
    const { req, url } = post({ repo: "Hifi-Phil/umbraco-mcp-ops", control: "sweep", enabled: "0" }, { ...KEY });
    const res = await handleStatus(req, env(db), url);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`/status/repo?repo=${encodeURIComponent(OPS)}&saved=sweep-off`);
    const back = get(res.headers.get("Location")!);
    expect(await (await handleStatus(back.req, env(db), back.url)).text()).toContain("Reconciliation sweep is now off.");
    expect(writes.find((w) => w.sql.includes("INSERT INTO repo_controls"))!.args).toEqual(["hifi-phil", "umbraco-mcp-ops", "sweep", 0, "script"]);
    expect(writes.find((w) => w.args.includes("control_changed"))!.args).toEqual([
      null, "hifi-phil", "umbraco-mcp-ops", 0, "-", "control_changed", '{"control":"sweep","enabled":false,"by":"script"}', null, null, "enforce", "script",
    ]);
  });

  it("a signed-in person's post from this origin is recorded under their login", async () => {
    const { db, writes } = fakeDb();
    const { req, url } = post({ repo: OPS, control: "sweep", enabled: "1" }, { ...(await person()), Origin: "https://w.dev" });
    expect((await handleStatus(req, { ...env(db), ...signIn }, url)).status).toBe(303);
    expect(writes.find((w) => w.sql.includes("INSERT INTO repo_controls"))!.args).toEqual(["hifi-phil", "umbraco-mcp-ops", "sweep", 1, "octo"]);
  });

  it("refuses: a person's post from another origin (or none), a repo not attached, an unknown control, a bad value", async () => {
    const { db, writes } = fakeDb();
    const p = await person();
    const cases: [Record<string, string>, Record<string, string>, number][] = [
      [{ repo: OPS, control: "sweep", enabled: "0" }, { ...p, Origin: "https://evil.io" }, 403],
      [{ repo: OPS, control: "sweep", enabled: "0" }, p, 403],
      [{ repo: "evil/repo", control: "sweep", enabled: "0" }, KEY, 400],
      [{ repo: OPS, control: "deploy", enabled: "0" }, KEY, 400],
      [{ repo: OPS, control: "sweep", enabled: "maybe" }, KEY, 400],
    ];
    for (const [body, headers, code] of cases) {
      const { req, url } = post(body, headers);
      expect((await handleStatus(req, { ...env(db), ...signIn }, url)).status, JSON.stringify([body, headers])).toBe(code);
    }
    expect(writes).toEqual([]);
  });

  it("not signed in -> a POST is refused (401), never sent to sign-in", async () => {
    const { db } = fakeDb();
    const { req, url } = post({ repo: OPS, control: "sweep", enabled: "0" }, { Origin: "https://w.dev" });
    expect((await handleStatus(req, { ...env(db), ...signIn }, url)).status).toBe(401);
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

describe("byText — who caused a log row", () => {
  it("the Worker's own say so; a person is marked; nothing when unknown", async () => {
    const { byText } = await import("../src/status-page");
    expect(byText("watchdog")).toBe(" · by the watchdog");
    expect(byText("sweep")).toBe(" · by the sweep");
    expect(byText("umbraco-agent-orchestrator[bot]")).toBe(" · by umbraco-agent-orchestrator[bot]");
    expect(byText("hifi-phil")).toBe(' · by <span class="person">hifi-phil</span>');
    expect(byText("<x>")).toBe(' · by <span class="person">&lt;x&gt;</span>');
    expect(byText(null)).toBe("");
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
    expect(effectText('{"control":"sweep","enabled":false,"by":"octo"}')).toBe("sweep turned off by octo");
    expect(effectText(null)).toBe("");
    expect(effectText("not json")).toBe("not json");
  });

  it("times as DD-MM-YYYY HH:MM:SS UTC", () => {
    expect(when("2026-10-03 09:05:07")).toBe("03-10-2026 09:05:07 UTC");
    expect(when("2026-10-03T09:05:07.000Z")).toBe("03-10-2026 09:05:07 UTC");
  });
});
