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
> fixed; the branch is pushed; a PR is open against the base branch; and its CI
> is green. If you cannot reach this state, stop and return a clear blocked
> report (what's ambiguous / what fails) — do not guess or half-finish.

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

Treat confirmed findings like failing tests — fix them in this worktree, re-run
the relevant tests, and only then proceed. Re-run a review after fixing if the
fix was non-trivial.

### 6. Commit, push, open the PR

Commit with a clear message (end it with the repo's required
`Co-Authored-By` trailer if `CLAUDE.md` specifies one). Push the branch to
`origin`. Open a PR against the **base branch** (`dev` for gitflow repos — defer
to the `release-and-branching` skill), linking the issue (`Closes #{NUMBER}`) so
the merge closes it. Open it **ready for review** (not draft) — the human needs
to be able to review and approve it; that review is the acceptance gate.

Include in the PR body: what changed, which skills/agents were used, test
results, and a note that security + code review ran clean.

### 7. Drive CI green — then return

Watch the PR's checks and **do not return until CI is green**:

```bash
gh pr checks {PR} --repo <repo> --watch
```

If a check fails: read the failing log (`gh run view --job <id> --log-failed`),
reproduce locally in your worktree, fix the root cause, push, and re-watch. A CI
failure is a real regression, never "flaky-until-proven". **Cap: at most 8
green-it attempts, and never re-push an identical fix that already failed.** If
CI still isn't green after that, stop with a blocked report (last failing log);
do not loop indefinitely.

Either way — CI green or blocked — proceed to step 8 before returning.

### 8. Capture a proto-learning, then return

However this run ended (green or blocked), **before you return** decide whether
anything worth improving happened — a CI failure you had to diagnose, a repeated
mistake, an unclear/missing pattern, a repo-specific gotcha, or a blocker. If so,
file **one** `proto-learning` issue on `hifi-phil/umbraco-mcp-ops` per the
[schema](proto-learning-schema.md) (`phase: "build"`). If the issue went cleanly
by-the-book and taught nothing, **file nothing** — silence is correct.

Then **return** the structured report to the orchestrator:
`{ issue, worktreeName, worktreePath, branch, prNumber, model, tier, status }`
(`status`: `pr-open-green` or `blocked` with the reason). Leave the worktree on
disk (do **not** remove it) — the review phase reuses it. Do not wait for the
human review; that's the orchestrator's job.

---

## Review-response playbook

> The human reviewed PR **#{PR}** (issue #{NUMBER}) and requested changes. Your
> job: address every piece of feedback and get the PR back to green + re-requested
> review. Work in the issue's existing worktree.

### 1. Re-enter the worktree

`EnterWorktree({ path: "{WORKTREE_PATH}" })` to return to this issue's worktree
with all its state (DB, port, node_modules) intact.

### 2. Read the review

```bash
gh pr view {PR} --repo <repo> --json reviews,comments
gh api repos/<repo>/pulls/{PR}/comments   # inline review comments
```

List every requested change. If any comment is unclear, reply on the thread
asking for clarification and return — don't guess at what the reviewer meant.

### 3. Address, re-review, re-test

Make the changes (using the MCP skills again if tools/tests are involved — same
rules as the build playbook). Re-run `npm run test:all`. Re-run
`/security-review` and `/code-review low` over the new changes and fix findings.

### 4. Push, reply, re-request

Commit and push. Reply to each review thread noting how it was addressed (or
resolve it). Re-request review from the reviewer:

```bash
gh pr edit {PR} --repo <repo> --add-reviewer <reviewer>
# or: gh api ... to re-request; a fresh push often re-triggers review anyway
```

### 5. Re-green CI

Watch CI as in build step 7 (same 8-attempt cap). Get it back to green before
returning.

### 6. Capture a proto-learning, then return

If the review feedback revealed a **systemic** lesson — a pattern the reviewer
keeps flagging, a convention missing from the skills or `CLAUDE.md`, a gotcha the
build phase should have caught — file **one** `proto-learning` issue per the
[schema](proto-learning-schema.md) (`phase: "review-response"`, `category`
usually `review-feedback`). Skip it for a one-off nit that carries no reusable
lesson.

Then **return** to the orchestrator: `{ prNumber, status:
"changes-addressed-green" }`. The orchestrator resumes watching for the human's
next review or approval.
