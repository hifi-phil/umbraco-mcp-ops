---
name: agent-outcomes
description: >-
  Shared skill for writing the structured outcome artifact a loop appends to a
  comment it already posts — one marker format, one growing catalog of
  outcome shapes, so umbraco-mcp-ops's agent-orchestration reducer prototype
  can eventually read what happened instead of relying on a self-swapped
  label as the only signal. Load this whenever a loop skill needs to report
  build_succeeded, build_blocked, or any other cataloged outcome, or when
  adding a new outcome type to the catalog. Always additive — this skill
  never tells a loop to skip or replace its existing load-bearing action
  (a label swap, a merge, a push) — nothing reads the artifact yet.
---

# agent-outcomes

The loops in this marketplace already take a real action when something
finishes — swap a label, merge a PR, push a fix. `graph/` in
`umbraco-mcp-ops` (see `docs/agent-orchestration/11-outcome-artifact.md` in
that repo) is a prototype reducer that will eventually decide what happens
next instead of a loop deciding for itself — but it can only do that once
the fact it needs exists somewhere machine-readable. This skill is the one
place that format is defined, so five loops don't each invent their own.

**Nothing today reads this artifact.** No Worker, no Durable Object, no
production reducer is deployed. Writing it is pure preparation — it costs
one comment, changes no behaviour, and is safe to add to any loop.

## The rule

**Append, never replace.** Whatever your loop already does — the label
swap, the merge, the push — keep doing it exactly as before. The marker
and JSON below get appended to a comment you're *already* posting, as a
trailer. Never post a comment solely for this, and never skip your loop's
real action because you wrote the marker. If that rule and your loop's own
instructions ever conflict, your loop's own instructions win — this skill
adds a trailer, it doesn't change what "done" means.

## The format

````
<!-- agent-outcome:<your-skill-name> -->
```json
<the exact shape for your outcome, from the catalog below>
```
````

- `<your-skill-name>` is this skill's own name exactly as it appears in its
  `SKILL.md` frontmatter (e.g. `issue-build-loop`) — not a display name, not
  an abbreviation. It's what `graph/constants/routines.ts`'s `ROUTINES`
  constant holds, and what the parser matches against.
- The JSON must match one of the shapes in the catalog **exactly**. An
  outcome with no row below doesn't exist yet — see
  [Adding a new outcome](#adding-a-new-outcome) before inventing one.

## Outcome catalog

| Routine | Outcome | Shape | Reported from |
|---|---|---|---|
| `issue-build-loop` | `build_succeeded` | `{"outcome":"build_succeeded","pr":<PR number>}` | Step 3, once `mcp-review` is clean and the outcome-label swap runs |
| `issue-build-loop` | `build_blocked` | `{"outcome":"build_blocked","reason":"<one line>"}` | Step 3, when the issue is recorded as blocked |

That's the full catalog today. `release_blocked`, `release_published`
(`auto-release-loop`), `rework_pushed` (`rework-loop`), and
`merge_gate_failed_soft`/`merge_gate_failed_hard` (`merge-flow`) are named
in the reducer's event vocabulary already but have no row here yet — each
is the same shape of work as `issue-build-loop`'s, not done.

## Adding a new outcome

1. Add a row to the catalog above: routine, outcome name (matching
   `graph/constants/events.ts`'s `EVENTS` — don't invent a new event name
   here), the exact JSON shape, and which step reports it.
2. Add the loop's instruction to append the marker + shape to a comment it
   already posts — additive, per the rule above. Point at this skill by
   name; don't inline the format into the loop's own `SKILL.md`.
3. Add the matching `translate()` case in `graph/github/from-github.ts`
   (umbraco-mcp-ops) that parses it, plus fixture tests.

Steps 1–3 land together — a catalog row with no parser, or a parser with
no catalog row, is a silent way for the two to drift.
