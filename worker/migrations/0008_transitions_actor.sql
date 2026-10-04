-- Who caused each log row: the GitHub login that sent the webhook (a
-- person, or another app's bot), or what the Worker itself was doing:
-- "watchdog" (an expiry), "sweep" (the reconciliation sweep). NULL on rows
-- from before this column, and on a routine's direct signals. The dashboard
-- shows it in an item's log, marking people, so a label a person removed
-- reads differently from the orchestrator's own moves.
ALTER TABLE transitions ADD COLUMN actor TEXT;
