---
name: auto-release-loop
description: >-
  Event-triggered release with NO mid-flow human approval, guarded by two automated
  gates: green CI, then an Opus pre-publish review against a growing checklist (version
  correctness, beta-vs-latest, PR scope, conflicts, wrong base, …). When an issue titled
  `release <version>` is labelled `auto-release`, this cuts the release branch, bumps
  version files + changelog, opens the PR to main, drives CI green, runs the review (a
  BLOCK finding stops it), then publishes (merge, tag, GitHub Release) and syncs main
  back to dev, commenting + closing the triggering issue. Sends a Claude push
  notification at start and on completion. The deliberate act of labelling the issue is
  the human decision. For gitflow repos. Requires the github-ops skill. Trigger from a
  routine on Issue: Labeled = auto-release, or run manually as "auto-release-loop
  <version>".
---

# auto-release-loop

The release loop: **issue-triggered and CI-gated, with no mid-flow human approval.** Two
deliberate signals are the go-ahead: (1) a maintainer opened an issue naming the version
and applied the **`auto-release`** label, and (2) **CI on the release PR is green**.
That's it — no approval pause — by design, for fast beta/pre-release cycles.

> **Publishing is irreversible.** Once CI is green this ships with no further human
> look, and a published package version can't be cleanly un-published (you'd ship a
> follow-up). Use this only where **CI-green is a sufficient gate** — the deliberate
> `auto-release` label is the one human decision.

## Trigger & input

- Fired by a routine on **Issue: Labeled → `auto-release`** (instant), or run manually
  as "auto-release-loop <version>".
- **Version** = parsed from the triggering issue's **title** (e.g.
  `release 18.0.0-beta3` → `18.0.0-beta3`). If the title has no clear
  `release <version>`, **comment on the issue asking for one and stop** — never guess a
  version.
- **Branch model** via the `release-and-branching` skill — this skill is for
  **gitflow** (`dev` + `main`). Start from an up-to-date `dev` (use the `sync-dev`
  skill).
- All GitHub actions go through the **`github-ops`** skill (required for this loop).

## The `/goal`

```
/goal auto-release <version> of <repo>: release/<version> cut from dev; version files + changelog bumped; PR to main is green; pre-publish review checklist passed with no BLOCK; merged to main; tagged v<version>; GitHub Release published (prerelease if <version> has a pre-release suffix); main synced back to dev; triggering issue commented and closed
```

## Step 1 — prepare (autonomous)

1. From up-to-date `dev`, cut `release/<version>`.
2. Bump the repo's **version-file list** (from its `CLAUDE.md`) and the changelog — use
   the repo's own release skill if it has one (e.g. `umbraco-mcp-skills:release`).
3. Push and open a PR **`release/<version>` → `main`**, referencing the triggering issue
   (`Closes #<n>`). Send a **Claude push notification** (the `PushNotification` tool)
   that the auto-release has started: `auto-releasing v<version> from issue #<n>`.

## Step 2 — drive CI green

Poll the PR's check-run status (github-ops → *Get PR CI / check-run status*) until it
settles, then require **every** check to pass. Fix failures on the release branch (the
issue loop's **8-attempt** cap applies). **CI-green is required** — there is no human
approval step, but the Step 2.5 review is a second, automated gate. If CI can't be made
green, **stop**, comment the blocker on the issue, and leave the PR open. **Never publish
on red**, never trust a bypassing auto-merge.

## Step 2.5 — pre-publish review (second gate)

Once CI is green, **review the release PR against
[`references/release-review-checklist.md`](references/release-review-checklist.md)**
before anything irreversible — the growing list of common release mistakes (mismatched
or downgraded version, beta-published-as-latest, oversized / off-scope PR, conflicts,
wrong base, …). This is the last line of defence on an un-gated publish, so do it with
maximum rigour: spawn a **review subagent on the `opus` model** (fresh context, via the
Agent/Task tool) to check the PR against **every** item and return **PASS** or **BLOCK +
findings**. If subagent-spawning isn't available in the environment, do the review inline
— and run this loop on **Opus** so the gate stays high-rigour.

- Any **BLOCK** finding → **stop**: comment the findings on the triggering issue, leave
  the PR open, do **not** merge/tag/publish, and push-notify (framed as blocked).
- **WARN** findings → proceed, but include them in the completion comment.
- Continue to publish **only** when the checklist passes with no BLOCK.

## Step 3 — publish (once green + review passed)

1. Merge `release/<version>` → `main` per convention (github-ops → *Merge a PR*).
2. **Tag `v<version>`** and **create the GitHub Release** — mark it **prerelease** if
   `<version>` has a `-alpha` / `-beta` / `-rc` suffix. If the repo's `release-tag.yml`
   automation fires on the version change, confirm it; else do it explicitly.
3. Verify: `main` contains the release, `v<version>` points at it, the Release is
   published.

## Step 4 — sync dev + close out (autonomous)

1. Merge `main` back into `dev` so `dev` carries the bump + any release fixes
   (`sync-main-to-dev.yml` if installed, else do the back-merge and use `sync-dev`).
   **The `/goal` is not met until `dev` is synced.**
2. **Comment the outcome on the triggering issue** (Release link, tag, "dev synced") and
   **close it**. Also send a **Claude push notification** (the `PushNotification` tool):
   `Released v<version> — published + dev synced.` Fall back to the issue comment alone
   if push isn't available.

## Guardrails

- **Two gates before publish: CI-green AND the pre-publish review checklist (Step 2.5).**
  Never publish on red, and never publish with an open **BLOCK** finding. No human
  approval step by design — labelling the issue `auto-release` was the human decision.
- **Never force-push; never skip the dev back-merge** — an un-synced `dev` is the
  classic release mistake.
- **One release per triggering issue**; take the version only from that issue's title.
- **Mark pre-releases** (`-alpha` / `-beta` / `-rc`) as GitHub prereleases.
- If the version is ambiguous, or CI won't go green, **stop and report on the issue**
  rather than guessing or shipping something unverified.

## Running as a routine

Set up a routine with trigger **Issue: Labeled**, filtered to **Labels is one of
`auto-release`**, on an environment that has this skill (+ `github-ops`,
`release-and-branching`, `sync-dev`) — then labelling a `release <version>` issue fires
it. The version comes from the issue, so nothing else needs configuring per run.
*(The `auto-release` label must exist on the target repo.)*
