-- Each item's work-log counts on its items row (16-work-log.md, part 4), so
-- the dashboard's list shows them without reading log_entries per row. Kept
-- up to date as POST /log adds each entry (db/log-entries.ts add). An item
-- with no items row yet (no webhook seen) just isn't counted.

ALTER TABLE items ADD COLUMN decisions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN builds INTEGER NOT NULL DEFAULT 0;
