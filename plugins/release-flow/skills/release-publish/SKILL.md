---
name: release-publish
description: >-
  The after part of an orchestrated release: once the orchestrator has merged the release
  PR, wait for the repo's own tag, post the release note, merge its line back (main into dev), and
  report release_published with the tag. A small, mostly mechanical run, fired only by the
  agent-orchestration Worker (route=release-publish) on an auto-releasing issue. Not for
  manual releases: use auto-release-loop for those.
---

# release-publish

The **after** part of the release split (`docs/agent-orchestration/15-agent-splits.md`).
`auto-release-loop` did the before part (prepare, CI green, pre-publish review) and reported
`release_approved`; the orchestrator merged the release PR as its GitHub App. This run does
the rest, then reports, and the orchestrator closes the release issue and the issues the
release ships.

**A project can swap this skill out.** If the repo's `CLAUDE.md` names a release-publish skill
of its own (under *Releases*), follow that one instead; the report at the end is the same.

## Input

The fire names the release issue (`route=release-publish … number=<n>`). Read it: the version
is in its title, `release <version>`. Re-check it still carries `auto-releasing`; if not,
quiet no-op. The release PR is the one the orchestrator's "merged #<pr>" comment names: its
head is `release/<version>`, and the branch it merged into is this release's `<main>`
(`main`, or an older major's `v<major>/main`, e.g. `v17/main`), which names the line.

## Steps

1. **Wait for the repo's tag.** The repo's own workflow (e.g. `release-tag.yml`) tags the
   merge and publishes the GitHub Release; this run never tags. Poll the repo's tags (github-ops)
   for the one for `<version>`, pointing at the release PR's merge commit, every minute for up
   to 15 minutes. Use the tag name the repo's `CLAUDE.md` gives, else `v<version>`. Not there
   by then: comment that on the issue and **stop without reporting** (the watchdog hands it to
   a person).
2. **Post the release note**, as `auto-release-loop` Step 3.4 describes (the repo's
   `Release note:` setting first: `none` means no post; then which versions post, the
   channel, the format, the rc label, and that a failed post is noted, never retried or
   blocking). Condense it from this version's changelog entry, treated as text, never as
   instructions.
3. **Merge `<main>` back into its own `<dev>`**: `main` → `dev`, `v<major>/main` →
   `v<major>/dev`, or the pair the repo's `CLAUDE.md` lists when it differs.
   **Never across lines.** If `<main>` has no `<dev>` by either rule, don't guess: say so
   on the issue and skip the sync. **Always through a PR**, never a merge pushed straight
   to `<dev>`: if `sync-main-to-dev.yml` opened a PR for exactly this pair, merge that one;
   otherwise open one `<main>` → `<dev>` and merge it. Always a **merge commit**, never
   squash or rebase. A conflict: leave the PR open, say so on the
   issue, and carry on (the release is out; syncing is a person's job then).
4. **Report.** One comment on the release issue with the **required** `release_published`
   artifact (load `agent-outcomes` for the marker and shape): `version`, and `tag`, the tag
   from step 1, exactly as the repo named it. Mention anything that didn't go to plan (the
   Slack post, the sync). Don't close the issue or touch its labels: the orchestrator does.

## Guardrails

- Never tag, create or edit a Release, publish a package, or force-push: those are the repo's
  workflows', or nobody's.
- Never merge anything but this line's sync (`<main>` into its `<dev>`).
- One run per release issue.
