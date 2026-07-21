---
name: rework-loop
description: >-
  Event-triggered loop that acts on PR review feedback. When a reviewer requests changes
  (or leaves actionable comments) on a loop-authored PR, it reads the feedback, makes the
  changes following the established MCP skills, pushes, drives CI green, replies to the
  threads, and re-requests review — then stops. It never merges (merge-flow does that once
  re-approved). CI is the test gate, so no local Umbraco is needed — runs in a cloud
  routine or locally. Requires the github-ops skill. Trigger from a routine on the GitHub
  PR-review event (changes requested), or run manually as "rework PR #N".
---

# rework-loop

The **review-response half of the issue loop, split out so it can be event-driven.**
`mcp-issue-loop` (cloud mode) takes a `ready-for-ai` issue to a CI-green PR and stops;
when you review that PR and ask for changes, **`rework-loop`** picks it up and addresses
them — closing the write → review → rework → merge chain with no long-lived "monitor my
review" session.

## Trigger & scope

- Fired by a routine on the GitHub **PR-review** event (a review that **requests changes**
  or leaves actionable comments), or run manually as "rework PR #N".
- **Only act on actionable feedback.** A plain **approval** with no requested changes and
  no unresolved comment threads → **quiet no-op** (it's ready; `merge-flow` handles the
  merge). Only rework when there's something concrete to address.
- Act on the **reviewed PR only** — never touch other PRs.

## Test gate: CI, not local

This loop does **not** run Umbraco. This repo is TypeScript — it edits the TS, runs the
repo's fast checks (`npm ci` + `npm run compile` / `npm run build`) as a sanity pass, and
relies on **CI** (GitHub Actions) to run the integration/eval suite. All GitHub work goes
through the **`github-ops`** skill (required). *(Run locally with the full toolchain and
you may also `npm run test:all` before pushing — but CI is the gate either way.)*

## Step 1 — read the feedback

Via `github-ops`, get the PR and its reviews + review comments (→ *Get reviews + review
comments*). Collect every **unresolved, actionable** item: requested changes, inline
comments, and review-body asks. If there are none (approval only) → **quiet no-op, stop.**

## Step 2 — address it

Check out the PR's head branch. Make the changes that resolve the feedback, **following
the established MCP skills** (`umbraco-mcp-skills` — tool creation, tests, descriptions)
and the repo's `CLAUDE.md` conventions. Stay **scoped to the feedback** — don't refactor
unrelated code or grow the PR. Run the fast checks (`npm run compile` / `npm run build`)
and fix anything they catch.

## Step 3 — push & drive CI green

Commit and push to the PR branch. Poll the PR's check-run status (github-ops → *Get PR CI
/ check-run status*); on failure, read the failing log (→ *Read a failing check's log*),
fix the root cause, push, re-poll. The issue loop's **8-attempt** cap applies. Never
leave the PR red.

## Step 4 — reply & re-request

Once CI is green, **reply briefly on each addressed thread** (what changed) and
**re-request review** from the original reviewer (github-ops → *Re-request review*).
**Do not merge** — re-approval + `merge-flow` (via the `auto-merge` label) handle that.
Send a Claude push notification: `Reworked PR #N per review — CI green, re-requested review.`

## Guardrails

- **Only actionable feedback triggers a rework;** a plain approval is a quiet no-op.
- **Scoped to the review** — resolve what was raised, nothing more; never grow the PR.
- **Never merge** — re-request review; `merge-flow` merges once re-approved.
- **Never leave CI red;** the 8-attempt fix cap applies.
- Follow the MCP skills for code changes; **CI is the correctness gate.**

## Running as a routine

Trigger: the GitHub **PR-review** event (filter to *changes requested* if the UI allows;
otherwise no-op on approvals in-loop), on an environment carrying this skill + `github-ops`
(and, for good MCP code, the `umbraco-mcp-skills` conventions). One PR per event. Use a
capable coding model (Sonnet or better) — it edits code. If the environment is cloud vs
local, state that explicitly in the routine prompt.
