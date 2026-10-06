// POST /log and GET /log (work-log.ts) against real SQLite, with migration
// 0010 applied: the token decides the item, the repo and the routine.
import { describe, expect, it } from "vitest";
import { handleLogAdd, handleLogRead, mintLogToken, MAX_ENTRIES_PER_TOKEN } from "../../src/work-log";
import * as logEntries from "../../src/db/log-entries";
import { testDb } from "./sqlite-d1";

const SECRET = "s3cret";
const tokenFor = (item: number, routine = "issue-build-loop", repo = "umbraco-mcp-ops") =>
  mintLogToken(SECRET, { owner: "hifi-phil", repo, item, routine }, 60);

const post = (token: string | null, body: unknown) =>
  new Request("https://worker/log", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const get = (token: string, item: number | string) => {
  const url = new URL(`https://worker/log?item=${item}`);
  return [new Request(url, { headers: { Authorization: `Bearer ${token}` } }), url] as const;
};

describe("POST /log and GET /log", () => {
  it("adds an entry on the token's own item, with its routine; reads it back", async () => {
    const env = { DB: testDb(), ROUTINE_SIGNAL_SECRET: SECRET };
    const token = await tokenFor(412);
    const res = await handleLogAdd(post(token, { kind: "decision", category: "assumption", body: "Decided: x.\nWhy: y." }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 1 });
    await handleLogAdd(post(token, { kind: "build", category: "ignored", body: "Commit: abc" }), env);

    const [req, url] = get(token, 412);
    const read = await handleLogRead(req, env, url);
    const { entries } = (await read.json()) as { entries: logEntries.LogEntry[] };
    expect(entries.map((e) => [e.item, e.kind, e.category, e.routine, e.body])).toEqual([
      [412, "decision", "assumption", "issue-build-loop", "Decided: x.\nWhy: y."],
      [412, "build", null, "issue-build-loop", "Commit: abc"],
    ]);
  });

  it("reads any item in the token's repo (a review on the PR reads the issue's decisions), not another repo's", async () => {
    const env = { DB: testDb(), ROUTINE_SIGNAL_SECRET: SECRET };
    await handleLogAdd(post(await tokenFor(412), { kind: "build", body: "on the issue" }), env);
    await handleLogAdd(post(await tokenFor(412, "issue-build-loop", "other-repo"), { kind: "build", body: "elsewhere" }), env);
    const prToken = await tokenFor(500, "review-loop");
    const [req, url] = get(prToken, 412);
    const { entries } = (await (await handleLogRead(req, env, url)).json()) as { entries: logEntries.LogEntry[] };
    expect(entries.map((e) => e.body)).toEqual(["on the issue"]);
  });

  it("refuses a missing, forged or expired token", async () => {
    const env = { DB: testDb(), ROUTINE_SIGNAL_SECRET: SECRET };
    expect((await handleLogAdd(post(null, { kind: "build", body: "x" }), env)).status).toBe(401);
    expect((await handleLogAdd(post("forged.token", { kind: "build", body: "x" }), env)).status).toBe(401);
    const old = await mintLogToken(SECRET, { owner: "o", repo: "r", item: 1, routine: "x" }, 1, Date.now() - 2 * 60_000);
    expect((await handleLogAdd(post(old, { kind: "build", body: "x" }), env)).status).toBe(401);
  });

  it("off without the secret: no tokens were minted, so 404", async () => {
    const env = { DB: testDb() };
    expect((await handleLogAdd(post(await tokenFor(1), { kind: "build", body: "x" }), env)).status).toBe(404);
  });

  it("refuses a bad entry: kind, a decision's category, an empty or oversized body", async () => {
    const env = { DB: testDb(), ROUTINE_SIGNAL_SECRET: SECRET };
    const token = await tokenFor(412);
    expect((await handleLogAdd(post(token, { kind: "note", body: "x" }), env)).status).toBe(400);
    expect((await handleLogAdd(post(token, { kind: "decision", body: "x" }), env)).status).toBe(400);
    expect((await handleLogAdd(post(token, { kind: "decision", category: "guess", body: "x" }), env)).status).toBe(400);
    expect((await handleLogAdd(post(token, { kind: "build", body: "   " }), env)).status).toBe(400);
    expect((await handleLogAdd(post(token, { kind: "build", body: "a".repeat(4097) }), env)).status).toBe(413);
    expect(await logEntries.forItems(env.DB, "hifi-phil", "umbraco-mcp-ops", [412])).toEqual([]);
  });

  it(`one fire adds at most ${MAX_ENTRIES_PER_TOKEN}; the next fire's token starts its own count`, async () => {
    const env = { DB: testDb(), ROUTINE_SIGNAL_SECRET: SECRET };
    const token = await tokenFor(412);
    for (let i = 0; i < MAX_ENTRIES_PER_TOKEN; i++) await handleLogAdd(post(token, { kind: "build", body: `#${i}` }), env);
    expect((await handleLogAdd(post(token, { kind: "build", body: "one too many" }), env)).status).toBe(429);
    expect((await handleLogAdd(post(await tokenFor(412), { kind: "build", body: "a new run" }), env)).status).toBe(200);
  });

  it("each entry is counted on its item's dashboard row; an item with no row yet is just not counted", async () => {
    const db = testDb();
    const env = { DB: db, ROUTINE_SIGNAL_SECRET: SECRET };
    db.exec(`INSERT INTO items (owner, repo, issue_number) VALUES ('hifi-phil', 'umbraco-mcp-ops', 412)`);
    const token = await tokenFor(412);
    await handleLogAdd(post(token, { kind: "decision", category: "deviation", body: "x" }), env);
    await handleLogAdd(post(token, { kind: "build", body: "y" }), env);
    await handleLogAdd(post(token, { kind: "build", body: "z" }), env);
    const row = await db.prepare("SELECT decisions, builds FROM items WHERE issue_number = 412").first();
    expect(row).toEqual({ decisions: 1, builds: 2 });
    expect((await handleLogAdd(post(await tokenFor(999), { kind: "build", body: "no row" }), env)).status).toBe(200);
  });

  it("an item's read uses its index, not a scan", () => {
    const db = testDb();
    const plan = db.queryPlan(
      "SELECT id, item, kind, category, routine, body, created_at FROM log_entries WHERE owner = ? AND repo = ? AND item IN (?, ?) ORDER BY created_at, id",
      "o",
      "r",
      1,
      2,
    );
    expect(plan.join(" ")).toMatch(/idx_log_entries_item/);
  });
});
