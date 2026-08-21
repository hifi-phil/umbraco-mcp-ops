---
name: rework-loop
description: >-
  Label-triggered loop that acts on PR review feedback. When a reviewer has left comments
  and labels the loop-authored PR `auto-rework`, it reads the feedback, makes the changes,
  runs a local test gate and an independent code review, pushes, replies to the threads,
  re-requests review, and removes the `auto-rework` label — then stops. It does NOT
  poll/wait for the full CI suite (merge-flow won't merge until CI passes, so CI is
  enforced there) and it never merges. Runs in a cloud routine or locally.
  Requires the github-ops skill. Trigger: a PR labelled `auto-rework`
  (uniform with the other loops, and works regardless of who reviewed), or run manually as
  "rework PR #N".
---

# rework-loop

The **review-response half of the issue loop, split out so it can be event-driven.**
`issue-build-loop` (cloud mode) takes a `ready-for-ai` issue to a CI-green PR and stops;
when you review that PR and label it **`auto-rework`**, **`rework-loop`** picks it up and
addresses the feedback — closing the write → review → rework → merge chain with no
long-lived "monitor my review" session.

## Trigger & scope

- A label rather than the review event because it's uniform with the other loops and —
  unlike a `pull_request_review` — it fires even when the reviewer's account is the PR
  author's (the loop's own identity). Reviewer flow: leave the review comments, then add
  `auto-rework`.
- **If a comment is genuinely unclear, reply on the thread asking rather than guessing.**
- Act on the **labelled PR only** — never touch other PRs.

## Test gate: local (the diff's tests) + async CI — never poll the full suite

Two distinct gates, don't conflate them: the local gate (Step 2) is this session's own
responsibility; CI is enforced asynchronously at merge time by `merge-flow`, and this
session must never poll or wait for it — keeping the rework session short is the whole
point of the split.

## Step 1 — read the feedback

Via `github-ops`, get the PR and its reviews + review comments (→ *Get reviews + review
comments*). Collect every **unresolved, actionable** item: requested changes, inline
comments, and review-body asks. If there are none (approval only, or nothing actionable
after reading) → clear `auto-rework` with a brief note and stop — clearing on this path
too, not just Step 5's, keeps the label meaning "rework pending" and the trigger
re-armable.

## Step 2 — address it (with a local test gate)

Check out the PR's head branch. **As your first action, boot a local Umbraco** so it's
ready by the time you test — follow
[`worker-env`](../../../loop-dispatch/skills/worker-env/SKILL.md)'s own boot + wait +
test-running guidance exactly rather than re-typing it here.

Then make the changes that resolve the feedback, **following the established MCP skills**
(`umbraco-mcp-skills` — tool creation, tests, descriptions) and the repo's `CLAUDE.md`
conventions. Stay **scoped to the feedback** — don't refactor unrelated code or grow the PR.
Run `npm run compile`, then run the tests per worker-env's guidance. Fix anything they
catch.

## Step 3 — review the rework with `mcp-review`

Before pushing, run the **[`mcp-review`](../mcp-review/SKILL.md)** skill over your rework
diff — the faithful 5-lens code review + security scan. This session is top-level, so it
can spawn mcp-review's independent review subagents (the reviewers didn't write the change,
so it's a real review, not self-grading). Fix anything that survives its confidence
threshold, re-run the affected tests, then proceed. **Do not** use the bundled
`/security-review` / `/code-review` slash commands — they're `disable-model-invocation:
true` and won't run here. Report only what mcp-review actually found.

## Step 4 — push

Commit and push to the PR branch. The local compile + test gate (Step 2) plus
`mcp-review` (Step 3) are the only gates this session applies — **do not poll or wait
for the full CI suite to go green** (see Test gate above).

## Step 5 — reply, re-request & clear the label

Immediately after pushing (no waiting for CI): **reply briefly on each addressed thread**
(what changed), **re-request review** from the original reviewer (github-ops → *Re-request
review*), and **remove the `auto-rework` label** from the PR (github-ops → *Add / remove a
label*). The label means "rework pending" — clearing it marks the round done and re-arms
the trigger, so a later review can re-add `auto-rework` to fire the next round.
**Do not merge** — re-approval + `merge-flow` (via the `auto-merge` label) handle that.
Send a Claude push notification: `Reworked PR #N per review — pushed & re-requested review (CI will verify).`

## Running as a routine

On an environment carrying this skill + `github-ops` (and, for good MCP code, the
`umbraco-mcp-skills` conventions). One PR per fire. Use a
capable coding model (Sonnet or better) — it edits code. If the environment is cloud vs
local, state that explicitly in the routine prompt.
