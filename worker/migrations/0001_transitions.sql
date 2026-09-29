-- The transition log — append-only, per 03-components.md §3.5. Never read
-- to make a live decision (the one deliberate exception is a future
-- reconciliation sweep — see 05-technical-elements.md — which doesn't
-- exist yet, so this table has no reader today at all).

CREATE TABLE transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  from_state TEXT NOT NULL,
  event TEXT NOT NULL,
  to_effect TEXT,               -- JSON.stringify(rule.to); NULL if dropped
  run TEXT,                     -- routine name if one fired; NULL otherwise
  dropped_reason TEXT,          -- NULL only when a rule actually fired
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_transitions_issue ON transitions (owner, repo, issue_number);
CREATE INDEX idx_transitions_created_at ON transitions (created_at);
