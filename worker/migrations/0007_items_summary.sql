-- A summary of each issue or PR's log on its items row, so the dashboard
-- reads one row per item instead of the whole transitions table (that read
-- every row on every load, and with a 30 s refresh used up D1's free daily
-- read allowance, 03-10-2026). Kept up to date by the issue DO as it writes
-- each log row (issue-coordinator.ts insertTransition).
--
-- last_event / last_at: its newest log row; events: how many it has;
-- pr_hint: 1 once any event only a PR can have was logged.

ALTER TABLE items ADD COLUMN last_event TEXT;
ALTER TABLE items ADD COLUMN last_at TEXT;
ALTER TABLE items ADD COLUMN events INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN pr_hint INTEGER NOT NULL DEFAULT 0;

-- Fill it once from the log there is (the last full read of it).
INSERT INTO items (owner, repo, issue_number, last_event, last_at, events, pr_hint)
SELECT owner, repo, issue_number, event, created_at, events, pr_hint FROM (
  SELECT LOWER(owner) AS owner, LOWER(repo) AS repo, issue_number, event, created_at,
         ROW_NUMBER() OVER (PARTITION BY LOWER(owner), LOWER(repo), issue_number ORDER BY id DESC) AS rn,
         COUNT(*) OVER (PARTITION BY LOWER(owner), LOWER(repo), issue_number) AS events,
         MAX(CASE WHEN event IN ('labelled_auto_reworking', 'unlabelled_auto_reworking', 'rework_pushed', 'ci_fix_pushed',
                                 'labelled_auto_merging', 'unlabelled_auto_merging', 'merge_gate_failed_soft',
                                 'merge_gate_failed_hard', 'merged') THEN 1 ELSE 0 END)
           OVER (PARTITION BY LOWER(owner), LOWER(repo), issue_number) AS pr_hint
    FROM transitions
   WHERE issue_number > 0
) WHERE rn = 1
ON CONFLICT (owner, repo, issue_number) DO UPDATE SET
  last_event = excluded.last_event, last_at = excluded.last_at, events = excluded.events, pr_hint = excluded.pr_hint;

CREATE INDEX idx_items_last_at ON items (last_at);
