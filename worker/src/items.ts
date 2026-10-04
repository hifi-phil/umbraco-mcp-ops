// Filling the dashboard's items table (db/items.ts) from GitHub, for an item
// it shows with no title yet (its webhooks all came before the table).
// Webhooks fill the rest as they arrive (index.ts). Display only.

import { extractItemMeta } from "./webhook-parse";
import { getIssue, type GitHubEnv } from "./github-client";
import { upsertMeta } from "./db/items";

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
      await upsertMeta(env.DB, owner, repo, n, meta ?? { kind: "issue", title: "", state: null });
    } catch (e) {
      console.error(`item lookup failed for ${full}#${n}:`, e instanceof Error ? e.message : e);
    }
  }
}
