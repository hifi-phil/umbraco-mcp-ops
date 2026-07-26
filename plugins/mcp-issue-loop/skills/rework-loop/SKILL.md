---
name: rework-loop
description: >-
  Label-triggered loop that acts on PR review feedback. When a reviewer has left comments
  and labels the loop-authored PR `auto-rework`, it reads the feedback, makes the changes
  following the established MCP skills, boots a local Umbraco via the worker-env skill and
  runs the diff's tests (test:changed) as a local gate, pushes, replies to the threads,
  re-requests review, and removes the `auto-rework` label — then stops. It runs a local
  test gate but does NOT poll/wait for the full CI suite (merge-flow won't merge until CI
  passes, so CI is enforced there) and it never merges. Runs in a cloud routine or locally.
  Requires the github-ops skill. Trigger: a PR labelled `auto-rework`
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

## Test gate: local (the diff's tests) + async CI — never poll the full suite

Two distinct gates, don't conflate them:

- **Local, before pushing:** bring up a local Umbraco via the
  **[`worker-env`](../../../loop-dispatch/skills/worker-env/SKILL.md)** skill and run the
  tests that cover the rework diff — **`npm run test:changed`** (fallback
  `npm run test:one -- --testPathPattern='…'` if the repo lacks that script). This catches
  regressions in your change before it reaches CI. Not `npm run test:all` — the full suite
  is CI's job.
- **CI, asynchronously:** GitHub Actions runs the full integration/eval suite on the PR, and
  **`merge-flow` won't merge until CI is green** — so CI is enforced at merge time. This
  session **must not poll or wait for CI**; it runs the local gate, pushes, and stops.
  Keeping the rework session short is the whole point of the split.

All GitHub work goes through the **`github-ops`** skill (required).

## Step 1 — read the feedback

Via `github-ops`, get the PR and its reviews + review comments (→ *Get reviews + review
comments*). Collect every **unresolved, actionable** item: requested changes, inline
comments, and review-body asks. If there are none (approval only) → **quiet no-op, stop.**

## Step 2 — address it (with a local test gate)

Check out the PR's head branch. **As your first action, boot a local Umbraco** so it's
ready by the time you test (consult `worker-env` for the manifest / provider details):

```
bash /root/.umbraco-ops/run-umbraco.sh --provider sqlite >/tmp/umbraco-run.log 2>&1 &
```

Then make the changes that resolve the feedback, **following the established MCP skills**
(`umbraco-mcp-skills` — tool creation, tests, descriptions) and the repo's `CLAUDE.md`
conventions. Stay **scoped to the feedback** — don't refactor unrelated code or grow the PR.
Run `npm run compile`, then — once Umbraco is ready (`.demo-site-port` +
`/umbraco/management/api/v1/server/status` returns 200) — run the diff's tests:
**`npm run test:changed`** (fallback `npm run test:one -- --testPathPattern='…'`). Fix
anything they catch. Use `npm run test:all` only if the rework is broad; CI runs the full
suite regardless.

## Step 3 — push

Commit and push to the PR branch. The local `compile` + `test:changed` gate from Step 2 is
the only gate this session applies — **do not poll or wait for the full CI suite to go
green.** CI runs asynchronously and `merge-flow` enforces it at merge time, so a rework
session that sits watching check-runs just burns time and tokens for no benefit.

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
- **Gate locally, then hand off — never poll the full CI suite.** Run `test:changed` (the
  diff's tests) before pushing, then push and stop. `merge-flow` won't merge until CI is
  green, so the full suite is enforced there; a rework session polling check-runs just
  wastes time and tokens.
- Follow the MCP skills for code changes; the local `test:changed` gate catches regressions
  in your change, and **CI runs the full suite asynchronously** as the merge-time gate.

## Running as a routine

Trigger: a PR labelled **`auto-rework`** (routed by the loop-dispatch Action), on an
environment carrying this skill + `github-ops` (and, for good MCP code, the
`umbraco-mcp-skills` conventions). One PR per fire. Use a
capable coding model (Sonnet or better) — it edits code. If the environment is cloud vs
local, state that explicitly in the routine prompt.
