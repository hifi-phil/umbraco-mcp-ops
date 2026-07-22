---
name: new-loop-routine
description: >-
  Stand up the standardised cloud routine for a repo's automation loops — one
  consolidated loop-dispatch routine per repo, with identical environment, model,
  tools, connections, and a thin prompt every time, so routines don't drift as repos
  multiply. Emits the exact RemoteTrigger config + the verbatim prompt (from the locked
  template) + the UI event-wiring steps. Use when onboarding a new repo to the loops,
  or to standardise/rewrite existing routines. Interactive/local.
---

# new-loop-routine

The **single source of truth** for what a loop routine looks like. Every repo gets **one
consolidated `loop-dispatch` routine**, wired to all loop events, identical except for
the repo — same env, model, tools, connections, and a **thin prompt that only invokes a
skill** (all logic lives in the loop skills, never inlined into a routine prompt).

## Standard session config (identical for every routine)

| Field | Value |
|---|---|
| `environment_id` | your ops cloud env — the one running the `cloud-skill-sync` setup script. Get its id from `/schedule` (or the routines UI); it's account-specific, so it's not written here. |
| `model` | `claude-sonnet-5` — the dispatcher base; the loops pick their own subagent tier. |
| `allowed_tools` | `["Bash","Read","Write","Edit","Glob","Grep","Skill","Task"]`. |
| `sources` | the target repo, e.g. `https://github.com/umbraco/<repo>`. |
| `mcp_connections` | Slack + Claude_Code_Remote (for push) — use your account's connector UUIDs from `/schedule` (account-specific, not written here). |
| `enabled` | `false` at creation (API only sets a cron placeholder; enable in the UI after wiring the events). |

Never use `fable`. Never put secrets in the prompt or config.

## Prompt

The routine instructions are **not** written here — they live, verbatim, in
[`references/routine-prompts.md`](references/routine-prompts.md). Copy the
**Consolidated routine** block **exactly**, replace the single `{{OWNER_REPO}}` token
(e.g. `umbraco/Umbraco-CMS-MCP-Dev`), and paste — no rewording. That file is the single
source of truth; changing a routine's instructions means editing it **in a PR**, never
hand-editing a live routine.

Name: `loop-dispatch → {{OWNER_REPO}}`. Events to attach: Issue: Labeled `ready-for-ai` ·
Issue: Labeled `auto-release` · PR: Labeled `auto-merge` · PR review.

## Procedure

**Preconditions (once per repo):**
1. **Labels exist** on the repo: `ready-for-ai`, `generated-by-ai`, `ai-blocked`,
   `auto-merge`, `auto-release`, `release-blocked` (see `self-learning-system.md` §2).
2. **Skills reach the env** — `loop-dispatch` (and the loops) are in the
   `cloud-skill-sync` `SKILLS` list and the env has been rebuilt (bump `VERSION`, re-paste).

**Create:**
1. **Create the routine shell** (via `RemoteTrigger` `create` if available) with a
   **cron placeholder** (e.g. `0 9 * * 1-5`), `enabled: false`, the [Standard config](#standard-session-config-identical-for-every-routine),
   and the consolidated prompt. The API **cannot** bind GitHub events — that's a UI step,
   so the routine is created disabled with a placeholder cron.
2. **Wire events in the UI** — open the routine, replace the cron trigger with the four
   event triggers above, then **enable**.
3. **Smoke-test** — label a throwaway issue `ready-for-ai` (should build to a PR), and
   label a PR `dependencies` (should `route=none`, a clean no-op).

## Rules

- **One consolidated routine per repo.** All loop events on the single `loop-dispatch`
  routine.
- **Thin prompt.** The routine prompt only invokes the skill — never inline the loop's
  policy/guardrails; they live in the skill and must not drift per repo.
- **Standard config always.** Don't hand-tune per repo beyond `sources`/name.
- **Created disabled with a cron placeholder;** events + enable happen in the UI.
- **Never use `fable`.**
