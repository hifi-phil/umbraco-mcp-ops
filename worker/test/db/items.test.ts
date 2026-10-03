import { describe, expect, it } from "vitest";
import * as items from "../../src/db/items";
import { testDb } from "./sqlite-d1";

describe("db/items — what the dashboard lists, against real SQLite", () => {
  it("a webhook's meta: kind, title, state; a later one missing a title or state keeps the old", async () => {
    const db = testDb();
    await items.upsertMeta(db, "Hifi-Phil", "umbraco-mcp-ops", 7, { kind: "issue", title: "Add a thing", state: "open" });
    await items.upsertMeta(db, "hifi-phil", "umbraco-mcp-ops", 7, { kind: "issue", title: null, state: null });
    await items.recordLogged(db, "hifi-phil", "umbraco-mcp-ops", 7, "labelled_ai_ready");
    const [i] = await items.listSummaries(db);
    expect(i).toMatchObject({ owner: "hifi-phil", issue_number: 7, kind: "issue", title: "Add a thing", gh_state: "open" });
  });

  it("each logged event moves the summary on: newest event, count, and a PR-only event sticks as pr_hint", async () => {
    const db = testDb();
    await items.recordLogged(db, "o", "r", 8, "labelled_auto_merging");
    await items.recordLogged(db, "o", "r", 8, "merged");
    await items.recordLogged(db, "o", "r", 8, "issue_closed");
    const [i] = await items.listSummaries(db);
    expect(i).toMatchObject({ last_event: "issue_closed", events: 3, pr_hint: 1 });
  });

  it("lists only items with a log, newest activity first; a meta-only row (no log yet) isn't listed", async () => {
    const db = testDb();
    await items.upsertMeta(db, "o", "r", 1, { kind: "issue", title: "Only meta", state: "open" });
    db.exec(`INSERT INTO items (owner, repo, issue_number, last_event, last_at, events) VALUES
      ('o', 'r', 2, 'a', '2026-10-03 09:00:00', 1), ('o', 'r', 3, 'b', '2026-10-03 11:00:00', 2)`);
    expect((await items.listSummaries(db)).map((i) => i.issue_number)).toEqual([3, 2]);
  });

  it("listing reads the items table only, never the transition log", () => {
    const db = testDb();
    const plan = db.queryPlan(
      "SELECT owner, repo, issue_number, kind, title, gh_state, last_event, last_at, events, pr_hint FROM items WHERE events > 0 ORDER BY last_at DESC LIMIT ?",
      5000,
    );
    expect(plan.join(" ")).not.toMatch(/transitions/);
  });

  it("migration 0007 fills the summary from the log there already is", async () => {
    const db = testDb({ upTo: "0007" });
    db.exec(`INSERT INTO items (owner, repo, issue_number, kind, title) VALUES ('hifi-phil', 'umbraco-mcp-ops', 5, 'issue', 'Known');
      INSERT INTO transitions (owner, repo, issue_number, from_state, event, mode, created_at) VALUES
      ('Hifi-Phil', 'umbraco-mcp-ops', 5, 'none', 'labelled_ai_ready', 'enforce', '2026-10-03 09:00:00'),
      ('hifi-phil', 'umbraco-mcp-ops', 5, 'ready-for-ai', 'build_blocked', 'enforce', '2026-10-03 10:00:00'),
      ('hifi-phil', 'umbraco-mcp-ops', 6, 'none', 'labelled_auto_merging', 'enforce', '2026-10-03 08:00:00'),
      ('_scheduler', '_', 0, '-', 'sweep', 'shadow', '2026-10-03 11:00:00')`);
    (db as unknown as { migrateRest(): void }).migrateRest();
    const rows = await items.listSummaries(db);
    expect(rows.map((r) => [r.issue_number, r.last_event, r.events, r.pr_hint, r.title])).toEqual([
      [5, "build_blocked", 2, 0, "Known"],
      [6, "labelled_auto_merging", 1, 1, null],
    ]);
  });
});
