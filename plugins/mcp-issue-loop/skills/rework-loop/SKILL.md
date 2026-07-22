---
name: rework-loop
description: >-
  Label-triggered loop that acts on PR review feedback. When a reviewer has left comments
  and labels the loop-authored PR `auto-rework`, it reads the feedback, makes the changes
  following the established MCP skills, runs the fast local checks, pushes, replies to the
  threads, re-requests review, and removes the `auto-rework` label — then stops. It does
  NOT wait for CI (merge-flow won't merge until CI passes, so CI is enforced there) and it
  never merges. No local Umbraco needed — runs in a cloud
  routine or locally. Requires the github-ops skill. Trigger: a PR labelled `auto-rework`
  (uniform with the other loops, and works regardless of who reviewed), or run manually as
  "rework PR #N".
---

# rework-loop

The **review-response half of the issue loop, split out so it can be event-driven.**
`mcp-issue-loop` (cloud mode) takes a `ready-for-ai` issue to a CI-green PR and stops;
when you review that PR and label it **`auto-rework`**, **`rework-loop`** picks it up and
addresses the feedback — closing the write → review → rework → merge chain with no
long-lived "monitor my review" session.

## Trigger & scope

- Fired when a PR is labelled **`auto-rework`** (via the loop-dispatch Action), or run
  manually as "rework PR #N". A label rather than the review event because it's uniform
  with the other loops and — unlike a `pull_request_review` — it fires even when the
  reviewer's account is the PR author's (the loop's own identity). Reviewer flow: leave
  the review comments, then add `auto-rework`.
- **Read all the feedback first.** The `auto-rework` label is the reviewer's explicit
  "address these" — so read the review(s) + inline comments on the PR and act on every
  concrete point. If a comment is genuinely unclear, reply on the thread asking rather
  than guessing. If, after reading, there's truly nothing actionable, remove `auto-rework`
  with a note and stop rather than inventing changes.
- Act on the **labelled PR only** — never touch other PRs.

## Test gate: CI, async — this loop never waits on it

This loop **never runs Umbraco or `npm run test:all` — that's the CI job**, not the
worker's. This repo is TypeScript, so it edits the TS, runs `npm ci` + `npm run compile`
/ `npm run build` as a **fast local sanity pass**, then pushes and **stops** — it does
**not** poll or wait for CI. CI (GitHub Actions) runs the integration/eval suite
asynchronously, and **`merge-flow` won't merge until CI is green**, so CI is enforced at
merge time, not by this session sitting idle. Keeping the rework session short is the
whole point of the split. All GitHub work goes through the **`github-ops`** skill
(required).

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

## Step 3 — push

Commit and push to the PR branch. The `npm run compile` / `npm run build` sanity pass from
Step 2 is the only gate this session applies — **do not poll or wait for CI to go green.**
CI runs asynchronously and `merge-flow` enforces it at merge time, so a rework session that
sits watching check-runs just burns time and tokens for no benefit.

## Step 4 — reply, re-request & clear the label

Immediately after pushing (no waiting for CI): **reply briefly on each addressed thread**
(what changed), **re-request review** from the original reviewer (github-ops → *Re-request
review*), and **remove the `auto-rework` label** from the PR (github-ops → *Add / remove a
label*). The label means "rework pending" — clearing it marks the round done and re-arms
the trigger, so a later review can re-add `auto-rework` to fire the next round.
**Do not merge** — re-approval + `merge-flow` (via the `auto-merge` label) handle that.
Send a Claude push notification: `Reworked PR #N per review — pushed & re-requested review (CI will verify).`

## Guardrails

- **Only actionable feedback triggers a rework;** a plain approval is a quiet no-op.
- **Scoped to the review** — resolve what was raised, nothing more; never grow the PR.
- **Always clear `auto-rework` on exit** — both on completion (Step 4) and on the quiet
  no-op (Step 1) — so the label reflects "rework pending" and the trigger stays re-armable.
- **Never merge** — re-request review; `merge-flow` merges once re-approved.
- **Never wait on CI** — push and hand off. `merge-flow` won't merge until CI is green, so
  CI is enforced there; a rework session polling check-runs just wastes time and tokens.
- Follow the MCP skills for code changes; **CI is the correctness gate — asynchronously.**

## Running as a routine

Trigger: a PR labelled **`auto-rework`** (routed by the loop-dispatch Action), on an
environment carrying this skill + `github-ops` (and, for good MCP code, the
`umbraco-mcp-skills` conventions). One PR per fire. Use a
capable coding model (Sonnet or better) — it edits code. If the environment is cloud vs
local, state that explicitly in the routine prompt.
