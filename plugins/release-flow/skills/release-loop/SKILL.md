---
name: release-loop
description: >-
  Guardrail loop that drives a release end-to-end so the mechanical, mistake-prone
  steps are automated while the "ship it" decision stays human. Cuts a release
  branch from dev, bumps versions + changelog, drives CI green, and opens the PR to
  main — then PAUSES for human approval before the irreversible part (merge to main,
  tag, publish), and afterwards finishes autonomously by syncing main back to dev.
  Reuses release-and-branching for conventions and the release-tag / sync-main-to-dev
  automation. Uses `/goal` so a release is provably complete (no forgotten tag or
  un-synced dev). Suggests the next version for you to confirm, and sends a Claude push
  notification at each point it needs you — the version choice, the approval gate, and
  on completion. Trigger on "do a release", "release X.Y.Z", "cut a release", "run
  release-loop".
---

# release-loop

A guardrail loop for releases. Manual releases go wrong in *ordering* ways — merged
to `main` but never tagged, tagged but no GitHub Release, released but `dev` never
caught back up. This loop automates all of that and gates the one irreversible
decision (publishing) behind you.

`/goal` is the whole point: a release isn't "done" until **every** step has
happened. Set it up front and it stays unmet until the release is fully shipped
*and* `dev` is synced.

This loop **orchestrates**, it doesn't reinvent: it drives the
[`release-and-branching`](../release-and-branching/SKILL.md) skill for conventions,
uses this plugin's `release-tag.yml` / `sync-main-to-dev.yml` automation, and
[`sync-dev`](../sync-dev/SKILL.md) for the back-merge. If the target repo ships its
own release skill (e.g. `umbraco-mcp-skills:release` for version-bump + changelog),
use it for that step. For GitHub actions (PRs, CI status, merge, tag/Release), use
the **`github-ops`** skill (required for this loop to run).

## Input & preconditions

- **Version.** If a version is given, use it. If not, **suggest the next version**:
  read the current version (the repo's version files / latest tag) and apply the
  repo's release convention via `release-and-branching` (e.g. next patch, or the
  active channel's next pre-release), then **confirm with the human via
  AskUserQuestion** — the suggested version as the recommended option, plus an option
  to enter a different one. **Push-notify** (PushNotification tool) that a version
  decision is awaited, including the suggestion, so the run can be kicked off and left.
  Fall back to a plain in-session question if AskUserQuestion / push aren't available.
- **Detect the branch model** via `release-and-branching`. This loop is written for
  **gitflow** (`dev` + `main`) — the MCP repos. For a main-only repo, there's no
  release-branch/back-merge dance; defer entirely to `release-and-branching`.
- Start from an **up-to-date `dev`** (use `sync-dev`).

## The `/goal`

```
/goal release <version> of <repo>: release/<version> cut from dev; version files + changelog bumped; CI green; PR to main approved by a human; merged to main; tagged v<version>; GitHub Release published; and main synced back to dev
```

## Step 1 — prepare the release (autonomous)

1. From up-to-date `dev`, cut `release/<version>`.
2. Bump the repo's **version-file list** (from its `CLAUDE.md`) and update the
   changelog — use the repo's own release skill if it has one.
3. Push and open a PR **`release/<version>` → `main`**, ready for review.
4. Drive CI green — poll the PR's check-run status (github-ops → *Get PR CI /
   check-run status*); the 8-attempt fix cap and "never trust an auto-merge" rule
   from the issue loop apply. Fix failures on the release branch.

## Step 2 — HUMAN GATE (before anything irreversible)

**Stop here and wait for explicit human approval** of the release PR before doing
anything that can't be cleanly undone (merge to `main`, tag, publish). This is the
one decision the loop must not make itself.

- Signal = an **approving review** on the release PR (or an explicit go-ahead you
  define). CI must also be green.
- While waiting, the loop is dormant on this `/goal` — same shape as the issue
  loop's review wait. Do **not** proceed on CI-green alone.
- **Notify at the gate.** As soon as prep is done and CI is green, send the human a
  **Claude push notification** (the `PushNotification` tool) with the release PR link,
  so they can step away during the CI wait and be pinged when it needs approval. Don't
  rely on a Slack post *as the maintainer* — it won't notify them; a push does. If no
  push mechanism is available, fall back to a clear in-session REVIEW-NEEDED message.

## Step 3 — publish (after approval)

1. Merge `release/<version>` → `main` per convention.
2. **Tag `v<version>`** and **create the GitHub Release** — normally the
   `release-tag.yml` automation fires on the version change; if it isn't installed
   or didn't fire, do it explicitly. Confirm the tag and Release exist.
3. Verify: `main` contains the release, `v<version>` tag points at it, Release is
   published.

## Step 4 — sync back to dev (autonomous)

Merge `main` back into `dev` so `dev` carries the version bump + any release fixes —
via the `sync-main-to-dev.yml` automation if installed, else open/complete the
back-merge yourself (then `sync-dev` to land it locally). **The `/goal` is not met
until `dev` is synced** — this is the step manual releases most often forget.

Once `dev` is synced and the release is fully shipped, send a final **Claude push
notification** (the `PushNotification` tool): `Released v<version> — merged to main,
tagged v<version>, GitHub Release published, dev synced.` (Fall back to an in-session
summary if no push mechanism is available.)

## Guardrails

- **Never merge to `main`, tag, or publish without the human gate + green CI.**
- **Never force-push; never skip the dev back-merge** — an un-synced `dev` is the
  classic release mistake this loop exists to prevent.
- Automate the mechanical steps; keep the publish decision human.
- One release at a time; the `/goal` tracks it to completion.

## Not a scheduled routine

Unlike `merge-flow` / triage, a release is **human-initiated** — you run this loop
with a version when you want to release. It is not scheduled. *(Routine wiring is
out of scope.)*
