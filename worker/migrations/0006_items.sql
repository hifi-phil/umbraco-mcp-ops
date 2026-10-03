-- What the dashboard knows about each issue or pull request the Worker has
-- heard of, from the webhooks themselves: whether it's an issue or a PR, its
-- title, and its GitHub state. Upserted on every webhook that carries them
-- (index.ts); a field a webhook doesn't carry keeps its last value. Display
-- only: nothing reads it to decide anything. owner and repo lowercased.

CREATE TABLE items (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  kind TEXT,                    -- "issue" or "pr"
  title TEXT,
  gh_state TEXT,                -- "open", "closed" or "merged"
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner, repo, issue_number)
);
