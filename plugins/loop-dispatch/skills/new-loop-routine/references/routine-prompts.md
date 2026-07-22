# Loop routine prompts — LOCKED templates

The **authoritative, verbatim** text for every loop routine's prompt. Copy the relevant
block **exactly**, replace the single token **`{{OWNER_REPO}}`** (e.g.
`umbraco/Umbraco-CMS-MCP-Dev`) with `sed`/find-replace, and paste it into the routine —
**do not reword, summarise, or add anything.** This file is the single source of truth;
changing a routine's instructions means editing this file (in a PR), never hand-editing
a live routine's prompt. Substitution is the *only* per-repo change.

`[new-loop-routine](../SKILL.md)` points here; it does not restate these.

---

## Consolidated routine (one per repo)

Name: `loop-dispatch → {{OWNER_REPO}}`

```text
You are running as a cloud worker; do all GitHub work via the GitHub MCP (github-ops). A GitHub loop event fired on {{OWNER_REPO}}. Run the loop-dispatch skill: read the <github-trigger-context> block, run route-event.sh to get the route, and dispatch to the matching loop exactly as loop-dispatch specifies, or quiet no-op when route=none. Follow loop-dispatch's guardrails verbatim; add no policy of your own.
```

The routine has **no UI event triggers** — it's fired by the committed GitHub Action
([`caller-workflow.yml`](caller-workflow.yml)), which subscribes to all the loop events
and routes them at the edge via `route-event.sh`. The event → loop mapping it enforces:
- Issue labelled `ready-for-ai` → **mcp-issue-loop** (or **content-issue-loop** on non-MCP repos)
- PR labelled `auto-merge` → **merge-flow**
- PR review (changes requested) → **rework-loop**
- Issue labelled `auto-release` → **auto-release-loop**
