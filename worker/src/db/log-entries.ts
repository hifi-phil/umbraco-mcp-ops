// The decision log and build log (migration 0010): every read and write of
// `log_entries` is here. Append-only. Reads are by item
// (idx_log_entries_item), never the whole table: D1's free plan allows 5M
// rows read a day.

export type LogEntryKind = "decision" | "build";

export const LOG_CATEGORIES = ["assumption", "deviation", "workaround", "judgment-call"] as const;
export type LogCategory = (typeof LOG_CATEGORIES)[number];

/** An entry as read back. */
export type LogEntry = {
  id: number;
  item: number;
  kind: LogEntryKind;
  category: LogCategory | null;
  routine: string;
  body: string;
  created_at: string;
};

export type NewLogEntry = {
  owner: string;
  repo: string;
  item: number;
  kind: LogEntryKind;
  category: LogCategory | null;
  routine: string;
  body: string;
  tokenId: string;
};

/** Adds the entry, and counts it on the item's dashboard row (migration 0011). */
export async function add(db: D1Database, e: NewLogEntry): Promise<number> {
  const owner = e.owner.toLowerCase();
  const repo = e.repo.toLowerCase();
  const row = await db
    .prepare(
      `INSERT INTO log_entries (owner, repo, item, kind, category, routine, body, token_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(owner, repo, e.item, e.kind, e.category, e.routine, e.body, e.tokenId)
    .first<{ id: number }>();
  const column = e.kind === "decision" ? "decisions" : "builds";
  await db
    .prepare(`UPDATE items SET ${column} = ${column} + 1 WHERE owner = ? AND repo = ? AND issue_number = ?`)
    .bind(owner, repo, e.item)
    .run();
  return row!.id;
}

/** How many entries one token has added (its cap). */
export async function countForToken(db: D1Database, tokenId: string): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM log_entries WHERE token_id = ?").bind(tokenId).first<number>("n")) ?? 0;
}

/** The entries for some items in one repo, oldest first. */
export async function forItems(db: D1Database, owner: string, repo: string, items: number[]): Promise<LogEntry[]> {
  if (items.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT id, item, kind, category, routine, body, created_at FROM log_entries
       WHERE owner = ? AND repo = ? AND item IN (${items.map(() => "?").join(", ")})
       ORDER BY created_at, id`,
    )
    .bind(owner.toLowerCase(), repo.toLowerCase(), ...items)
    .all<LogEntry>();
  return results;
}
