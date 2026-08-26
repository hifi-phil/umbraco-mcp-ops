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

Most of this repo is skills/plugins content, which doesn't version. The
one thing that does: **`worker/`** — the Cloudflare Worker + Durable
Object prototype (see `worker/README.md`). A "release" here means cutting
a version of `worker/`.

- **Version file**: `worker/package.json`'s `version` field.
- **Build/test**: `cd worker && npm test && npm run typecheck`.
- **Trigger**: an issue titled `release <version>`, labelled
  `auto-releasing` — see `auto-release-loop`'s `SKILL.md`.
- Tag + GitHub Release: `.github/workflows/release-tag.yml`, fires on
  push to `main`, reads the version from `worker/package.json`.
- Sync back: `.github/workflows/sync-main-to-dev.yml` opens a PR merging
  `main` back into `dev` after a release, so `dev` picks up the bump.

`worker/` is not deployed anywhere yet (see `worker/wrangler.toml`'s
header) — cutting a release today just produces a tagged GitHub Release
of the source, not a live deployment.
