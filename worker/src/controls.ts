// Per-repo controls (migrations/0005_repo_controls.sql): switches people flip
// from the dashboard, read by the Worker before it acts for a repo. No row
// means on. Today the reconciliation sweep; later, one per agent.

/** Every control, with what the dashboard says about it. */
export const CONTROLS = {
  sweep: {
    name: "Reconciliation sweep",
    about: "Every 15 minutes, finds issues left in a trigger state with nothing watching them, and re-fires their routine (or, in shadow, only logs it).",
  },
} as const;

export type Control = keyof typeof CONTROLS;

export const isControl = (c: string): c is Control => Object.prototype.hasOwnProperty.call(CONTROLS, c);

export type ControlRow = { owner: string; repo: string; control: string; enabled: number; updated_by: string; updated_at: string };

const lower = (s: string) => s.toLowerCase();

/** The repos ("owner/repo", lowercased) where this control is switched off. */
export async function reposWithControlOff(db: D1Database, control: Control): Promise<Set<string>> {
  const { results } = await db
    .prepare("SELECT owner, repo FROM repo_controls WHERE control = ? AND enabled = 0")
    .bind(control)
    .all<{ owner: string; repo: string }>();
  return new Set(results.map((r) => `${r.owner}/${r.repo}`));
}

/** One repo's controls, each with its row if it was ever set. */
export async function controlsFor(db: D1Database, owner: string, repo: string): Promise<{ control: Control; enabled: boolean; row: ControlRow | null }[]> {
  const { results } = await db
    .prepare("SELECT owner, repo, control, enabled, updated_by, updated_at FROM repo_controls WHERE owner = ? AND repo = ?")
    .bind(lower(owner), lower(repo))
    .all<ControlRow>();
  return (Object.keys(CONTROLS) as Control[]).map((control) => {
    const row = results.find((r) => r.control === control) ?? null;
    return { control, enabled: row ? row.enabled === 1 : true, row };
  });
}

/** Switches a control, and logs the change to the transition log (issue 0:
 * it's the repo's, not an issue's). */
export async function setControl(db: D1Database, owner: string, repo: string, control: Control, enabled: boolean, by: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO repo_controls (owner, repo, control, enabled, updated_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (owner, repo, control) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = datetime('now')`,
      )
      .bind(lower(owner), lower(repo), control, enabled ? 1 : 0, by),
    db
      .prepare(
        `INSERT INTO transitions (delivery_id, owner, repo, issue_number, from_state, event, to_effect, run, dropped_reason, mode, actor)
         VALUES (NULL, ?, ?, 0, '-', 'control_changed', ?, NULL, NULL, 'enforce', ?)`,
      )
      .bind(lower(owner), lower(repo), JSON.stringify({ control, enabled, by }), by),
  ]);
}
