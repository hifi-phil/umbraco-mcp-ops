// A real database for the repository tests: Node's built-in SQLite (D1 is
// SQLite), behind the slice of the D1 API the repositories use (prepare,
// bind, first, all, run, batch), with the real migrations applied. So the
// SQL in src/db/ runs for real, not against a fake that matches its text.
//
// queryPlan() shows how SQLite runs a statement (EXPLAIN QUERY PLAN), so a
// test can check a query uses its index rather than scanning a table: D1's
// free plan allows 5M rows read a day.

import type { DatabaseSync as Sqlite, SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Loaded at run time: Vite doesn't know node:sqlite as a built-in yet.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof Sqlite };
type DatabaseSync = Sqlite;

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

type Bound = { sql: string; args: SQLInputValue[] };

class Statement {
  constructor(
    private readonly sqlite: DatabaseSync,
    readonly sql: string,
    readonly args: SQLInputValue[] = [],
  ) {}

  bind(...args: unknown[]): Statement {
    return new Statement(this.sqlite, this.sql, args as SQLInputValue[]);
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.sqlite.prepare(this.sql).get(...this.args) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : { ...row }) as T;
  }

  async all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    const rows = this.sqlite.prepare(this.sql).all(...this.args) as Record<string, unknown>[];
    return { results: rows.map((r) => ({ ...r })) as T[], success: true, meta: {} };
  }

  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    const r = this.sqlite.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export type TestDb = D1Database & {
  /** How SQLite would run this statement: one line per step. */
  queryPlan(sql: string, ...args: unknown[]): string[];
  /** Runs SQL directly (seeding a test). */
  exec(sql: string): void;
};

/** A fresh in-memory database with the migrations applied, all of them or
 * those before `upTo` (a test of a migration seeds the tables first). */
export function testDb({ upTo }: { upTo?: string } = {}): TestDb {
  const sqlite = new DatabaseSync(":memory:");
  const apply = (only: (f: string) => boolean) => {
    for (const f of readdirSync(MIGRATIONS).sort().filter(only)) sqlite.exec(readFileSync(`${MIGRATIONS}/${f}`, "utf8"));
  };
  apply((f) => f.endsWith(".sql") && (!upTo || f < upTo));
  const db = {
    prepare: (sql: string) => new Statement(sqlite, sql),
    async batch(stmts: Bound[]) {
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) out.push(await new Statement(sqlite, s.sql, s.args).run());
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
    exec: (sql: string) => sqlite.exec(sql),
    queryPlan: (sql: string, ...args: unknown[]) =>
      (sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as SQLInputValue[])) as { detail: string }[]).map((r) => r.detail),
    /** The rest of the migrations (after a test of one seeded the tables). */
    migrateRest: () => apply((f) => f.endsWith(".sql") && !!upTo && f >= upTo),
  };
  return db as unknown as TestDb & { migrateRest(): void };
}
