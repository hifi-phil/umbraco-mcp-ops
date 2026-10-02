-- The reconciliation sweep's idle check (issue-coordinator.ts's
-- lastActivityAt) matches owner and repo case-insensitively (LOWER(...)),
-- which idx_transitions_issue can't serve, so it scanned the whole log for
-- every candidate. Leading with issue_number narrows it to that number's
-- few rows first.
CREATE INDEX idx_transitions_issue_number ON transitions (issue_number, created_at);
