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

## The prompts are locked in a template — copy, don't compose

The routine instructions are **not** written here — they live, verbatim, in
[`references/routine-prompts.md`](references/routine-prompts.md). Copy the relevant block
**exactly**, replace the single `{{OWNER_REPO}}` token, and paste — no rewording. That
file is the single source of truth; changing a routine's instructions means editing it in
a PR, never hand-editing a live routine.

**Default:** the *Consolidated routine* block (name `loop-dispatch → {{OWNER_REPO}}`) with
its four event triggers. **Fallback:** the four *Per-loop* blocks, one event each, only
when a routine can't hold multiple triggers.

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

## Prompts

All routine prompts (consolidated + the four per-loop fallbacks) are in
[`references/routine-prompts.md`](references/routine-prompts.md) — copy verbatim,
substitute `{{OWNER_REPO}}`, don't reword. Editing that file (in a PR) is the *only* way
routine instructions change.
