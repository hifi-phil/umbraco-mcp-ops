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
| event type | `issues`, `pull_request`, `issue_comment` | `$GITHUB_EVENT_NAME` |
| action | `labeled`, `opened`, `created` | `.action` |
| owner / repo | `umbraco/Umbraco-CMS-MCP-Dev` | `.repository.full_name` |
| number | `302` | `.issue.number` / `.pull_request.number` |
| label (label events) | `javascript` | `.label.name` — **the specific label just added** |
| review state (review events) | `changes_requested` | `.review.state` |

**`issue_comment` reads a different set**, because the payload has no `.label` — the trigger is
the label already *on* the issue, so the gate is built from the issue and the comment instead:

| Field | Example | Notes |
|---|---|---|
| issue labels | `bug,ai-discuss` | `.issue.labels[].name` — the labels already on the issue |
| issue state | `open` | `.issue.state` — a closed issue routes nowhere |
| author association | `OWNER` | `.comment.author_association` — only `OWNER`/`MEMBER`/`COLLABORATOR` route. These repos are public; without this any user could fire a session |
| author type | `User` | `.comment.user.type` — must be `User` |
| loop's own marker | `<!-- issue-discuss-loop` | `.comment.body` contains it → **routes nowhere**. The loop posts as the *maintainer's own account*, so the author fields can't tell its reply from a human's; the marker is the only anti-self-reply guard |
| is it a PR? | present / absent | `.issue.pull_request` — set for PR conversation comments, which route nowhere |

Every one of these is **fail-closed**: a missing or unexpected value routes nowhere.

(Legacy: a routine fired by a *native UI event trigger* instead received these in a
`<github-trigger-context>` session block — the same fields. The Action/edge model
supersedes that; the field contract is identical either way.)

## The deterministic recipe

1. **Read the event** from `$GITHUB_EVENT_PATH` (+ `$GITHUB_EVENT_NAME`). No event → **quiet no-op**.
2. **Extract `event`, `action`, `owner`, `repo`, `number`, `label`/`state` verbatim** — plus,
   for `issue_comment`, the issue's labels + state and the comment's association, author type,
   and marker (see the second table above). No inference, no guessing what to look up.
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
