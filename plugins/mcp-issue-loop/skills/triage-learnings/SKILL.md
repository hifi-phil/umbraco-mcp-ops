---
name: triage-learnings
description: >-
  Loop B of the self-learning system — triage the open `proto-learning` issues on
  the umbraco-mcp-ops repo into pull requests. Reads the captured proto-learnings,
  dedupes and clusters them, applies a promotion threshold, and opens a gated PR to
  the right home for each cluster: the worked repo's CLAUDE.md (kept lean), a
  project-local skill, or the shared umbraco-mcp-skills (Umbraco-MCP-Base). Learnings
  about the loop/orchestrator itself are promoted into `loop-improvement` issues on
  the ops repo instead of skill-editing PRs. Nothing auto-merges; discarded learnings
  are closed with a reason. Designed to run unattended as a scheduled cloud routine on a web
  runner (uses the GitHub REST API, not `gh`). Trigger on "triage the learnings",
  "triage proto-learnings", "run loop B", "process the learning backlog".
---

# triage-learnings (Loop B)

The capture half (the `SubagentStop`/`SessionEnd` hooks) files **proto-learnings**
as `proto-learning` GitHub issues on `hifi-phil/umbraco-mcp-ops`. This skill is the
**triage half**: on a schedule, it turns that raw backlog into reviewed
improvements by opening PRs to the right home. It is **the only place** the
learning system edits skills or `CLAUDE.md` — the issue loop never does.

Everything is **PR-gated** — you draft, a human approves. You never auto-merge, and
you never edit a shared skill without evidence and a met threshold.

## Runtime & auth

Designed to run as an **unattended scheduled routine on a Claude Code web runner**,
so:

- **Use the GitHub REST API, not `gh`** — `gh` isn't installed on the runners.
  Auth is the proxy-injected `GH_TOKEN` (send `Authorization: Bearer $GH_TOKEN`);
  `curl` + `jq` are available. This mirrors `scripts/branch-housekeeping/`.
- For the heavy repo work (editing files, committing), **clone the target repo
  with git and work normally**, then push the branch and open the PR via REST
  (`POST /repos/{owner}/{repo}/pulls`). Use git for file/commit work; use REST for
  the issue/PR/label API calls `gh` would otherwise make.
- Running locally on a dev machine is fine too — `gh` works there — but author the
  routine for the REST path so it survives on a runner.

## Config (resolve once)

| Thing | Value |
|-------|-------|
| Inbox repo | `hifi-phil/umbraco-mcp-ops` |
| Inbox filter | open issues, label `proto-learning`, **not** label `triaged` |
| Homes | see the routing table below |
| Base branch per target | **detect** via the `release-and-branching` skill — never assume |
| PRs per run cap | **5** (see Caps) |

### Routing table — where each cluster's PR goes

The proto-learning's `guessedHome` is a **hint**; you decide. The test is *"would a
different Umbraco MCP repo benefit?"*

| Final home | Target repo | When |
|------------|-------------|------|
| `repo-claude-md` | the learning's `sourceRepo` (e.g. `umbraco/Umbraco-CMS-MCP-Editor`) | Genuinely global to that repo **and** cross-cutting. Keep `CLAUDE.md` lean — a terse line/section, not an essay. |
| `project-local-skill` | the learning's `sourceRepo`, under `.claude/skills/` | Specific/detailed and true only of that repo — keep it out of the always-loaded `CLAUDE.md`. |
| `shared-mcp-skills` | `umbraco/Umbraco-MCP-Base` (the `umbraco-mcp-skills` source) | Recurs across repos / would help any MCP repo. **Requires the promotion threshold.** |
| `loop-self` | `hifi-phil/umbraco-mcp-ops` — as a **tracked issue, not a PR** | About how the loop / orchestrator itself behaves. **Do not draft a skill-editing PR** (the loop must not rewrite its own definition unreviewed). Promote the cluster into a `loop-improvement` issue for a human to frame and action — see Step 4. |
| *discard* | — | Not actionable, stale, or wrong → close the issue with a reason, no PR. |

## Step 1 — gather the inbox

