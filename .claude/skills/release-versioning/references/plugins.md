# Plugins

Each plugin version lives in two places: `plugins/<name>/.claude-plugin/plugin.json` and the
plugin's entry in `.claude-plugin/marketplace.json`.

- **Changed** = any file under `plugins/<name>/` differs from the last `v*` release tag
  (`git diff --name-only <tag> -- plugins/<name>`). Unchanged plugins keep their version.
- **Bump** = the same size as the marketplace bump: patch by default, minor if the
  marketplace went up a minor, major if it went up a major.
- **Start from the higher** of the two copies, then write the result to both. This is how
  drift (e.g. `github-ops`, `dependabot-rollup`) is resolved when a plugin changes.
- **First release** (no `v*` tag): nothing counts as changed, so plugin versions —
  drifted or not — are left alone.
