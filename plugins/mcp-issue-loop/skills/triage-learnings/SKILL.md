---
name: triage-learnings
description: >-
  Loop B of the self-learning system — triage the open `proto-learning` issues on
  the umbraco-mcp-ops repo. Reads the captured proto-learnings, dedupes and clusters
  them, applies a promotion threshold, and routes each cluster to the repo or process
  that owns it, never hand-editing a product repo directly. Nothing auto-merges; discarded
  learnings are closed with a reason. Runs locally or as a scheduled cloud routine;
  GitHub work goes through the required `github-ops` skill. Trigger on "triage the
  learnings", "triage proto-learnings", "run loop B", "process the learning backlog".
---

# triage-learnings (Loop B)

The capture half (see the
[schema](../mcp-issue-loop/references/proto-learning-schema.md) for the filing
mechanism) hands this skill a raw backlog of **proto-learning** GitHub issues on
`hifi-phil/umbraco-mcp-ops`. This skill is the **triage half**: on a schedule, it
turns that raw backlog into reviewed work by routing each learning to the repo that
owns it.

**The learning loop is repo-agnostic.** A proto-learning's `sourceRepo` is
**whichever Umbraco MCP repo** the loop was working — `umbraco/Umbraco-CMS-MCP-Editor`
is only one example; there are many, and this skill must treat them all the same.
Never assume the Editor MCP.

## Runtime & auth

Runs both locally and as a scheduled routine on Claude web. **For every GitHub
operation, use the `github-ops` skill** — it owns the local-vs-web mechanism, so this
skill just names the *operation* and never restates or hard-codes how to do it.

## Config (resolve once)

| Thing | Value |
|-------|-------|
| Inbox repo | `hifi-phil/umbraco-mcp-ops` |
| Inbox filter | see Step 1 |
| Homes | see the routing table below |
| Base branch (shared-skills PR) | see Step 4 |
| Routed items per run cap | see Caps & guardrails |

### Routing table

The proto-learning's `guessedHome` is a **hint**; you decide — see the table's "When" column
for the test.

| Home | Where it goes | Mechanism | When |
|------|---------------|-----------|------|
| `mcp-repo` | the learning's `sourceRepo` — **any** Umbraco MCP repo | **Issue** on that repo | The learning is **domain-specific to that MCP** — a quirk of its own content, collections, or config. Only route here for things that affect *that* MCP. |
| `shared-mcp-skills` | `umbraco/Umbraco-MCP-Base` (the `umbraco-mcp-skills` source) | **PR** (drafted) | Generalizable — recurs across repos or would help any MCP repo. **Requires the promotion threshold.** |
| `loop-self` | `hifi-phil/umbraco-mcp-ops` | **`loop-improvement` issue** | About how the loop / orchestrator itself behaves. The loop must not rewrite its own definition unreviewed. |
| *discard* | — | close | Not actionable, stale, or wrong → close the source issue with a reason. |

**Domain-specific vs. generalizable is the core judgment** (see the table above). Don't
duplicate a generalizable lesson into one repo. When genuinely unsure, prefer
`shared-mcp-skills` if it's a tooling/pattern lesson, or hold it (leave the
proto-learning open) rather than mis-filing.

## Step 1 — gather the inbox

**List** the open `proto-learning` issues on `hifi-phil/umbraco-mcp-ops` (via
`github-ops`), filtering out any also carrying `triaged`. For each, parse the fenced
```json record from the body (see the
[schema](../mcp-issue-loop/references/proto-learning-schema.md)). Skip malformed ones
with a comment asking for a reformat. If the inbox is empty, report "nothing to
triage" and stop.

## Step 2 — cluster & dedupe

Group issues that express the **same lesson** (same `sourceRepo` + `category` +
semantically-equivalent `lesson`). Each cluster becomes **one** routed item and
carries the full list of source issue numbers as **provenance**. Deduping across the
whole open set is the whole point — do it here, in reasoning, not per-issue.

## Step 3 — promotion threshold

Compounding means *a pattern*, not a one-off:

- **Recurred** (a cluster with ≥ **2** distinct source issues, or the same lesson
  seen across ≥ 2 `sourceRepo`s) → eligible for **`shared-mcp-skills`**.
- **Single occurrence** that is domain-specific → **`mcp-repo`** issue, or **hold**
  (leave open, uncommented) if it's too thin to act on yet. Do not promote a single
  incident into a shared skill.

Loop-self clusters are not threshold-gated — route them whenever they're actionable.

## Step 4 — route each cluster

Assign each cluster a home from the routing table, then:

**`mcp-repo` (domain-specific → issue on that MCP repo):**
1. Re-check against the routing table's test above; if it now looks like it'd help
   another MCP repo, re-route to `shared-mcp-skills` instead.
2. **Create an issue** on `sourceRepo` — a clear title (prefix `[from-learnings] `),
   what should change and why, and — from the analyzer's `notes` — a hint whether it
   belongs in that repo's `CLAUDE.md` (keep lean) or a project-local skill. Let that
   repo's process decide the final placement.
3. **Do not** add `ready-for-ai` — a human decides whether to feed it to the loop.

**`shared-mcp-skills` (generalizable → PR to Umbraco-MCP-Base):**
1. Detect the base branch via `release-and-branching` — never assume it.
2. **Create a branch** (`chore/proto-learning-<slug>`) and **push** the **smallest**
   edit to the `umbraco-mcp-skills` skill that *should have* surfaced the lesson
   (often `add-tool` / `mcp-patterns` / an integration-test skill).
3. **Open the PR** against the detected base.

**`loop-self` (→ `loop-improvement` issue on the ops repo):**
1. **Create an issue** on `hifi-phil/umbraco-mcp-ops` with label `loop-improvement`:
   a clear title, what the loop does today vs. what should change, and why.
2. Do **not** draft a PR editing the `mcp-issue-loop` skill — a human frames the
   change.

Every routed item — issue or PR — carries **provenance**: the source
`proto-learning` issue numbers (linked), the `sourceRepo#issue` / PR each came from,
and the occurrence count (threshold evidence). Reviewers approve facts, not vibes.

## Step 5 — mark processed

- **`shared-mcp-skills` (PR):** for each source issue in the cluster, **comment**
  with the PR link and add the **`triaged`** label (so the next run skips it) — but
  **leave it open** until the PR merges, so a rejected PR doesn't silently lose the
  learning. Never close a proto-learning just because you opened a PR for it.
- **`mcp-repo` and `loop-self` (issues):** **close** each source proto-learning with
  a comment linking the new issue — the learning lives in that issue now, so closing
  is safe (no risk of a rejected PR losing it).
- **Discarded:** close the source issue with a one-line reason.

## Caps & guardrails

- **≤ 10 routed items per run, of which ≤ 5 are PRs.** If more clusters are ready,
  route the highest-value ones, `log` how many were deferred, and leave the rest for
  the next run — never silently drop them.
- **Shared-skill PRs require the threshold + provenance.** No exceptions.
- **Never auto-merge; never force-push; never edit a protected branch directly; never
  hand-edit a product MCP repo's content — file an issue there instead.**
- One cluster → one routed item → one home. Don't bundle unrelated lessons.

## Running as a scheduled routine

Schedule this skill weekly as a Claude Code cloud routine (see the `schedule`
skill) — because capture is continuous and triage is periodic, a weekly cadence keeps
the inbox from growing without flooding anyone.
