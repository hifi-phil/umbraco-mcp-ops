---
name: new-loop-routine
description: >-
  Stand up a standardised cloud routine for a repo's automation loops — identical
  environment, model, tools, connections, and prompt every time, so routines don't
  drift as repos multiply. Default is ONE consolidated loop-dispatch routine per repo
  (all loop events on one routine); the appendix has the per-loop prompts for the
  fallback case. Emits the exact RemoteTrigger config + the verbatim prompt + the
  UI event-wiring steps. Use when onboarding a new repo to the loops, or to
  standardise/rewrite existing routines. Interactive/local.
---

# new-loop-routine

The **single source of truth** for what a loop routine looks like. Every loop routine
should come out of this skill identical except for the repo — same env, model, tools,
connections, and a **thin prompt that only invokes a skill** (all logic lives in the
loop skills, never inlined into a routine prompt).

**Default: one consolidated `loop-dispatch` routine per repo**, wired to all loop
events. Only fall back to four per-loop routines if the platform can't attach multiple
event triggers to one routine (see [Appendix](#appendix--per-loop-prompts-fallback)).

## Standard session config (identical for every loop routine)

| Field | Value |
|---|---|
| `environment_id` | the ops cloud env that runs the `cloud-skill-sync` setup script — **`env_01VxnEuhLbt9ScqRmrwtgWK9`** (confirm for the account). |
| `model` | `claude-sonnet-5` — the dispatcher/orchestrator base; the loops pick their own subagent tier. (**merge-flow-only** routine: `claude-haiku-4-5`.) |
| `allowed_tools` | `["Bash","Read","Write","Edit","Glob","Grep","Skill","Task"]` (a pure merge-flow routine needs only `["Bash","Read","Skill"]`). |
| `sources` | the target repo, e.g. `https://github.com/umbraco/<repo>`. |
| `mcp_connections` | Slack (`55c1fbd6-c65d-4c9b-881f-0d58b118f445`) + Claude_Code_Remote (`bf7c680d-5fdc-5ef4-b4a0-abadb619bf0a`, for push). |
| `enabled` | `false` at creation (API only sets a cron placeholder; enable in the UI after wiring the events). |

Never use `fable`. Never put secrets in the prompt or config.

## The consolidated routine (default)

**Name:** `loop-dispatch → <owner/repo>`

**Prompt (verbatim, substitute `<owner/repo>`):**

> A GitHub loop event fired on `<owner/repo>`. Run the **loop-dispatch** skill: read the
> `<github-trigger-context>` block, run `route-event.sh` with the parsed fields to get
> the route, and dispatch to the matching loop — mcp-issue-loop (cloud mode) /
> merge-flow / rework-loop / auto-release-loop — exactly as loop-dispatch specifies, or
> quiet no-op when `route=none`. Follow loop-dispatch's guardrails verbatim; add no
> policy of your own.

**Event triggers to attach (UI):** Issue: Labeled `ready-for-ai` · Issue: Labeled
`auto-release` · PR: Labeled `auto-merge` · PR review.

## Procedure

**Preconditions (once per repo):**
1. **Labels exist** on the repo: `ready-for-ai`, `generated-by-ai`, `ai-blocked`,
   `auto-merge`, `auto-release`, `release-blocked` (see `self-learning-system.md` §2).
2. **Skills reach the env** — `loop-dispatch` (and the loops) are in the
   `cloud-skill-sync` `SKILLS` list and the env has been rebuilt (bump `VERSION`, re-paste).
3. **The repo matches MCP conventions** (a `CLAUDE.md`, `src/*/tools/`, gitflow `dev`) —
   otherwise the loops' repo guard stops them.

**Create:**
1. **Create the routine shell** (via `RemoteTrigger` `create` if available) with a
   **cron placeholder** (e.g. `0 9 * * 1-5`), `enabled: false`, the [Standard config](#standard-session-config-identical-for-every-loop-routine),
   and the consolidated prompt above. The API **cannot** bind GitHub events — that's a
   UI step, so the routine is created disabled with a placeholder cron.
2. **Wire events in the UI** — open the routine, replace the cron trigger with the four
   event triggers above, then **enable**.
3. **Retire the old per-loop routines** for that repo — disable/delete them so a single
   event doesn't fire both the consolidated routine and a leftover per-loop one.
4. **Smoke-test** — label a throwaway issue `ready-for-ai` (should build to a PR), and
   label a PR `dependencies` (should `route=none`, a clean no-op).

## Rules

- **One consolidated routine per repo** is the default; only split to per-loop routines
  when multi-event triggers aren't available.
- **Thin prompt.** The routine prompt only invokes a skill — never inline the loop's
  policy/guardrails into the prompt; they live in the skill and must not drift per repo.
- **Standard config always.** Don't hand-tune per repo beyond `sources`/name.
- **Created disabled with a cron placeholder;** events + enable happen in the UI.
- **Never use `fable`.**

## Appendix — per-loop prompts (fallback)

If a routine can hold only one event trigger, create these four, each with the Standard
config (its own single event trigger) and the prompt below. These are the canonical
per-loop instructions — keep them verbatim so per-loop routines stay standardised too.

**mcp-issue-loop (cloud)** — trigger: Issue: Labeled `ready-for-ai`, model `sonnet`:
> Triggered when an issue is labelled `ready-for-ai` on `<owner/repo>`. Identify the
> triggering issue (the open issue labelled `ready-for-ai`; if more than one, the oldest;
> none → quiet no-op). Run **/mcp-issue-loop** in CLOUD mode for it — follow its Cloud
> mode section exactly: triage, spawn one build subagent on the best-fit model, no
> worktree, NO local Umbraco / full test suite (CI is the test gate), push, open a PR
> against `dev`, drive CI green (8-attempt cap), then mark the issue (`ready-for-ai` →
> `generated-by-ai`, or `ai-blocked` on a backstop) and STOP. Don't merge or self-review.

**merge-flow** — trigger: PR: Labeled `auto-merge`, model `haiku`, tools `[Bash,Read,Skill]`:
> Triggered when a PR is labelled `auto-merge` on `<owner/repo>`. Run **/merge-flow**
> following its guardrails exactly: merge a PR only if it has `auto-merge` AND CI is
> genuinely green (polled) AND it's conflict-free AND on the correct base AND has no
> unresolved 'changes requested'. Sweep every open `auto-merge` PR (cap 10). Quiet no-op
> if nothing qualifies; comment the blocker on any labelled PR you couldn't merge.

**rework-loop** — trigger: PR review, model `sonnet`:
> Triggered by a GitHub PR review requesting changes on `<owner/repo>`. Identify the
> triggering PR (a bot-authored PR whose latest review requests changes, not yet
> addressed; none → quiet no-op). Run **/rework-loop**: address the requested changes,
> re-green CI, re-request review, then STOP. Never merges; CI is the test gate.

**auto-release-loop** — trigger: Issue: Labeled `auto-release`, model `sonnet`:
> An `auto-release` release was requested on `<owner/repo>`. Identify the triggering issue
> (open, labelled `auto-release`; none → quiet no-op). Run **/auto-release-loop**, version
> from the issue title (`release <version>`). Follow its guardrails exactly — the CI gate,
> the Step 2.5 release-reviewer review (publish only on PASS; on BLOCK file a
> `release-blocked` issue + push-notify), prerelease handling, the main→dev sync,
> notifications. Just run the skill and let it gate.
