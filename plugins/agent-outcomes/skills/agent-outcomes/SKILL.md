---
name: agent-outcomes
description: >-
  Shared skill for writing the structured outcome artifact a loop appends to a
  comment it already posts — one marker format, one growing catalog of
  outcome shapes. The agent-orchestration Worker reads the artifact and applies
  the labels itself. Load this whenever a loop skill needs to report
  build_succeeded, build_blocked, release_blocked, release_published, or any
  other cataloged outcome, or when adding a new outcome type to the catalog.
  Bundles a PostToolUse hook that signals the
  Worker on a fast, non-authoritative path automatically (a completion when
  the artifact is posted, heartbeats naming the step while the loop works),
  with nothing extra for the loop to do.
---

# agent-outcomes

The loops in this marketplace do one job and report what happened. The agent-orchestration
Worker (`worker/` in `umbraco-mcp-ops`; see `docs/agent-orchestration/11-outcome-artifact.md` in
that repo) decides what happens next, but it can only do that once the fact it needs exists
somewhere machine-readable. This skill is the one place that format is defined, so the loops
don't each invent their own. The Worker reads the artifact from the comment and applies the
labels itself, so the loop **must** write it.

This plugin also bundles a
`PostToolUse` hook (`hooks/report-completion.sh`) that runs after every tool
call, with no extra step for the loop. In a session the Worker fired (its
first prompt carries `route=… repo=… number=…`), it signals the Worker's
`/routine-signal` endpoint in two ways:
- **A completion** when the loop posts the artifact. This cancels the run's
  watchdog early.
- **A heartbeat** naming the current step, at most once a minute. This keeps
  the watchdog's deadline moving, and an expiry quotes the last step.

It needs `AGENT_OUTCOMES_ENDPOINT` (the Worker's `.../routine-signal` URL) and
`AGENT_OUTCOMES_TOKEN` set in the routine environment. Without them it only
logs, and it sends nothing from a session the Worker didn't fire.

It's deliberately not authoritative: losing a signal costs a slower watchdog
cancel or a vaguer `ai-stuck` comment, never a wrong state transition. The
comment write above is still the only thing that counts as the actual fact.

## The rule

**Append to a comment you're already posting.** The marker and JSON below get appended to
a comment your loop already posts, as a trailer. Never post a comment solely for this, and
never skip your loop's real action because you wrote the marker. 

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
| `issue-build-loop` | `build_succeeded` | `{"outcome":"build_succeeded","pr":<PR number>}` | Step 3, once `mcp-review` is clean |
| `issue-build-loop` | `build_blocked` | `{"outcome":"build_blocked","reason":"<one line>"}` | Step 3, when the issue is recorded as blocked |
| `auto-release-loop` | `release_blocked` | `{"outcome":"release_blocked","reason":"<one line>"}` | Step 2.5 on a BLOCK verdict from `release-reviewer`, or Step 1 when a re-run stops (`<dev>` commits missing, unreviewed commits on the branch, only one of branch/PR exists, or the PR doesn't qualify) |
| `release-publish` | `release_published` | `{"outcome":"release_published","version":"<version>","tag":"<the tag the repo made>"}` | Its last step, once the tag exists, the note is posted and `main` is merged back into `dev`; `tag` exactly as the repo named it |
| `auto-release-loop` | `release_approved` | `{"outcome":"release_approved","pr":<PR number>,"sha":"<reviewed head SHA>","version":"<version>","merge_method":"merge" \| "squash" \| "rebase"}` | End of Step 2.5 on a pass: the orchestrator merges (that way, pinned to `sha`) and fires `release-publish` |
| `review-loop` | `review_passed` | `{"outcome":"review_passed"}` | Its verdict comment on the PR (Step 4), when nothing survives the review |
| `review-loop` | `review_findings` | `{"outcome":"review_findings","findings":<count>}` | Its verdict comment on the PR (Step 4), after the PR review with one inline comment per finding; `findings` is how many |
| `review-loop` | `review_blocked` | `{"outcome":"review_blocked","reason":"<one line>"}` | Its verdict comment on the PR (Step 4), after a PR review saying why the approach is wrong, or that the reviewers couldn't be spawned |
| `rework-loop` | `rework_no_change` | `{"outcome":"rework_no_change","reason":"<one line>"}` | Its closing comment on the PR when there is nothing to push; the orchestrator takes `auto-reworking` off |
| `merge-flow` | `merge_blocked` | `{"outcome":"merge_blocked","reason":"<one line>"}` | Its comment on the PR on a hard block the orchestrator's gate missed; the orchestrator swaps `auto-merging` for `merge-blocked` and comments the reason |
| `issue-discuss-loop` | `discussion_capped` | `{"outcome":"discussion_capped"}` | Its comment on the issue at the round cap; the orchestrator takes `ai-discussing` off |

That's the full catalog. Two events in the reducer's vocabulary are
**deliberately not here**, on purpose rather than by omission:
`rework_pushed` (`rework-loop`) is sourced from a native
`pull_request.synchronize` webhook — a git push is already an
independently-observable GitHub event, so a self-reported comment would
be a downgrade, not an upgrade. `merge_gate_failed_soft`/
`merge_gate_failed_hard` (`merge-flow`) need a live re-check of
CI/approval/conflict state, which a comment can't carry — that's
infrastructure work, not an outcome artifact. See
`docs/agent-orchestration/11-outcome-artifact.md` for the reasoning
behind each.

## Adding a new outcome

1. Add a row to the catalog above: routine, outcome name (matching
   `graph/constants/events.ts`'s `EVENTS` — don't invent a new event name
   here), the exact JSON shape, and which step reports it.
2. Add the loop's instruction to append the marker + shape to a comment it
   already posts — per the rule above. Point at this skill by
   name; don't inline the format into the loop's own `SKILL.md`.
3. Add the matching `translate()` case in `graph/github/from-github.ts`
   (umbraco-mcp-ops) that parses it, plus fixture tests.

Steps 1–3 land together — a catalog row with no parser, or a parser with
no catalog row, is a silent way for the two to drift. No fourth step for
the hook: `report-completion.sh` matches on the marker itself, not on any
particular routine or shape, so a new outcome type needs no hook change.
