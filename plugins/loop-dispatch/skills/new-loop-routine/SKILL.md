---
name: new-loop-routine
description: >-
  Stand up the standardised loop-dispatch routine and caller GitHub Action for a repo —
  the one-time setup that onboards a repo to the loop automation. Use when onboarding a
  new repo to the loops, or to standardise/rewrite existing routines. Interactive/local.
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
   `ai-discuss` (see `self-learning-system.md`'s "Setup § 2. Labels"); `auto-release` and
   `release-blocked` are `auto-release-loop`'s own (see that skill's `SKILL.md`).
2. **Skills reach the env** — `loop-dispatch` (and the loops) are in the
   `cloud-skill-sync` `SKILLS` list and the env has been rebuilt (bump `VERSION`, re-paste).
3. **Org Actions policy** allows calling a reusable workflow from `hifi-phil/umbraco-mcp-ops`
   (if the org restricts actions to "selected", allowlist it).
4. **Heartbeats to the Worker** (only for repos the agent-orchestration Worker
   dispatches; once per environment, not per repo). The `agent-outcomes` plugin's hook
   tells the Worker the run is alive and what step it's on, so a run that dies goes
   `ai-stuck` naming its last step. See
   [Routine heartbeats](#routine-heartbeats-worker-dispatched-repos).

## Routine heartbeats (Worker-dispatched repos)

The `agent-outcomes` hook runs after every tool call in the routine. In a session the
Worker fired, it sends the Worker's `POST /routine-signal`:
- a heartbeat naming the step, at most once a minute
- a completion when the loop posts its outcome

A session the Worker didn't fire sends nothing, so one environment can serve Worker repos
and caller-workflow repos alike.

**Set up, on the ops cloud environment:**
1. **Two environment variables.** They're secrets: set them in the environment's settings,
   never in the setup script, the routine prompt or the repo.

   | Variable | Value |
   |---|---|
   | `AGENT_OUTCOMES_ENDPOINT` | the Worker's URL + `/routine-signal`: `tofu -chdir=worker/terraform output -raw worker_url`, then append `/routine-signal` |
   | `AGENT_OUTCOMES_TOKEN` | `tofu -chdir=worker/terraform output -raw routine_signal_secret` |

2. **Network access.** If the environment limits outbound hosts, allow the Worker's host
   (`<script>.<subdomain>.workers.dev`).
3. **The plugin is in the env.** `agent-outcomes` is in the `cloud-skill-sync` `SKILLS`
   list, as it already is for orchestrated mode. Rebuild the env after any of these
   (bump `VERSION`, re-paste).

**How it behaves:**
- Each heartbeat pushes the run's watchdog deadline back, so a run expires only after a
  whole timeout with no tool calls: a dead session, not a slow one.
- The step is the tool plus the call's own description or skill name (`Bash: Run the
  tests`, `Skill: mcp-review`), never a command, prompt or path, because an expiry quotes
  it in a public GitHub comment.
- Nothing runs between tool calls or after the session ends, so the heartbeats never keep
  the environment alive.
- A failed send is logged in the container (`~/.cache/agent-outcomes/capture.log`) and
  changes nothing: the GitHub write stays the authoritative signal.

**Checking it works:** the e2e suite's two `real hook` scenarios (`e2e/` in
`umbraco-mcp-ops`) run this hook against the deployed Worker, which proves the contract.
On a live repo, the proof is a run's `ai-stuck` comment quoting a step (`Last reported
step: …`) instead of "No progress step was ever reported".

**Stand it up:**
1. **Create the routine** (via `RemoteTrigger` `create`) with the [Standard config](#standard-routine-config-identical-for-every-repo),
   `enabled: false`, a cron placeholder, and the consolidated prompt. One per repo.
2. **Generate its token + Fire URL** in the routines UI (*Call via API* → *Generate
   token*). These are per-routine.
3. **Set two secrets** on the repo (or the org, to share): `LOOP_DISPATCH_FIRE_URL` (the
   Fire URL) and `LOOP_DISPATCH_TOKEN` (the token) — `gh secret set …`.
4. **Commit the caller workflow** — copy [`references/caller-workflow.yml`](references/caller-workflow.yml)
   **verbatim** to the repo as `.github/workflows/loop-dispatch.yml` (open a PR).
   **Skip this for a repo the agent-orchestration Worker dispatches**
   (`umbraco-mcp-ops` today): instead, install the Worker's GitHub App on the repo and add
   the repo's Fire URL + token to the Worker's `repo_routines` (`worker/README.md`,
   "Deploying"). The App's webhook then routes its events; there's no caller or secrets.
5. **Smoke-test** — label a throwaway issue `ready-for-ai` (Action fires → routine builds
   a PR), and label a PR `dependencies` (Action computes `route=none` → routine never fires).

**When the caller template itself changes** (a new event added to
[`caller-workflow.yml`](references/caller-workflow.yml) — e.g. `issue_comment` for the
discussion loop), **every already-onboarded repo keeps the old copy and silently won't fire the
new trigger.** The committed workflow is the subscription; the reusable workflow can't add one.
So re-commit the template verbatim to each repo that has it (one PR each) and note in the PR
which trigger is new. Check which repos are affected with:

```bash
gh api "search/code?q=repo:umbraco/<repo>+filename:loop-dispatch.yml+path:.github/workflows"
# or per repo: gh api repos/umbraco/<repo>/contents/.github/workflows/loop-dispatch.yml --jq .sha
```

## Rules

- **Both templates are locked** — the routine prompt (`routine-prompts.md`) and the caller
  workflow (`caller-workflow.yml`) are copied **verbatim**; changing them means editing
  those files **in a PR**, never hand-editing a live routine or repo workflow.
- **Thin prompt.** The routine prompt only invokes the skill; loop policy lives in the
  loop skills and must not drift per repo.
- **Standard config always.** Don't hand-tune per repo beyond `sources`/name and the two
  secrets.
