# MCP-repo build playbook

This is the MCP-repo variant; content repos use `content-playbook.md`.

The **build playbook** below. The orchestrator (see `../SKILL.md`) substitutes the issue
details and dispatches it as a subagent prompt (`agentType: general-purpose`, so the full
tool + Skill set is available). It runs once per issue, in parallel (cap 3), and takes an
issue from `ready-for-ai` to a pushed branch with an open PR. The orchestrator then drives
that PR's CI green (re-dispatching a subagent into the same worktree on a failing check),
marks the issue's outcome, and reviews it with `mcp-review` before handing off — human
change-requests are `rework-loop`'s, not a playbook here (see *Responding to human review*
at the end).

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
> following established MCP patterns; the local test gate passes — **the repo's own
> tests, scaled to your diff** in local mode (steps 1 & 4 below); **cloud mode overrides steps 1 & 4**
> (no worktree; boot Umbraco via `worker-env` and gate on the diff's tests,
> `npm run test:changed` — see the main SKILL.md → *Cloud mode*);
> the branch is pushed; and a PR is open against the base branch. Driving that
> PR's CI green and marking the issue's outcome are the **orchestrator's** job, not
> yours (see the main `SKILL.md`) — you return as soon as the PR is open. If
> you cannot reach this state, stop and return a clear blocked report (what's
> ambiguous / what fails) — do not guess or half-finish.

### 1. Create your worktree

Call `EnterWorktree` with a name derived from the issue, e.g.
`issue-{NUMBER}-{short-slug}`. This fires the repo's `WorktreeCreate` hook, which
gives you a fresh SQL Server DB, a copied `.env`, a dynamic port, and a completed
`npm install`. The branch is auto-created from the worktree name (the hook
prefixes `feature/`). Everything you do happens in this worktree.

**Re-dispatched fix, not a fresh issue?** If the orchestrator sent you back into an
**existing** worktree (a failing CI check's log, or an `mcp-review` finding) — it will say
so and give you `worktreePath` — skip this step entirely: `cd` into that path, do not call
`EnterWorktree` again (it would fire `WorktreeCreate` a second time for no reason: a new DB,
a new port, a fresh `npm install`, against a worktree that already has all of that). Go
straight to fixing the specific thing you were sent to fix, then repeat steps 4 and 6
(re-test locally, re-push) and return per step 7.

### 2. Understand the issue, then plan

Read the issue fully. Inspect the relevant area — the collection(s) under
`src/umbraco-api/tools/` on a server repo, or the relevant workspace under
`packages/` / `template/` / `plugins/` in the SDK monorepo. Decide what the change is:
a new tool, a change to an existing tool, a bug fix, docs, etc. If the issue is
genuinely ambiguous about the intended behaviour, return blocked with the specific
question — don't invent scope.

### 3. Implement — follow established patterns, skip nothing

**If the work creates or changes MCP tools, use the Umbraco MCP skills for every
step below — tools, tests, and evals, skipping none.** They encode the conventions
`mcp-review` and CI actually check for (one file per tool in the right verb folder,
`withStandardDecorators`, builders/helpers before test files, the new tool added to
every eval's `allTools` array); a hand-rolled tool passes local compile and then
fails review, costing a full re-dispatch. Load `/mcp-patterns` first, then use the
relevant skills/agents:

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

**Read `package.json` first — don't assume the script names.** A server repo has
`start:umbraco` / `test:all` / `test:changed`; the SDK monorepo (`Umbraco-MCP-Base`) has
`npm test`, `test:integration`, `test:e2e`, `test:template`, `test:cli`. Use what's there.

**Scale the gate to your diff** — the same rule cloud mode uses:

- **Tests covering what you touched** are the default gate (`npm run test:changed` on a
  server repo; the workspace's own test script in the monorepo — e.g.
  `npm test -w packages/mcp-server-sdk`).
- **The full suite** when the change reaches beyond its diff — a shared helper, a
  schema/generated-client change, cross-cutting logic, or the focused run hinting at
  wider breakage.
- **A docs-only or skills-only diff** (no `packages/**`, no `src/**`) needs neither a
  running Umbraco nor the suite. Don't pay for an Umbraco boot to fix a typo — say in
  your return what you ran and why.

**Don't run `tests/evals/*.test.ts` as part of this gate.** Eval suites need an
`ANTHROPIC_API_KEY` for the Agent SDK subprocess they spawn, and this environment never
has one — every eval file fails identically with `Claude Code process exited with code 1`
(see `hifi-phil/umbraco-mcp-ops#90`), which tells you nothing about your change and just
costs a re-diagnosis. If the repo's full-suite script (e.g. `test:all`) chains evals in,
use its non-eval script instead (e.g. `npm test`, or add
`-- --testPathIgnorePatterns=tests/evals`) — check `package.json` for what's actually
there rather than assuming `test:all` is the right gate. Eval coverage is CI's own gated
`evals` job on the branches it runs for, which does have the secret provisioned.

If the gate needs a running Umbraco, start it in this worktree if it isn't already
(`npm run start:umbraco` on a server repo; first run does the unattended install and can
take minutes — wait for `.demo-site-port` and the base URL to respond).

`npm run compile` alone is not enough for a code change. Fix failures locally until
green. If state got corrupted mid-run, recycle the DB per `CLAUDE.md` (rename the DB in
`demo-site/appsettings.local.json`, restart, re-run `create-api-user.mjs`).

### 5. CI-driving and review are the orchestrator's job — you do neither

**Do not run `/security-review` or `/code-review` yourself** — see `SKILL.md`'s Rules for
why they're inert in a subagent; a subagent grading its own code is weak anyway. You also
do **not** drive CI — once you return, **the orchestrator** polls the PR's checks and drives it green,
then runs the [`mcp-review`](../../mcp-review/SKILL.md) skill over it, handing you back
either a failing check's log or any surviving review findings to fix in this worktree. Just
build well and return; don't claim a review ran or that CI is green.

### 6. Commit, push, open the PR

Commit with a clear message (end it with the repo's required
`Co-Authored-By` trailer if `CLAUDE.md` specifies one). Push the branch, then
open a PR (github-ops → *Create a PR*) against the **base branch** (`dev` for
gitflow repos — defer to the `release-and-branching` skill), linking the issue
(`Closes #{NUMBER}`) so the merge closes it. Open it **ready for review** (not draft) — the human needs
to be able to review and approve it; that review is the acceptance gate.

Include in the PR body: what changed, which skills/agents were used, and test
results. **Do not claim security/code review ran, or that CI is green** — driving CI
green, marking the issue's outcome, and the review all happen next, at the orchestrator
level.

### 7. Return

Once your branch is pushed and the PR is open, **return** the structured report to the
orchestrator: `{ issue, worktreeName, worktreePath, branch, prNumber, model, tier, status }`
(`status`: `pr-open`, or `blocked` with the reason if you stopped early per the Definition
of done or step 2's ambiguity check). Leave the worktree on disk (do **not** remove it) — the orchestrator
reuses it to drive the PR's CI green (re-dispatching a fix into this same worktree on a
failing check) and to fix any `mcp-review` findings, per step 5 above.

---

## Responding to human review

No review-response playbook here — see `SKILL.md` Step 4 for the hand-off
(rework-loop / merge-flow).
