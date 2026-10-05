// The live-status table (migrations/0004_issue_status.sql): one row per
// open issue, for the dashboard. Every read and write of `issue_status` is
// here. owner and repo are stored lowercased.

import type { LABELS } from "@orchestrator/graph/constants/labels"; // for the {@link LABELS.…} references in its doc comments

export type StatusRow = {
  owner: string;
  repo: string;
  issue_number: number;
  state: string;
  routine: string | null;
  attempt: number;
  running: number;
  last_step: string | null;
  last_step_at: string | null;
  rework_count: number;
  updated_at: string;
};

const COLUMNS = "owner, repo, issue_number, state, routine, attempt, running, last_step, last_step_at, rework_count, updated_at";
const WHERE = "WHERE owner = ? AND repo = ? AND issue_number = ?";

type Key = { owner: string; repo: string; issueNumber: number };
const key = (k: Key) => [k.owner.toLowerCase(), k.repo.toLowerCase(), k.issueNumber] as const;

/** Every row, running first then most recently updated (the dashboard,
 * and ?format=json). It holds only open issues, so it stays small. */
export async function list(db: D1Database, limit = 500): Promise<StatusRow[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM issue_status ORDER BY running DESC, updated_at DESC LIMIT ?`)
    .bind(limit)
    .all<StatusRow>();
  return results;
}

export async function remove(db: D1Database, k: Key): Promise<void> {
  await db.prepare(`DELETE FROM issue_status ${WHERE}`).bind(...key(k)).run();
}

export async function setStep(db: D1Database, k: Key, step: string, at: string): Promise<void> {
  await db.prepare(`UPDATE issue_status SET last_step = ?, last_step_at = ?, updated_at = datetime('now') ${WHERE}`).bind(step, at, ...key(k)).run();
}

export async function setDone(db: D1Database, k: Key): Promise<void> {
  await db.prepare(`UPDATE issue_status SET running = 0, updated_at = datetime('now') ${WHERE}`).bind(...key(k)).run();
}

export async function setRework(db: D1Database, k: Key, count: number): Promise<void> {
  await db.prepare(`UPDATE issue_status SET rework_count = ?, updated_at = datetime('now') ${WHERE}`).bind(count, ...key(k)).run();
}

/** A transition's row. A fire starts a new run: a fresh step, and the
 * attempt counts on while it's the same routine as last time (a retry or
 * re-fire). No fire: the state moves, and the last run's routine, attempt
 * and step stay, so an {@link LABELS.AI_STUCK} row still shows where it got to. */
export async function upsertTransition(
  db: D1Database,
  k: Key,
  t: { state: string; run: string | null; running: boolean; reworkCount: number },
): Promise<void> {
  const onConflict = t.run
    ? `routine = excluded.routine,
       attempt = CASE WHEN issue_status.routine = excluded.routine THEN issue_status.attempt + 1 ELSE 1 END,
       running = excluded.running, last_step = NULL, last_step_at = NULL,`
    : `running = 0,`;
  await db
    .prepare(
      `INSERT INTO issue_status (owner, repo, issue_number, state, routine, attempt, running, rework_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner, repo, issue_number) DO UPDATE SET
         state = excluded.state, ${onConflict}
         rework_count = excluded.rework_count, updated_at = datetime('now')`,
    )
    .bind(...key(k), t.state, t.run, t.run ? 1 : 0, t.running ? 1 : 0, t.reworkCount)
    .run();
}
