# Issue lifecycle — build playbook

The **build playbook** below. The orchestrator (see `../SKILL.md`) substitutes the issue
details and dispatches it as a subagent prompt (`agentType: general-purpose`, so the full
tool + Skill set is available). It runs once per issue, in parallel (cap 3), and takes an
issue from `ready-for-ai` to an open, CI-green PR. The orchestrator then reviews that PR with
`mcp-review` and hands off — human change-requests are `rework-loop`'s, not a playbook here
(see *Responding to human review* at the end).

---

## Build playbook

> You are completing **one** GitHub issue in an Umbraco MCP repo, working in your
> own isolated git worktree. Issue: **#{NUMBER} — {TITLE}**.
>
> ```
> {BODY}
> ```
>
> **Definition of done (all must hold before you return):**
> a hook-backed worktree exists for this issue; the change is implemented
> following established MCP patterns; the local test gate passes — **`npm run
> test:all`** in local mode (steps 1 & 4 below); **cloud mode overrides steps 1 & 4**
> (no worktree; boot Umbraco via `worker-env` and gate on the diff's tests,
> `npm run test:changed` — see the main SKILL.md → *Cloud mode*);
> the branch is pushed; a PR is open against the base branch; its CI
> is green; and the **issue has been marked complete** — `ready-for-ai`
> removed, `generated-by-ai` added, the PR referenced on it (see step 8). If
> you cannot reach this state, stop and return a clear blocked report (what's
> ambiguous / what fails) — do not guess or half-finish.

### 1. Create your worktree

Call `EnterWorktree` with a name derived from the issue, e.g.
`issue-{NUMBER}-{short-slug}`. This fires the repo's `WorktreeCreate` hook, which
gives you a fresh SQL Server DB, a copied `.env`, a dynamic port, and a completed
`npm install`. The branch is auto-created from the worktree name (the hook
prefixes `feature/`). Everything you do happens in this worktree.

### 2. Understand the issue, then plan

Read the issue fully. Inspect the relevant collection(s) under
`src/umbraco-api/tools/`. Decide what the change is: a new tool, a change to an
existing tool, a bug fix, docs, etc. If the issue is genuinely ambiguous about
the intended behaviour, return blocked with the specific question — don't invent
scope.

### 3. Implement — follow established patterns, skip nothing

**If the work creates or changes MCP tools, use the Umbraco MCP skills — this is
mandatory, not optional** (the user's standing instruction: always use the
`umbraco-mcp-skills` for tools/tests/evals, follow the full workflow, skip
nothing). Load `/mcp-patterns` first, then use the relevant skills/agents:

- Tool creation/changes → `/add-tool` (or `/build-tools` for a whole collection),
  or the `mcp-tool-creator` agent if agent-spawning is available to you.
- Test infrastructure **before** test files → builders + helpers first
  (`test-builder-helper-creator` / `/build-tools-tests`), then integration tests
  (`/add-test`, `integration-test-creator`), then validate
  (`integration-test-validator`).
- Evals → `/add-eval` / `/build-evals` (add the new tool to every eval file's
  `allTools` array).
- Review the result → `mcp-tool-reviewer`, and tighten descriptions with
  `mcp-tool-description-writer`.

Obey `CLAUDE.md` throughout: one file per tool in the right verb folder;
`withStandardDecorators`; hand-written Zod schemas; `chainCms(...)` for chained
calls; `uuid()` for inputs vs `guid()` for Umbraco-returned values; cursor
pagination at the LLM boundary; `confirmAction` for writes; set `slices` and
`annotations`. Prefer `callTool(...)` over `handler(...)` in tests so
outputSchema is validated. Every test creates its own data and cleans up by ID —
never rely on pre-existing Umbraco content.

### 4. Run the tests locally — they must pass

Start Umbraco in this worktree if it isn't running (`npm run start:umbraco`;
first run does the unattended install and can take minutes — wait for
`.demo-site-port` and the base URL to respond). Then:

```bash
npm run test:all
```

`npm run compile` alone is not enough. Fix failures locally until green. If
state got corrupted mid-run, recycle the DB per `CLAUDE.md` (rename the DB in
`demo-site/appsettings.local.json`, restart, re-run `create-api-user.mjs`).

