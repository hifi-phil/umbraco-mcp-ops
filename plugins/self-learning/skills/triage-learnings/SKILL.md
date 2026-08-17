---
name: triage-learnings
description: >-
  Loop B of the self-learning system — triage the "MCP Loop Learnings" Slack
  canvas (the capture inbox), turning captured proto-learnings into GitHub
  issues on the owning MCP repo, PRs to the shared umbraco-mcp-skills, or
  loop-improvement issues — never hand-editing a product repo directly.
  Nothing auto-merges. Runs locally or as a scheduled cloud routine. Trigger on
  "triage the learnings", "process the learning backlog", or any request to
  turn captured MCP lessons into issues or shared-skill PRs — even without
  the words "triage" or "Loop B".
---

# triage-learnings (Loop B)

The capture half (the `SubagentStop`/`SessionEnd` hooks) appends **proto-learnings**
as rows to the shared **"MCP Loop Learnings" Slack canvas**. This skill is the
**triage half**: on a schedule, it turns that raw backlog into reviewed work by
routing each learning to whichever repo, shared skillset, or loop-improvement
backlog should act on it.

**The learning loop is repo-agnostic.** A proto-learning's `Source Repo` is
**whichever Umbraco MCP repo** the loop was working on — `umbraco/Umbraco-CMS-MCP-Editor`
is only one example; there are many, and this skill must treat them all the same.

## Runtime & auth

**For the canvas inbox, use `slack_read_canvas`/`slack_update_canvas` directly**
— the Slack connector must be attached to this routine (same connector the
capture hooks use). **For every routed-item write (Step 4), use the `github-ops` skill** —
it owns the local-vs-web mechanism, so this skill just names the *operation*
and never restates or hard-codes how to do it.

> Both are required — without the Slack connector this skill has nothing to
> triage; without `github-ops` it can gather the inbox but can't route it.

## Config (resolve once)

| Thing | Value |
|-------|-------|
| Canvas inbox | `F0BQ31E4R8F` ("MCP Loop Learnings", posted in `#mcp-ops-learning`) |
| Canvas filter | `## Log` table rows where `Status` = `New` |
| Homes | see the routing table below |
| Base branch (shared-skills PR) | **detect** via the `release-and-branching` skill |
| Routed items per run cap | see Caps & guardrails |

### Routing table

Home selection follows the `Guessed Home` heuristic in
[proto-learning-schema.md](../proto-learning-capture/references/proto-learning-schema.md)
— you decide, the row's value is just a hint.

| Home | Where it goes | Mechanism | Beyond the heuristic |
|------|---------------|-----------|------|
| `mcp-repo` | the learning's `Source Repo` — **any** Umbraco MCP repo | **Issue** on that repo | — |
| `shared-mcp-skills` | `umbraco/Umbraco-MCP-Base` (the `umbraco-mcp-skills` source) | **PR** (drafted) | **Requires the promotion threshold.** |
| `loop-self` | `hifi-phil/umbraco-mcp-ops` | **`loop-improvement` issue** | The loop must not rewrite its own definition unreviewed. |
| *discard* | — | mark `Discarded` | Not actionable, stale, or wrong → mark the source row with a reason. |

**When genuinely unsure** (the schema's heuristic doesn't resolve it): lean
toward `shared-mcp-skills` if it's a tooling/pattern lesson **and it clears
Step 3's recurrence threshold**; otherwise **hold** it rather than mis-filing
(see Step 3 for what holding does).

## Step 1 — gather the inbox

Read the inbox (Config above). Each row's fields (`Category`, `Guessed Home`,
etc.) follow the
[proto-learning schema](../proto-learning-capture/references/proto-learning-schema.md)
— see [`proto-learning-capture`](../proto-learning-capture/SKILL.md) for the capture
half this inbox comes from. Keep each row's position (needed in Step 5 to update it). If
the inbox is empty, report "nothing to triage" and stop.

## Step 2 — cluster & dedupe

Group rows that express the **same lesson** (same `Category` +
semantically-equivalent `Lesson`) — **regardless of `Source Repo`**: a lesson
recurring across different repos is exactly the cross-repo pattern Step 3
looks for, so repo is provenance, not part of the grouping key. Each cluster
becomes **one** routed item and carries the full list of source row
references as **provenance**. Deduping across the whole open set is the whole
point — do it here, in reasoning, not per-row.

## Step 3 — promotion threshold

Compounding means *a pattern*, not a one-off — both read off a single
cluster's provenance:

- **Recurred** (≥ **2** distinct source rows) → eligible for **`shared-mcp-skills`**.
- **Single occurrence** that is domain-specific → **`mcp-repo`** issue, or **hold**
  (leave the row at `Status` = `New`) if it's too thin to act on yet. Do not
  promote a single incident into a shared skill.

Loop-self clusters are not threshold-gated — route them whenever they're actionable.

## Step 4 — route each cluster

Assign each cluster a home from the routing table, then follow
[`references/routing-procedures.md`](references/routing-procedures.md) for
that home's exact steps.

Every routed item — issue or PR — carries **provenance**: the source canvas
rows it came from (repo/issue + capture date), and the occurrence count
(threshold evidence). Reviewers approve facts, not vibes.

## Step 5 — mark processed

Marking a routed cluster's `Status`/`Notes` is the closing step of its home's
procedure in `references/routing-procedures.md`. For a **discarded** cluster
(no home assigned): `slack_update_canvas` to set `Status` → `Discarded`,
`Notes` → a one-line reason.

Re-read the canvas (`slack_read_canvas`) immediately before each
`slack_update_canvas` call — section IDs go stale after every edit, including
your own from a moment ago.

**End the run with a short report** — no one watches a scheduled run live:
counts of routed / held / discarded / deferred, with links to what was
created.

## Caps & guardrails

- **≤ 10 routed items per run, of which ≤ 5 are PRs** — so one weekly run never
  lands more review load than a human can absorb; this is about reviewer
  bandwidth, not correctness. If more clusters are ready, route the
  highest-value ones, note the deferred count in the run's final report, and
  leave the rest for the next run — never silently drop them.
- Don't bundle unrelated lessons into one routed item.

## Running as a scheduled routine

Schedule this skill weekly as a Claude Code cloud routine (see the `schedule`
skill, and Runtime & auth for what it needs attached). Because capture is
continuous and triage is periodic, a weekly cadence keeps
the inbox from growing without flooding anyone.
