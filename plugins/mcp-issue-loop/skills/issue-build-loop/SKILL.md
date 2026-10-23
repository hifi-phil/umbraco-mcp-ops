---
name: issue-build-loop
description: >-
  Build one `ai-ready` GitHub issue into an mcp-reviewed PR and report `build_succeeded`
  with its `pr` — then stop (CI and the independent review are review-loop's; fixes are
  rework-loop's; merging is merge-flow's). This loop never responds to reviews and never
  merges. Repo-agnostic — works whether or not the repo has an Umbraco build/test toolchain
  (Umbraco MCP repos, or content-only repos like this ops repo, docs repos, plugin
  repos); github-ops and agent-outcomes required. Fired once per issue by the
  agent-orchestration Worker (route=issue-build-loop). Not for writing or refining an
  issue — that's issue-discuss-loop.
---

# issue-build-loop

Turns **one** `ai-ready` issue into a reviewed PR and reports `build_succeeded` — on **any**
repo, whether or not it has an Umbraco build/test toolchain. The fire names the issue; one fire
is one item. Only the per-issue build playbook differs between the two repo shapes, resolved in
[Config](#config-resolve-once-up-front): MCP repo (has the toolchain) vs content repo (doesn't).
How the session runs (checkout, local Umbraco) is in [`references/cloud-mode.md`](references/cloud-mode.md).

## Config (resolve once, up front)

| Thing | How to resolve | Default |
|-------|----------------|---------|
| Repo | identify the current repo (github-ops → *Detect base branch / repo*) | current repo |
| AI label | fixed | `ai-ready` |
| Base branch | the repo's `CLAUDE.md` if it names one, else the `release-and-branching` skill's detection **from the remote** (gitflow → `dev`). A shallow clone may not show `dev` locally: never take `main` because `dev` isn't in the clone | `dev` |

**Resolve the repo's shape first — don't go by what the repo is "for".** Check for a
`CLAUDE.md` and worktree hooks in `.claude/settings.json`, and match against:

| Shape | Marker | Playbook | Notes |
|---|---|---|---|
| **MCP server repo** — the `@umbraco-cms/mcp-*` family | `src/umbraco-api/tools/` | [`mcp-playbook.md`](references/mcp-playbook.md) | The common case. |
| **MCP SDK monorepo** — `umbraco/Umbraco-MCP-Base` | `packages/mcp-server-sdk` | [`mcp-playbook.md`](references/mcp-playbook.md) | Also `packages/hosted-mcp`, `packages/create-mcp-server`, `template`, and `plugins/umbraco-mcp-skills`. **Use the MCP playbook even for a skills-only change** — the repo has a real toolchain, so the content playbook doesn't fit. |
| **Content repo** — no Umbraco build/test toolchain | no `src/umbraco-api/tools/`, no `packages/mcp-server-sdk`; e.g. the `umbraco-mcp-ops` repo (skills, plugins, scripts, workflows), docs repos, plugin repos | [`content-playbook.md`](references/content-playbook.md) | Lightweight: no worktree DB hooks, no `npm run test:all`, no MCP skills. This is the converter for the `loop-improvement` issues triage files on the ops repo. |

If a repo matches none of the three (not even a content-shaped git repo), stop and say
so.

**Ops-repo scope guardrail:** on `umbraco-mcp-ops` specifically, triage files
`loop-improvement` issues **without** the `ai-ready` label on purpose — a human
decides whether to promote one. Don't self-label those.

**GitHub operations** (list issues, open/merge PRs, check CI, read failing logs,
etc.) go through the **`github-ops`** skill — name the *operation*, never a raw `gh`
command.

## Step 1 — read the issue

Read the issue the fire names (github-ops → *Get / read*): number, title, body. Confirm it
is still open and still carries `ai-ready`; if not, quiet no-op.

## Step 2 — build

Spawn **one** build subagent (`agentType: general-purpose`, background) whose prompt is the
**build playbook matching the repo's shape** —
[`references/mcp-playbook.md`](references/mcp-playbook.md) for MCP repos,
[`references/content-playbook.md`](references/content-playbook.md) for content
repos — with the issue's number/title/body substituted in, working per
[`references/cloud-mode.md`](references/cloud-mode.md).

**You choose the model** — see [Model selection](#model-selection). Triage the issue's scope
and pass the fitting tier as the Agent `model`.

The subagent's job is done when its PR is open — it does not poll CI or block on it.

## Step 3 — review and report

**Review it with `mcp-review`, here on the main thread.** Once the subagent returns an open
PR, run `mcp-review` over it. **The build subagent does not review its own code**: running the
review here is what makes it independent. If it raises findings, fix them (re-dispatch into
the checkout, or fix inline), **re-run the local tests**, then push. All testing is local (the
diff's tests on MCP repos; whatever check the content playbook ran on content repos): never
lean on CI to catch a fix's regressions. Never re-push an identical fix (**no-progress
guard**).

**The work log** (only when the dispatch passed a `log_token`): the subagent's journal,
yours, the decision list by a fresh subagent, and the build entry, as
[`references/work-log.md`](references/work-log.md) says.

**Then report and stop.** Comment the PR link on the triggering issue, with the
`build_succeeded` artifact (`pr` = the PR's number; load `agent-outcomes` for the marker and
shape). Don't drive CI or wait for it.

If the subagent reports it could not finish (e.g. the issue is genuinely ambiguous), or the
no-progress guard trips while fixing an `mcp-review` finding, comment the specific reason (the
ambiguity, what was tried) with the `build_blocked` artifact, and stop.

## Model selection

The **orchestrator decides the model per subagent** — it has read each issue, so
it triages scope and picks the tier that fits, rather than paying top-tier for a
copy tweak or under-powering a new collection. The orchestrator itself always
**inherits the session model** (don't pin it) — it's coordination and judgment,
and pinning would fight `/model` and the cloud routine's configured model.

Triage each issue at dispatch and pass the tier as the Agent `model`:

| Scope of the issue | Model |
|---|---|
| **Complex** — new tool collection, cross-cutting change, block-editing / tricky domain logic, anything with subtle correctness or many tools | `opus` |
| **Standard** — add or change one tool with its tests/evals, a focused bug fix in existing code | `sonnet` |
| **Trivial, code-touching** — a one-line fix, a schema tweak, a description change | `sonnet` |
| **Docs / non-code only** — README, comments, pure Markdown, no build/test impact | `haiku` (optional) |

**Content-repo work skews lighter** — `sonnet` by default, `haiku` for pure-docs/typo
fixes, `opus` only for intricate skill/plugin logic. Same floor and rounding rule as above.

**Floor:** never dispatch a code-touching issue below `sonnet`. `haiku` is only
acceptable for genuinely non-code work. When unsure, round **up** a tier — an
over-powered build is cheaper than a blocked one.

**Never use `fable`, for any subagent, any issue.** It isn't one of the tiers above,
and this loop hasn't validated it for a multi-step build (implement → test → push →
PR) — an untested tier failing partway through costs a full re-dispatch, more
expensive than whatever the tier saved.

(Human-review responses aren't modelled here — they're `rework-loop`'s, which picks its own
model.)

The tier names resolve to the current model in each family, so the skill doesn't
go stale as versions advance.

## Rules

- **Never touch an issue without the `ai-ready` label.** The label is the only gate. If it's
  gone, or the issue is closed, mid-flight, stop work on that issue immediately.
- **Reviews are non-negotiable, honestly reported** — see Step 3 for the mcp-review
  mechanics. Do **not** use the bundled `/security-review` / `/code-review` slash
  commands: they're `disable-model-invocation: true`, so a subagent or headless routine
  can't run them — they reach the model as inert text and the review silently never
  happens. Report only what `mcp-review` actually found; never claim a review passed
  that didn't run.
- **Follow the repo, not this skill, for specifics.** Test/build commands, the
  version-bump file list, and cleanup live in the repo's `CLAUDE.md` and the
  `release-and-branching` skill — obey those.
- **No-progress guard** — never retry the same failing command/action verbatim. If a build or
  review-fix pass produces no new state, report `build_blocked`.
