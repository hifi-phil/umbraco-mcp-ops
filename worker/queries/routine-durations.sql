-- Phase 6: how long each watched routine takes on a real repo, to set
-- watchdogMinutesFor (worker/src/coordinate/) from data instead of
-- guesses. One row per fire: when the Worker fired the routine, the first
-- outcome after it on the same issue/PR, and the minutes between.
-- `outcome` is NULL when nothing came back (a real stall, or still running);
-- `watchdog_expired` means the watchdog fired first, and a later outcome
-- shows whether it was a false alarm.
--
-- Run it with the comments stripped and passed as --command (with "=", or
-- wrangler reads the first comment as a flag; --file on --remote prints no
-- rows). worker/wrangler.toml has a placeholder database_id, because tofu
-- owns the real one, so point --config at a copy with the real id
-- (`tofu output d1_database_id`):
--
--   cd worker && npx wrangler d1 execute agent-orchestration-log --remote \
--     --config <a wrangler.toml with the real database_id> \
--     --command="$(sed 's/--.*$//' queries/routine-durations.sql | tr '\n' ' ')"
--
-- Change the repo below to measure another one.

WITH fires AS (
  SELECT id, repo, issue_number, run, mode, created_at AS fired_at
  FROM transitions
  WHERE repo = 'umbraco-mcp-ops'
    AND run IS NOT NULL
    AND run != 'issue-discuss-loop' -- never reports an outcome, so never watched
),
done AS (
  SELECT
    f.*,
    (
      SELECT t.id FROM transitions t
      WHERE t.repo = f.repo AND t.issue_number = f.issue_number AND t.id > f.id
        AND t.event IN (
          'build_succeeded', 'build_blocked',
          'release_published', 'release_blocked', 'issue_closed',
          'rework_pushed', 'ci_fix_pushed', 'unlabelled_auto_reworking',
          'merged', 'merge_gate_failed_soft', 'merge_gate_failed_hard', 'unlabelled_auto_merging',
          'watchdog_expired'
        )
      ORDER BY t.id LIMIT 1
    ) AS done_id
  FROM fires f
)
SELECT
  d.run,
  d.issue_number AS issue,
  d.mode,
  d.fired_at,
  t.event AS outcome,
  ROUND((julianday(t.created_at) - julianday(d.fired_at)) * 1440, 1) AS minutes,
  (
    SELECT l.event FROM transitions l
    WHERE t.event = 'watchdog_expired' AND l.repo = d.repo AND l.issue_number = d.issue_number AND l.id > t.id
      AND l.event NOT LIKE 'labelled_%' AND l.event NOT LIKE 'unlabelled_%'
    ORDER BY l.id LIMIT 1
  ) AS after_expiry
FROM done d
LEFT JOIN transitions t ON t.id = d.done_id
ORDER BY d.run, minutes DESC;
