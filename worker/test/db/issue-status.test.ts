import { describe, expect, it } from "vitest";
import * as issueStatus from "../../src/db/issue-status";
import { testDb } from "./sqlite-d1";
import { LABELS } from "@orchestrator/graph/constants/labels";

const k = { owner: "Hifi-Phil", repo: "umbraco-mcp-ops", issueNumber: 412 };
const one = async (db: ReturnType<typeof testDb>) => (await issueStatus.list(db))[0];

describe("db/issue-status — the live-status row, against real SQLite", () => {
  it("a fire creates the row, keyed lowercased, running, attempt 1", async () => {
    const db = testDb();
    await issueStatus.upsertTransition(db, k, { state: LABELS.AI_READY, run: "issue-build-loop", running: true, reworkCount: 0 });
    expect(await one(db)).toMatchObject({ owner: "hifi-phil", repo: "umbraco-mcp-ops", issue_number: 412, state: LABELS.AI_READY, routine: "issue-build-loop", attempt: 1, running: 1 });
  });

  it("the same routine fired again counts its attempt on, with a fresh step; another routine starts at 1", async () => {
    const db = testDb();
    await issueStatus.upsertTransition(db, k, { state: LABELS.AI_READY, run: "issue-build-loop", running: true, reworkCount: 0 });
    await issueStatus.setStep(db, k, "running tests", "2026-10-03T10:00:00Z");
    await issueStatus.upsertTransition(db, k, { state: LABELS.AI_READY, run: "issue-build-loop", running: true, reworkCount: 0 });
    expect(await one(db)).toMatchObject({ attempt: 2, last_step: null });
    await issueStatus.upsertTransition(db, k, { state: LABELS.AUTO_MERGING, run: "merge-flow", running: true, reworkCount: 1 });
    expect(await one(db)).toMatchObject({ routine: "merge-flow", attempt: 1, rework_count: 1 });
  });

  it("a transition with no fire moves the state and keeps the last run's routine, attempt and step", async () => {
    const db = testDb();
    await issueStatus.upsertTransition(db, k, { state: LABELS.AI_READY, run: "issue-build-loop", running: true, reworkCount: 0 });
    await issueStatus.setStep(db, k, "running tests", "2026-10-03T10:00:00Z");
    await issueStatus.upsertTransition(db, k, { state: LABELS.AI_STUCK, run: null, running: false, reworkCount: 0 });
    expect(await one(db)).toMatchObject({ state: LABELS.AI_STUCK, routine: "issue-build-loop", attempt: 1, running: 0, last_step: "running tests" });
  });

  it("step, done and rework update only an existing row; remove deletes it", async () => {
    const db = testDb();
    await issueStatus.setStep(db, k, "x", "t");
    expect(await issueStatus.list(db)).toEqual([]);
    await issueStatus.upsertTransition(db, k, { state: LABELS.AI_READY, run: "issue-build-loop", running: true, reworkCount: 0 });
    await issueStatus.setDone(db, k);
    await issueStatus.setRework(db, k, 2);
    expect(await one(db)).toMatchObject({ running: 0, rework_count: 2 });
    await issueStatus.remove(db, k);
    expect(await issueStatus.list(db)).toEqual([]);
  });

  it("list: running first, then most recently updated", async () => {
    const db = testDb();
    db.exec(`INSERT INTO issue_status (owner, repo, issue_number, state, running, updated_at) VALUES
      ('o', 'r', 1, '${LABELS.AI_BLOCKED}', 0, '2026-10-03 12:00:00'),
      ('o', 'r', 2, '${LABELS.AI_READY}', 1, '2026-10-03 09:00:00'),
      ('o', 'r', 3, '${LABELS.AI_STUCK}', 0, '2026-10-03 11:00:00')`);
    expect((await issueStatus.list(db)).map((r) => r.issue_number)).toEqual([2, 1, 3]);
  });
});
