---
name: new-loop-routine
description: >-
  Stand up the standardised loop automation for a repo — one loop-dispatch routine per
  repo, fired by a committed GitHub Action (not UI event triggers), with identical env,
  model, tools, connections, and a thin prompt every time. The Action routes at the edge
  and only fires the routine on a real match. Use when onboarding a new repo to the
  loops, or to standardise/rewrite existing routines. Interactive/local.
---

# new-loop-routine

The **single source of truth** for a repo's loop automation. Every repo gets **one
`loop-dispatch` routine** plus **one committed caller workflow** — identical except for
the repo. The routine is fired by the GitHub Action (via its Fire URL), so there are **no
UI event triggers** and none of the event-type-mixing limits they impose.

Why a GitHub Action, not UI triggers: the routines UI can't put different GitHub event
types (issue + PR + PR-review) on one routine, and each is a separate manual, un-scriptable
setup. A committed Actions workflow subscribes to all event types at once, routes at the
edge (`route-event.sh`), and fires the routine **only when the event maps to a loop** — so
non-matching events (a Dependabot `dependencies` label) cost nothing.

## Standard routine config (identical for every repo)

| Field | Value |
|---|---|
| `environment_id` | your ops cloud env — the one running the `cloud-skill-sync` setup script (from `/schedule`; account-specific, not written here). |
| `model` | `claude-sonnet-5` — the dispatcher base; the loops pick their own subagent tier. |
| `allowed_tools` | `["Bash","Read","Write","Edit","Glob","Grep","Skill","Task"]`. |
| `sources` | the target repo, e.g. `https://github.com/umbraco/<repo>`. |
| `mcp_connections` | Slack + Claude_Code_Remote (for push) — connector UUIDs from `/schedule` (account-specific, not written here). |
| trigger | **none / disabled cron placeholder** — the routine is fired by the Action's Fire URL, not a schedule or UI event. |

The routine's stored prompt is the **Consolidated routine** block in
[`references/routine-prompts.md`](references/routine-prompts.md) (copy verbatim, replace
`{{OWNER_REPO}}`, no rewording). The Action appends the edge-resolved route to each fire.

Never use `fable`. Never put secrets in the prompt or config.

## Procedure

**Preconditions (once per repo):**
1. **Labels exist**: `ready-for-ai`, `generated-by-ai`, `ai-blocked`, `auto-merge`,
   `auto-release`, `release-blocked` (see `self-learning-system.md` §2).
2. **Skills reach the env** — `loop-dispatch` (and the loops) are in the
   `cloud-skill-sync` `SKILLS` list and the env has been rebuilt (bump `VERSION`, re-paste).
3. **Org Actions policy** allows calling a reusable workflow from `hifi-phil/umbraco-mcp-ops`
   (if the org restricts actions to "selected", allowlist it).

**Stand it up:**
1. **Create the routine** (via `RemoteTrigger` `create`) with the [Standard config](#standard-routine-config-identical-for-every-repo),
   `enabled: false`, a cron placeholder, and the consolidated prompt. One per repo.
2. **Generate its token + Fire URL** in the routines UI (*Call via API* → *Generate
   token*). These are per-routine.
3. **Set two secrets** on the repo (or the org, to share): `LOOP_DISPATCH_FIRE_URL` (the
   Fire URL) and `LOOP_DISPATCH_TOKEN` (the token) — `gh secret set …`.
4. **Commit the caller workflow** — copy [`references/caller-workflow.yml`](references/caller-workflow.yml)
   **verbatim** to the repo as `.github/workflows/loop-dispatch.yml` (open a PR).
5. **Smoke-test** — label a throwaway issue `ready-for-ai` (Action fires → routine builds
   a PR), and label a PR `dependencies` (Action computes `route=none` → routine never fires).

## Rules

- **One routine + one caller workflow per repo.** The routine is fired by the Action's
  Fire URL — no UI event triggers.
- **Both templates are locked** — the routine prompt (`routine-prompts.md`) and the caller
  workflow (`caller-workflow.yml`) are copied **verbatim**; changing them means editing
  those files **in a PR**, never hand-editing a live routine or repo workflow.
- **Thin prompt.** The routine prompt only invokes the skill; loop policy lives in the
  loop skills and must not drift per repo.
- **Standard config always.** Don't hand-tune per repo beyond `sources`/name and the two
  secrets.
- **Never use `fable`.**
