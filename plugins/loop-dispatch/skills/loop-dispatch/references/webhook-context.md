# Reading a GitHub webhook trigger deterministically

How a routine fired by a GitHub event receives that event, and how to route on it
with **zero judgement**. This is the contract [`loop-dispatch`](../SKILL.md) routes on;
any webhook-driven routine can reuse it.

## What the session receives

When a routine fires from a real GitHub event, the session's **opening context**
contains a structured trigger block (observed as **`<github-trigger-context>`** /
`<github-webhook-activity>`) carrying, verbatim from the webhook payload:

| Field | Example | Notes |
|---|---|---|
| event type | `issues`, `pull_request`, `pull_request_review` | which webhook |
| action | `labeled`, `opened`, `submitted` | the sub-event |
| owner / repo | `umbraco` / `Umbraco-CMS-MCP-Dev` | the repo |
| number | `302` | issue **or** PR number |
| html_url | `https://github.com/.../issues/302` | canonical link |
| label (label events) | `javascript` | **the specific label just added** |
| review state (review events) | `changes_requested` | for `pull_request_review` |

When a routine fires **without** a real event (cron, manual run, or a
mis-wired/absent subscription), **no trigger block is present** — that's a **quiet
no-op**, not an error. There is no "look for work anyway" fallback; with no event there's
nothing to route.

> The field *values* are the stable contract. The exact wrapper tag was reported by a
> live exploration firing (see the design notes below); confirm the literal tag against
> your next real event if you need byte-level certainty. Route on the fields, not on
> string-matching the wrapper.

## The deterministic recipe

1. **Look for the trigger block.** Absent → no event → **quiet no-op**. Present → continue.
2. **Extract `event`, `action`, `owner`, `repo`, `number`, `label`/`state` verbatim.**
   No inference, no guessing what to look up.
3. **Gate on the exact tuple *before* doing any work — with a script, not judgement.**
   loop-dispatch ships [`route-event.sh`](route-event.sh): pass it the parsed fields and
   it prints `route=<loop|none>`. Act only on a named route; **any other value → quiet
   no-op.** Do **not** wake a loop and let it sweep on a label you don't care about —
   that's the wasteful pattern (a Dependabot PR labelled `dependencies` must *not* trigger
   the `auto-merge` path; that's what caused merge-flow to fire 4× overnight). A scripted
   decision is byte-identical across firings and model instances.
4. **Fetch details with the exact values** through `github-ops` — `issue_read`
   (`method: "get"`) for issues, `pull_request_read` (`method: "get"`) for PRs — using
   the `owner`/`repo`/`number` from step 2. Same inputs → same data, no judgement.

## Design notes (deterministic reporting, from the exploration run)

If a routine also *reports* on the event, these keep two firings byte-comparable:

- **Fix the data source, not just the format.** Pin the exact tool call and say its
  inputs come *only* from the trigger block — no room to decide what to look up.
- **Ban paraphrasing explicitly.** "Fill fields verbatim, no paraphrasing of the body"
  is the line that actually stops prose drift between runs.
- **Template the output, not just the process.** A literal fill-in-the-blanks block,
  not "report these fields".
- **Cap the tail.** Forbid extra commentary/recommendations beyond the template — that's
  where inconsistency creeps back in.
