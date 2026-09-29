---
name: release-versioning
description: Version-bump rules for a release of this repo (umbraco-mcp-ops) — sets the marketplace version and bumps only the plugins and worker/ that changed since the last release tag. Use when cutting a release here (e.g. auto-release-loop's version-bump step) or whenever plugin, marketplace or worker versions need changing.
---

# release-versioning

Repo-specific release versioning for umbraco-mcp-ops. The shared `auto-release-loop` defers
to `CLAUDE.md` for the version files; `CLAUDE.md` points here.

1. Take the release version from the issue title (`release 1.1.0` → `1.1.0`).
2. From the repo root run: `node .claude/skills/release-versioning/scripts/bump.mjs "<version>"` (must be plain `x.y.z`; the script rejects anything else)
   (`--dry-run` to preview). It edits the JSON files and prints what it did.
3. Read the reference for the component if the output surprises you:
   - [`references/marketplace.md`](references/marketplace.md)
   - [`references/plugins.md`](references/plugins.md)
   - [`references/worker.md`](references/worker.md)
4. Commit the changed files. The release tag is `v<version>`; `release-tag.yml` creates it
   from `marketplace.json` when the release lands on `main`.

Plugins and `worker/` never get tags of their own.
