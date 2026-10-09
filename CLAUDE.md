# CLAUDE.md

Repo-specific conventions the shared skills in `plugins/` defer to instead
of hardcoding. Keep this file terse — it's a lookup table for the skills,
not a tutorial.

## Branching

Gitflow, two long-lived branches: `dev` (integration) and `main`
(releases only). PRs target `dev` and are **squash-merged**.
`release/<version>` branches cut from `dev`, PR into `main`, and are
merged via a **merge commit** — never squashed, since the release
tooling (`release-tag.yml`, `sync-main-to-dev.yml`) keys off that
specific commit landing on `main`. `release-and-branching`'s own
base-branch detection (`git branch -a`) picks this up automatically.

## Releases

A release is the marketplace version (`.claude-plugin/marketplace.json`
`metadata.version`). Plugins and `worker/` carry their own versions and are
bumped only when files under their folder changed since the last `v*` tag.

- **Version files / bump rules**: follow the `release-versioning` skill
  (`.claude/skills/release-versioning/`) — it takes the version from the
  issue title and runs `scripts/bump.mjs`. Don't list paths by hand.
- **Install**: npm workspaces (root `package.json`: `graph/` as
  `@orchestrator/graph`, `worker/`, `e2e/`): `npm ci` once at the root,
  one root `package-lock.json`.
- **Build/test**: `cd worker && npm test && npm run typecheck`, and
  `node .claude/skills/release-versioning/scripts/bump.test.mjs`.
- **Trigger**: an issue titled `release <version>`, labelled
  `auto-releasing` — see `auto-release-loop`'s `SKILL.md`.
- Tag + GitHub Release: `.github/workflows/release-tag.yml`, fires on
  push to `main`, tags `v<marketplace version>`. No per-component tags.
- Sync back: `.github/workflows/sync-main-to-dev.yml` opens a PR merging
  `main` back into `dev` after a release, so `dev` picks up the bump.

Deploy: a published release deploys `worker/` (and the e2e stub) and runs
the e2e suite, via `.github/workflows/deploy.yml` from `release-tag.yml`,
after a required reviewer approves. State is encrypted in a private state
repo; nobody runs `tofu apply` after a release. See
`docs/agent-orchestration/19-deploy.md`.
