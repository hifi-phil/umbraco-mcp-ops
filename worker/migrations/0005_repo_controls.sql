-- Per-repo switches people flip from the dashboard (GET /status/repo), read
-- by the Worker before it acts for that repo. One row per repo and control;
-- no row means the control's default (on). Today: `sweep`, the
-- reconciliation sweep (scheduler.ts). Later, one per agent or routine.
-- owner and repo are stored lowercased, as issue_status's are. Each change
-- is also logged to `transitions` as a `control_changed` row.

CREATE TABLE repo_controls (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  control TEXT NOT NULL,
  enabled INTEGER NOT NULL,     -- 1 on, 0 off
  updated_by TEXT NOT NULL,     -- the signed-in GitHub login, or "script"
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner, repo, control)
);
