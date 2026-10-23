---
name: rework-loop
description: >-
  Label-triggered loop that acts on PR review feedback. When a reviewer has left comments
  and labels the loop-authored PR `auto-reworking`, it reads the feedback, makes the changes,
  runs a local test gate and an independent code review, pushes, replies to the threads,
  and reports its outcome — then stops. It does NOT
  poll/wait for the full CI suite (merge-flow won't merge until CI passes, so CI is
  enforced there) and it never merges.
  Requires the github-ops and agent-outcomes skills. Trigger: a PR labelled `auto-reworking`
  (uniform with the other loops, and works regardless of who reviewed).
---

# rework-loop

The **review-response half of the issue loop, split out so it can be event-driven.**
`issue-build-loop` takes an `ai-ready` issue to an open PR and stops;
when you review that PR and label it **`auto-reworking`**, **`rework-loop`** picks it up and
addresses the feedback — closing the write → review → rework → merge chain with no
long-lived "monitor my review" session.

## Trigger & scope

- A label rather than the review event because it's uniform with the other loops and —
  unlike a `pull_request_review` — it fires even when the reviewer's account is the PR
  author's (the loop's own identity). Reviewer flow: leave the review comments, then add
  `auto-reworking`.
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
comments, and review-body asks. If there are none in a human review (approval only, or nothing actionable
after reading) → post the `rework_no_change` outcome with a brief reason and stop.

**Failing CI.** If the orchestrator added `auto-reworking` with a
"🔧 CI failing" comment, the failing checks it names are the feedback. Read those
checks' logs (github-ops → *Get PR CI / check-run status*) and fix what failed; there
may be no review at all. Read the logs once, don't poll. For this kind of rework, Step 5
has no threads to reply to.

**The review's findings.** If the orchestrator added `auto-reworking`
with a "🔍 Review round" comment, the feedback is `review-loop`'s latest PR review: its
inline comments, and its body. Fix each one; reread the issue the PR closes, so a fix
doesn't drift from what it asked for. A finding you judge wrong: reply on its thread saying
why, rather than changing the code. A finding whose fix would add
behaviour the issue didn't ask for is handled the same way: reply on its thread that it is out
of scope, quoting the issue's scope line (a requirement or its *Out of scope*), and don't
build it. A finding that the PR's own change is wrong or unsafe (a bug in its new lines, a regression, a security hole) is never out of scope, however it would be fixed. Ignore a review body's *Out of scope* section: its items are informational, not asks, and need no reply. If there's no such review to act on, push nothing: say so on the PR and stop, so a person sees it.

**The work log** (when the dispatch passed a `log_token`): read the journal before
changing anything, and weigh a challenged choice before undoing it, as
[`references/work-log.md`](references/work-log.md) says.

## Step 2 — address it (with a local test gate)

Check out the PR's head branch. **As your first action, boot a local Umbraco** so it's
ready by the time you test — follow
`worker-env`'s own boot + wait +
test-running guidance exactly rather than re-typing it here.

Then make the changes that resolve the feedback, **following the established MCP skills**
(`umbraco-mcp-skills` — tool creation, tests, descriptions) and the repo's `CLAUDE.md`
conventions. Stay **scoped to the feedback** — don't refactor unrelated code or grow the PR.
Run `npm run compile`, then run the tests per worker-env's guidance. Fix anything they
catch.

## Step 3 — review the rework with `mcp-review`

Before pushing, run the **`mcp-review`** skill over your rework
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

With a `log_token`: the rework's journal, decision and build entries, as
[`references/work-log.md`](references/work-log.md) says.

## Step 5 — reply and report

Immediately after pushing (no waiting for CI): **reply briefly on each addressed thread**
(what changed). **Every round that pushes, even a one-line fix, also post one short summary comment
on the PR** (what was fixed, the commit, what was checked), **with no `agent-outcome`
marker**: per the `agent-outcomes` skill's catalog, the push is a native GitHub event the
Worker already sees, so `rework_pushed` is deliberately not reported.
If you pushed nothing because there was no actionable feedback, Step 1 already posted
`rework_no_change`. A round that pushed nothing because every item was answered on its thread
(or a failing check needed no change) also posts `rework_no_change` with a one-line reason; the
no-review case is the only one that posts no outcome, so the label stays and a person sees the PR.
**Do not merge.**

## Running as a routine

On an environment carrying this skill + `github-ops` + `agent-outcomes` (and, for good MCP code, the
`umbraco-mcp-skills` conventions). One PR per fire. Use a
capable coding model (Sonnet or better) — it edits code.