```
GET /repos/hifi-phil/umbraco-mcp-ops/issues?labels=proto-learning&state=open&per_page=100
```
(filter out any also carrying `triaged`). For each issue, parse the fenced ```json
record from the body (see the [schema](../mcp-issue-loop/references/proto-learning-schema.md)).
Skip malformed ones with a comment asking for a reformat. If the inbox is empty,
report "nothing to triage" and stop.

## Step 2 — cluster & dedupe

Group issues that express the **same lesson** (same `sourceRepo` + `category` +
semantically-equivalent `lesson`). Each cluster becomes **one** proposed change and
carries the full list of source issue numbers as **provenance**. Deduping across the
whole open set is the whole point — do it here, in reasoning, not per-issue.

## Step 3 — promotion threshold

Compounding means *a pattern*, not a one-off:

- **Recurred** (a cluster with ≥ **2** distinct source issues, or the same lesson
  seen across ≥ 2 `sourceRepo`s) → eligible for **`shared-mcp-skills`**.
- **Single occurrence** → route to the lower-blast-radius home (`repo-claude-md` or
  `project-local-skill`), or **hold** (leave open, uncommented) if it's too thin to
  act on yet. Do not promote a single incident into a shared skill.

Loop-behavior and repo-specific clusters are not threshold-gated — route them
whenever they're actionable.

## Step 4 — route & draft each cluster

Assign each cluster a home from the routing table.

**`loop-self` clusters are the exception — they become a tracked issue, not a PR.**
Rather than editing the `mcp-issue-loop` skill directly, promote the cluster into
one **`loop-improvement`** issue on `hifi-phil/umbraco-mcp-ops` so a human frames and
actions the change to the loop:

1. Create a `loop-improvement` issue: a clear title, what the loop does today vs.
   what should change, and why — written as an actionable work item.
2. Cite provenance: link the source `proto-learning` issue numbers and their
   occurrence count.
3. **Close** each source proto-learning with a comment linking the new
   `loop-improvement` issue (the learning is preserved in it, so closing is safe —
   unlike the PR path, there's no risk of a rejected PR losing it).

For every **other** home, open a PR:

1. **Detect the target repo's branch model** with the `release-and-branching`
   skill (gitflow `dev`+`main` → base `dev`; main-only → base `main`). The Editor
   repo is gitflow; `Umbraco-MCP-Base` and `umbraco-mcp-ops` are main-only.
2. Clone the target repo, branch (`chore/proto-learning-<slug>`), and make the
   **smallest** edit that captures the lesson:
   - `repo-claude-md` → add/extend a lean note in `CLAUDE.md` (don't bloat it).
   - `project-local-skill` → create/extend a skill under `.claude/skills/`.
   - `shared-mcp-skills` → edit the relevant `umbraco-mcp-skills` skill in
     `Umbraco-MCP-Base` (the one that *should have* surfaced the lesson — often
     `add-tool`/`mcp-patterns`/an integration-test skill).
   - `loop-self` → edit the `mcp-issue-loop` skill in this repo.
3. Push the branch and open the PR via REST against the detected base.

## Step 5 — PR body (provenance is mandatory)

Every PR body must cite its evidence so the reviewer approves facts, not vibes:

- **What & why:** the lesson and the change.
- **Provenance:** the `proto-learning` issue numbers (link them), and the
  `sourceRepo#issue` / PR each came from.
- **Occurrences:** how many distinct source issues (the threshold evidence).
- Open **ready for review**, never draft-and-forget; **never auto-merge.**

## Step 6 — mark processed

- **PR homes** (`repo-claude-md`, `project-local-skill`, `shared-mcp-skills`): for
  each source issue that made it into a PR, **comment** with the PR link and add the
  **`triaged`** label (so the next run skips it) — but **leave it open** until the PR
  merges, so a rejected PR doesn't silently lose the learning. Never close a
  proto-learning just because you opened a PR for it.
- **`loop-self`**: already handled in Step 4 — the source proto-learnings are
  **closed**, pointing at the new `loop-improvement` issue (the learning lives there
  now).
- **Discarded**: close the issue with a one-line reason.

## Caps & guardrails

- **≤ 5 PRs per run.** If more clusters are ready, open the 5 highest-value,
  `log` how many were deferred, and leave the rest for the next run — never silently
  drop them.
- **Shared-skill edits require the threshold + provenance.** No exceptions.
- **Never auto-merge; never force-push; never edit a protected branch directly.**
- **Keep `CLAUDE.md` lean** — prefer a project-local skill over growing the
  always-loaded file whenever the lesson is detailed or narrow.
- One cluster → one PR → one home. Don't bundle unrelated lessons into a PR.

## Running as a scheduled routine

Schedule this skill weekly as a Claude Code cloud routine (see the `schedule`
skill). The routine wakes, runs Steps 1–6 against the current inbox, opens up to 5
PRs, and stops — the PRs then sit for human review. Because capture is continuous
and triage is periodic, a weekly cadence keeps the inbox from growing without
flooding anyone with PRs. Author the routine for the REST path (above) so it runs on
a web runner where `gh` is absent.