### 5. Review is the orchestrator's job — you do NOT self-review

**Do not run `/security-review` or `/code-review` yourself.** They can't run in a subagent
(they're `disable-model-invocation: true` — the command reaches you as inert text and
nothing happens), and a subagent grading its own code is weak anyway. Instead, once you
return a CI-green PR, **the orchestrator runs the [`mcp-review`](../../mcp-review/SKILL.md)
skill** over it (the faithful 5-lens code review + security scan, spawned as independent
review subagents) and hands you back any surviving findings to fix in this worktree. Just
build well and return; don't claim a review ran.

### 6. Commit, push, open the PR

Commit with a clear message (end it with the repo's required
`Co-Authored-By` trailer if `CLAUDE.md` specifies one). Push the branch, then
open a PR (github-ops → *Create a PR*) against the **base branch** (`dev` for
gitflow repos — defer to the `release-and-branching` skill), linking the issue
(`Closes #{NUMBER}`) so the merge closes it. Open it **ready for review** (not draft) — the human needs
to be able to review and approve it; that review is the acceptance gate.

Include in the PR body: what changed, which skills/agents were used, and test
results. **Do not claim security/code review ran** — that happens next, at the
orchestrator level via `mcp-review`; the orchestrator adds the review outcome.

### 7. Drive CI green — then return

Poll the PR's check-run status and **do not return until CI is green** (github-ops →
*Get PR CI / check-run status*).

If a check fails: read the failing check's log (github-ops → *Read a failing check's
log*), reproduce locally in your worktree, fix the root cause, push, and re-poll. A CI
failure is a real regression, never "flaky-until-proven". **Cap: at most 8
green-it attempts, and never re-push an identical fix that already failed.** If
CI still isn't green after that, stop with a blocked report (last failing log);
do not loop indefinitely.

### 8. Mark the issue's outcome

Update the **triggering issue** so its label reflects the terminal outcome and the
loop won't silently re-pick it (github-ops → *Add / remove a label* and *Comment on
an issue*). **Always remove `ready-for-ai`** — it's the queue gate and the issue is
no longer queued either way — then add the outcome label:

- **On a CI-green PR → `generated-by-ai`.** Comment the PR link (e.g. "Built by
  mcp-issue-loop → #<PR>"). The PR body's `Closes #<issue>` already links them; this
  makes the hand-off explicit for the human reviewer.
- **On a block (you hit a backstop — CI-green cap, ambiguous issue, no-progress
  guard) → `ai-blocked`.** Comment the specific reason (the last failing CI log, the
  ambiguity, what you tried). The human reads it, fixes the issue or the blocker, and
  **re-adds `ready-for-ai`** to retry — that re-queue is the only thing that revives
  an `ai-blocked` issue, so there's no silent retry loop.

If the outcome label doesn't exist on the repo, note it in your report rather than
failing the run.

### 9. Return

When CI is green (or you've hit the cap and are blocking), **return** the
structured report to the orchestrator:
`{ issue, worktreeName, worktreePath, branch, prNumber, model, tier, status }`
(`status`: `pr-open-green` or `blocked` with the reason). Leave the worktree on
disk (do **not** remove it) — the orchestrator reuses it to fix any `mcp-review` findings.
Do not review your own code and do not wait for human review; both are the orchestrator's
job (review) or `rework-loop`'s (human feedback).

> **Learnings are captured automatically — you do nothing here.** When you finish,
> a `SubagentStop` hook analyses this transcript off the critical path and files
> a `proto-learning` issue if something worth improving happened (see
> [Capturing learnings](../SKILL.md#capturing-learnings-compounding)). Just do
> the work well and return; the capture is not your responsibility.

---

## Responding to human review

There is **no review-response playbook here** — `mcp-issue-loop` builds to a CI-green,
`mcp-review`-passed PR and hands off. When the human requests changes, they add the
`auto-rework` label and [`rework-loop`](../../rework-loop/SKILL.md) actions the feedback.
Merging is `merge-flow`'s job.
