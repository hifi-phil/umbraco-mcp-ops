// The dashboard's items table (migrations/0006_items.sql): an issue or PR's
// kind, title and GitHub state. Filled from webhooks as they arrive
// (index.ts), and looked up from GitHub for an item the dashboard shows that
// has none yet (its webhooks all came before the table). Display only.

import { extractItemMeta, type ItemMeta } from "./webhook-parse";
import { getIssue, type GitHubEnv } from "./github-client";

export async function upsertItem(db: D1Database, owner: string, repo: string, n: number, meta: ItemMeta): Promise<void> {
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

/** At most this many GitHub lookups per dashboard load. */
export const BACKFILL_MAX = 20;

/** Looks these items up on GitHub and records what it says. One that's gone
 * (deleted, or transferred away) is recorded with an empty title, so it
 * isn't looked up again. Never throws: a failed lookup is retried on a later
 * load. */
export async function backfillItems(env: GitHubEnv & { DB: D1Database }, wanted: { repo: string; n: number }[]): Promise<void> {
  for (const { repo: full, n } of wanted.slice(0, BACKFILL_MAX)) {
    const [owner, repo] = full.split("/") as [string, string];
    try {
      const issue = await getIssue(env, owner, repo, n);
      const meta = issue ? extractItemMeta({ issue }) : null;
      await upsertItem(env.DB, owner, repo, n, meta ?? { kind: "issue", title: "", state: null });
    } catch (e) {
      console.error(`item lookup failed for ${full}#${n}:`, e instanceof Error ? e.message : e);
    }
  }
}
