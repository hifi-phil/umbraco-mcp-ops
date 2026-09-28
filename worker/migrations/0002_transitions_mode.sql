-- Which MODE the Worker was in when it wrote the row (see src/coordinate.ts's
-- resolveMode). "shadow" rows record what the reducer *would* have done —
-- nothing was written to GitHub or fired — so Phase 3's numbers
-- (07-build-phases.md) must never be mixed with enforced history.

ALTER TABLE transitions ADD COLUMN mode TEXT NOT NULL DEFAULT 'enforce';
