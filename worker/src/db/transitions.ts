// The transition log (migrations 0001, 0002, 0003, 0008): append-only, one
// row per decision, per 03-components.md §3.5. Every read and write of the
// `transitions` table is here.
//
// Reads are by issue only (idx_transitions_issue_number): nothing reads the
// whole table on a schedule or a page load (the D1 free tier allows 5M rows
// read a day; see db/items.ts for the dashboard's summary).

import type { TransitionRow } from "../coordinate";

/** A log row as read back. */
export type LogRow = {
  id: number;
  delivery_id: string | null;
  from_state: string;
  event: string;
  to_effect: string | null;
  run: string | null;
  dropped_reason: string | null;
  mode: string;
  created_at: string;
  actor?: string | null; // null on rows from before migration 0008
};

const LOG_COLUMNS = "id, delivery_id, from_state, event, to_effect, run, dropped_reason, mode, created_at, actor";

/** The insert as a statement, for a caller that batches it with its own write. */
export function insertStatement(db: D1Database, row: TransitionRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO transitions
         (delivery_id, owner, repo, issue_number, from_state, event, to_effect, run, dropped_reason, mode, actor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.deliveryId,
      row.owner,
      row.repo,
      row.issueNumber,
      row.fromState,
      row.event,
      row.toEffect,
      row.run,
      row.droppedReason,
      row.mode, // per event since Phase 4, not per Worker
      row.actor ?? null,
    );
}

export async function insert(db: D1Database, row: TransitionRow): Promise<void> {
  await insertStatement(db, row).run();
}

/** When this issue was last active: its newest row, leaving out a shadow
 * sweep's reconcile row (that records what a sweep saw; it isn't activity
 * on the issue, so it mustn't reset its idle clock). Null if it has none. */
export async function lastActivityAt(db: D1Database, owner: string, repo: string, issueNumber: number): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT MAX(created_at) AS at FROM transitions
        WHERE LOWER(owner) = LOWER(?) AND LOWER(repo) = LOWER(?) AND issue_number = ?
          AND NOT (event = 'reconcile_refire' AND mode = 'shadow')`,
    )
    .bind(owner, repo, issueNumber)
    .first<{ at: string | null }>();
  return row?.at ?? null;
}

/** Which of these issues an orchestrated build finished (a logged
 * build_succeeded): the ones whose PR should come with a work log. One
 * indexed read (idx_transitions_issue_number). */
export async function builtByLoop(db: D1Database, owner: string, repo: string, issues: number[]): Promise<number[]> {
  if (issues.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT DISTINCT issue_number FROM transitions
        WHERE issue_number IN (${issues.map(() => "?").join(", ")})
          AND LOWER(owner) = LOWER(?) AND LOWER(repo) = LOWER(?) AND event = 'build_succeeded'`,
    )
    .bind(...issues, owner, repo)
    .all<{ issue_number: number }>();
  return results.map((r) => r.issue_number);
}

/** One issue's rows: oldest first (the e2e audit) or newest first (the
 * dashboard's log panel), at most `limit`. */
export async function forIssue(
  db: D1Database,
  owner: string,
  repo: string,
  issueNumber: number,
  { newestFirst = false, limit = 1000 }: { newestFirst?: boolean; limit?: number } = {},
): Promise<LogRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${LOG_COLUMNS} FROM transitions
        WHERE LOWER(owner) = LOWER(?) AND LOWER(repo) = LOWER(?) AND issue_number = ?
        ORDER BY id ${newestFirst ? "DESC" : "ASC"} LIMIT ?`,
    )
    .bind(owner, repo, issueNumber, limit)
    .all<LogRow>();
  return results;
}

/** A repo's own rows (issue 0: control changes), newest first. */
export async function forRepo(db: D1Database, owner: string, repo: string, limit = 50): Promise<LogRow[]> {
  return forIssue(db, owner, repo, 0, { newestFirst: true, limit });
}
