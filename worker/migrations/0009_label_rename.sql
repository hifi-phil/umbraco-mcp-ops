-- The label rename (10-label-rename.md): issue_status.state holds a tracked
-- label's spelling, so the live-status rows move to the new ones with the
-- labels. The transition log keeps the spelling each row was written with:
-- it's a record of what happened.
UPDATE issue_status SET state = CASE state
  WHEN 'ready-for-ai' THEN 'ai-ready'
  WHEN 'generated-by-ai' THEN 'pr-open'
  WHEN 'auto-release' THEN 'auto-releasing'
  WHEN 'ai-discuss' THEN 'ai-discussing'
  WHEN 'auto-rework' THEN 'auto-reworking'
  WHEN 'auto-merge' THEN 'auto-merging'
  WHEN 'ai-review' THEN 'ai-reviewing'
  ELSE state
END
WHERE state IN ('ready-for-ai', 'generated-by-ai', 'auto-release', 'ai-discuss', 'auto-rework', 'auto-merge', 'ai-review');
