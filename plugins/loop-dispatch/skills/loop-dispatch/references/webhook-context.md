# Routing a GitHub event deterministically (the edge contract)

How the loop system turns a GitHub event into a route with **zero judgement**. Routing
happens **at the edge** — in the caller GitHub Action, `route-event.sh` reads the event
and decides — so `loop-dispatch` only ever receives an already-resolved route. This is
the field contract `route-event.sh` routes on; any webhook-driven automation can reuse it.

## The event fields route-event.sh reads

In the caller workflow the event is at **`$GITHUB_EVENT_PATH`** (the payload JSON) with
its type in **`$GITHUB_EVENT_NAME`** — standard GitHub Actions env. `route-event.sh`
pulls, verbatim:

| Field | Example | Notes |
|---|---|---|
| event type | `issues`, `pull_request`, `pull_request_review` | `$GITHUB_EVENT_NAME` |
| action | `labeled`, `opened`, `submitted` | `.action` |
| owner / repo | `umbraco/Umbraco-CMS-MCP-Dev` | `.repository.full_name` |
| number | `302` | `.issue.number` / `.pull_request.number` |
| label (label events) | `javascript` | `.label.name` — **the specific label just added** |
| review state (review events) | `changes_requested` | `.review.state` |

(Legacy: a routine fired by a *native UI event trigger* instead received these in a
`<github-trigger-context>` session block — the same fields. The Action/edge model
supersedes that; the field contract is identical either way.)

## The deterministic recipe

1. **Read the event** from `$GITHUB_EVENT_PATH` (+ `$GITHUB_EVENT_NAME`). No event → **quiet no-op**.
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
  inputs come *only* from the parsed event fields — no room to decide what to look up.
- **Ban paraphrasing explicitly.** "Fill fields verbatim, no paraphrasing of the body"
  is the line that actually stops prose drift between runs.
- **Template the output, not just the process.** A literal fill-in-the-blanks block,
  not "report these fields".
- **Cap the tail.** Forbid extra commentary/recommendations beyond the template — that's
  where inconsistency creeps back in.
