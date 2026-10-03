-- The live-status view, per 03-components.md §3.6: one row per open issue,
-- upserted (not appended) on every enforced transition and heartbeat, and
-- deleted when the issue closes. Only ever the latest snapshot, for the
-- dashboard (GET /status) alone: nothing reads it to decide a transition.
-- owner and repo are stored lowercased, so the key matches however a
-- webhook spells them.

CREATE TABLE issue_status (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  state TEXT NOT NULL,          -- its tracked label after the transition ("none" if it has none)
  routine TEXT,                 -- the routine last fired for it; kept after the run ends
  attempt INTEGER NOT NULL DEFAULT 0, -- fires of that routine in a row (a retry or re-fire counts)
  running INTEGER NOT NULL DEFAULT 0, -- 1 while a watched run is out (fired, not yet done or expired)
  last_step TEXT,               -- the latest heartbeat step of the current run
  last_step_at TEXT,            -- its ISO time
  rework_count INTEGER NOT NULL DEFAULT 0, -- CI-fix reworks handed out on this PR
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner, repo, issue_number)
);
