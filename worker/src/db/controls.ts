// Per-repo controls (migrations/0005_repo_controls.sql): switches people
// flip from the dashboard. Every read and write of `repo_controls` is here.
// owner and repo are stored lowercased; no row means on.

import { insertStatement } from "./transitions";

export type ControlRow = { owner: string; repo: string; control: string; enabled: number; updated_by: string; updated_at: string };

const lower = (s: string) => s.toLowerCase();

/** The repos ("owner/repo", lowercased) where this control is switched off. */
export async function reposWithOff(db: D1Database, control: string): Promise<Set<string>> {
  const { results } = await db
    .prepare("SELECT owner, repo FROM repo_controls WHERE control = ? AND enabled = 0")
    .bind(control)
    .all<{ owner: string; repo: string }>();
  return new Set(results.map((r) => `${r.owner}/${r.repo}`));
}

/** One repo's rows (only the controls ever set). */
export async function forRepo(db: D1Database, owner: string, repo: string): Promise<ControlRow[]> {
  const { results } = await db
    .prepare("SELECT owner, repo, control, enabled, updated_by, updated_at FROM repo_controls WHERE owner = ? AND repo = ?")
    .bind(lower(owner), lower(repo))
    .all<ControlRow>();
  return results;
}

/** Switches a control and logs the change to the transition log (issue 0:
 * it's the repo's, not an issue's), together. */
export async function set(db: D1Database, owner: string, repo: string, control: string, enabled: boolean, by: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO repo_controls (owner, repo, control, enabled, updated_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (owner, repo, control) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = datetime('now')`,
      )
      .bind(lower(owner), lower(repo), control, enabled ? 1 : 0, by),
    insertStatement(db, {
      deliveryId: null,
      owner: lower(owner),
      repo: lower(repo),
      issueNumber: 0,
      fromState: "-",
      event: "control_changed",
      toEffect: JSON.stringify({ control, enabled, by }),
      run: null,
      droppedReason: null,
      mode: "enforce",
      actor: by,
    }),
  ]);
}
