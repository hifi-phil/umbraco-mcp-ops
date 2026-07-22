# Issue lifecycle — subagent playbooks

Two playbooks. The orchestrator (see `../SKILL.md`) substitutes the issue details
and dispatches each as a subagent prompt.

- **Build playbook** — runs once per issue, in parallel (cap 3). Takes an issue
  from `ready-for-ai` to an open, CI-green PR.
- **Review-response playbook** — runs each time the human requests changes on a
  PR. Addresses the feedback and re-greens.

Both run `agentType: general-purpose` so the full tool + Skill set is available.

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
> following established MCP patterns; `npm run test:all` passes locally;
> `/security-review` and `/code-review` (low) are clean or their findings are
> fixed; the branch is pushed; a PR is open against the base branch; its CI
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

### 5. Security + code review — fix findings

Run both over your change and fix everything actionable before pushing:

```
/security-review
/code-review low
```

**These slash commands only work in an interactive / local session.** In **cloud mode**
the build runs as a subagent (or headless), where they silently no-op — there, review the
diff **inline** (Read/Grep against the security + code-quality checklist in the mcp-issue-loop
skill's Cloud mode) and **report only what actually ran**. Never claim `/security-review`
or `/code-review` passed when it didn't execute.

Treat confirmed findings like failing tests — fix them in this worktree, re-run
the relevant tests, and only then proceed. Re-run a review after fixing if the
fix was non-trivial.

### 6. Commit, push, open the PR

Commit with a clear message (end it with the repo's required
`Co-Authored-By` trailer if `CLAUDE.md` specifies one). Push the branch, then
open a PR (github-ops → *Create a PR*) against the **base branch** (`dev` for
gitflow repos — defer to the `release-and-branching` skill), linking the issue
(`Closes #{NUMBER}`) so the merge closes it. Open it **ready for review** (not draft) — the human needs
to be able to review and approve it; that review is the acceptance gate.

Include in the PR body: what changed, which skills/agents were used, test
results, and a note that security + code review ran clean.

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
disk (do **not** remove it) — the review phase reuses it. Do not wait for the
human review; that's the orchestrator's job.

> **Learnings are captured automatically — you do nothing here.** When you finish,
> a `SubagentStop` hook analyses this transcript off the critical path and files
> a `proto-learning` issue if something worth improving happened (see
> [Capturing learnings](../SKILL.md#capturing-learnings-compounding)). Just do
> the work well and return; the capture is not your responsibility.

---

## Review-response playbook

> The human reviewed PR **#{PR}** (issue #{NUMBER}) and requested changes. Your
> job: address every piece of feedback and get the PR back to green + re-requested
> review. Work in the issue's existing worktree.

### 1. Re-enter the worktree

`EnterWorktree({ path: "{WORKTREE_PATH}" })` to return to this issue's worktree
with all its state (DB, port, node_modules) intact.

### 2. Read the review

Read the PR's reviews and inline review comments (github-ops → *Get PR reviews +
review comments*). List every requested change. If any comment is unclear, reply on
the thread asking for clarification and return — don't guess at what the reviewer
meant.

### 3. Address, re-review, re-test

Make the changes (using the MCP skills again if tools/tests are involved — same
rules as the build playbook). Re-run `npm run test:all`. Re-run
`/security-review` and `/code-review low` over the new changes and fix findings.

### 4. Push, reply, re-request

Commit and push. Reply to each review thread noting how it was addressed (or
resolve it). Re-request review from the reviewer (github-ops → *Re-request review /
add reviewer*) — a fresh push often re-triggers review anyway.

### 5. Re-green CI

Watch CI as in build step 7 (same 8-attempt cap). Get it back to green before
returning.

### 6. Return

**Return** to the orchestrator: `{ prNumber, status:
"changes-addressed-green" }`. The orchestrator resumes watching for the human's
next review or approval.

> **Capture is automatic.** The `SubagentStop` hook analyses this transcript when
> you finish and files a `proto-learning` issue if the feedback revealed a
> systemic lesson. You don't file anything.
