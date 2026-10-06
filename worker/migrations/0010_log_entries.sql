-- The decision log and build log (docs/agent-orchestration/16-work-log.md):
-- what each routine decided and checked, one row per entry, written by the
-- routine itself through POST /log with its fire's log_token. Append-only:
-- nothing edits or deletes an entry. owner and repo lowercased.
--
-- item is the issue or PR the entry is about (the token's). token_id is the
-- token's own id, so one fire's entries can be counted (it may add at most
-- 50). Reads are by item (idx_log_entries_item).

CREATE TABLE log_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  item INTEGER NOT NULL,
  kind TEXT NOT NULL,           -- "decision" or "build"
  category TEXT,                -- decisions only: assumption, deviation, workaround, judgment-call
  routine TEXT NOT NULL,
  body TEXT NOT NULL,           -- at most 4 KB
  token_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_log_entries_item ON log_entries (owner, repo, item, created_at);
CREATE INDEX idx_log_entries_token ON log_entries (token_id);
