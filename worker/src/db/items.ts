// The items table (migrations 0006, 0007): what the dashboard knows about
// each issue or PR (kind, title, GitHub state) and a summary of its log
// (newest event and time, event count, PR-only flag). Every read and write
// of `items` is here. owner and repo are stored lowercased.
//
// The dashboard's list reads this, one row per item, instead of the
// transition log (which grows without bound).

import type { ItemMeta } from "../webhook-parse";

export type ItemSummary = {
  owner: string;
  repo: string;
  issue_number: number;
  kind: string | null;
  title: string | null;
  gh_state: string | null;
  last_event: string;
  last_at: string;
  events: number;
  pr_hint: number;
};

/** Events only a pull request can have: an item that logged one is a PR. */
export const PR_EVENTS = [
  "labelled_auto_reworking",
  "unlabelled_auto_reworking",
  "rework_pushed",
  "ci_fix_pushed",
  "labelled_auto_merging",
  "unlabelled_auto_merging",
  "merge_gate_failed_soft",
  "merge_gate_failed_hard",
  "merged",
];

/** What a webhook (or a GitHub lookup) says: kind, title, state. A field it
 * doesn't carry keeps its last value. */
export async function upsertMeta(db: D1Database, owner: string, repo: string, n: number, meta: ItemMeta): Promise<void> {
  await db
    .prepare(
      `INSERT INTO items (owner, repo, issue_number, kind, title, gh_state) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner, repo, issue_number) DO UPDATE SET
         kind = excluded.kind, title = COALESCE(excluded.title, items.title),
         gh_state = COALESCE(excluded.gh_state, items.gh_state), updated_at = datetime('now')`,
    )
    .bind(owner.toLowerCase(), repo.toLowerCase(), n, meta.kind, meta.title, meta.state)
    .run();
}

/** A log row was written for it: its newest event and time, its count, and
 * whether it's logged a PR-only event. */
export async function recordLogged(db: D1Database, owner: string, repo: string, n: number, event: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO items (owner, repo, issue_number, last_event, last_at, events, pr_hint) VALUES (?, ?, ?, ?, datetime('now'), 1, ?)
       ON CONFLICT (owner, repo, issue_number) DO UPDATE SET
         last_event = excluded.last_event, last_at = excluded.last_at,
         events = items.events + 1, pr_hint = MAX(items.pr_hint, excluded.pr_hint)`,
    )
    .bind(owner.toLowerCase(), repo.toLowerCase(), n, event, PR_EVENTS.includes(event) ? 1 : 0)
    .run();
}

/** Every item with a log, newest activity first: the dashboard's list. */
export async function listSummaries(db: D1Database, limit = 5000): Promise<ItemSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT owner, repo, issue_number, kind, title, gh_state, last_event, last_at, events, pr_hint
         FROM items WHERE events > 0 ORDER BY last_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<ItemSummary>();
  return results;
}
