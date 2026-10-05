import { describe, expect, it } from "vitest";
import * as transitions from "../../src/db/transitions";
import type { TransitionRow } from "../../src/coordinate";
import { testDb } from "./sqlite-d1";
import { LABELS } from "@orchestrator/graph/constants/labels";

const row = (o: Partial<TransitionRow> = {}): TransitionRow => ({
  deliveryId: "d-1",
  owner: "hifi-phil",
  repo: "umbraco-mcp-ops",
  issueNumber: 412,
  fromState: "none",
  event: "labelled_ai_ready",
  toEffect: `{"kind":"label","value":"${LABELS.AI_READY}"}`,
  run: "issue-build-loop",
  droppedReason: null,
  mode: "enforce",
  actor: "hifi-phil",
  ...o,
});

describe("db/transitions — the log, against real SQLite", () => {
  it("writes a row and reads it back with every column, the actor included", async () => {
    const db = testDb();
    await transitions.insert(db, row());
    const [r] = await transitions.forIssue(db, "hifi-phil", "umbraco-mcp-ops", 412);
    expect(r).toMatchObject({
      delivery_id: "d-1",
      from_state: "none",
      event: "labelled_ai_ready",
      to_effect: `{"kind":"label","value":"${LABELS.AI_READY}"}`,
      run: "issue-build-loop",
      dropped_reason: null,
      mode: "enforce",
      actor: "hifi-phil",
    });
    expect(r!.created_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  });

  it("one issue's rows, oldest or newest first, matching owner and repo case-insensitively, at most `limit`", async () => {
    const db = testDb();
    await transitions.insert(db, row({ event: "a" }));
    await transitions.insert(db, row({ owner: "Hifi-Phil", event: "b" }));
    await transitions.insert(db, row({ event: "c", issueNumber: 413 }));
    await transitions.insert(db, row({ event: "d", repo: "other" }));
    expect((await transitions.forIssue(db, "HIFI-PHIL", "umbraco-mcp-ops", 412)).map((r) => r.event)).toEqual(["a", "b"]);
    expect((await transitions.forIssue(db, "hifi-phil", "umbraco-mcp-ops", 412, { newestFirst: true })).map((r) => r.event)).toEqual(["b", "a"]);
    expect(await transitions.forIssue(db, "hifi-phil", "umbraco-mcp-ops", 412, { limit: 1 })).toHaveLength(1);
  });

  it("lastActivityAt: the newest row, leaving out a shadow sweep's reconcile row; null with none", async () => {
    const db = testDb();
    expect(await transitions.lastActivityAt(db, "hifi-phil", "umbraco-mcp-ops", 412)).toBeNull();
    db.exec(`INSERT INTO transitions (owner, repo, issue_number, from_state, event, mode, created_at) VALUES
      ('hifi-phil', 'umbraco-mcp-ops', 412, 'none', 'labelled_ai_ready', 'enforce', '2026-10-03 10:00:00'),
      ('hifi-phil', 'umbraco-mcp-ops', 412, '${LABELS.AI_READY}', 'reconcile_refire', 'shadow', '2026-10-03 12:00:00'),
      ('hifi-phil', 'umbraco-mcp-ops', 413, 'none', 'labelled_ai_ready', 'enforce', '2026-10-03 13:00:00')`);
    expect(await transitions.lastActivityAt(db, "Hifi-Phil", "umbraco-mcp-ops", 412)).toBe("2026-10-03 10:00:00");
    db.exec(`INSERT INTO transitions (owner, repo, issue_number, from_state, event, mode, created_at) VALUES
      ('hifi-phil', 'umbraco-mcp-ops', 412, '${LABELS.AI_READY}', 'reconcile_refire', 'enforce', '2026-10-03 14:00:00')`);
    expect(await transitions.lastActivityAt(db, "hifi-phil", "umbraco-mcp-ops", 412)).toBe("2026-10-03 14:00:00");
  });

  it("a repo's own rows are issue 0's, newest first", async () => {
    const db = testDb();
    await transitions.insert(db, row({ issueNumber: 0, event: "control_changed", toEffect: '{"control":"sweep","enabled":false}' }));
    await transitions.insert(db, row({ issueNumber: 0, event: "control_changed", toEffect: '{"control":"sweep","enabled":true}' }));
    await transitions.insert(db, row());
    const rows = await transitions.forRepo(db, "hifi-phil", "umbraco-mcp-ops");
    expect(rows.map((r) => r.to_effect)).toEqual(['{"control":"sweep","enabled":true}', '{"control":"sweep","enabled":false}']);
  });

  it("reads go through the issue_number index, never a scan of the whole log", () => {
    const db = testDb();
    const perIssue = db.queryPlan(
      "SELECT MAX(created_at) FROM transitions WHERE LOWER(owner) = LOWER(?) AND LOWER(repo) = LOWER(?) AND issue_number = ? AND NOT (event = 'reconcile_refire' AND mode = 'shadow')",
      "o", "r", 1,
    );
    expect(perIssue.join(" ")).toMatch(/USING INDEX idx_transitions_issue_number/);
    const log = db.queryPlan("SELECT * FROM transitions WHERE LOWER(owner) = LOWER(?) AND LOWER(repo) = LOWER(?) AND issue_number = ? ORDER BY id DESC LIMIT ?", "o", "r", 1, 300);
    expect(log.join(" ")).not.toMatch(/SCAN transitions(?! USING)/);
  });
});
