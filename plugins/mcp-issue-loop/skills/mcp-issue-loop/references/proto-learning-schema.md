# Proto-learning schema

A **proto-learning** is a raw, un-triaged observation captured while working an
issue — a CI failure you had to diagnose, a mistake you repeated, review feedback
that revealed a pattern, a blocker, or a gap in the skills / `CLAUDE.md`. It is
**not** a fix; it's a note that *something is worth improving somewhere*. A later
triage routine (Loop B) reads these, clusters them, and opens PRs to the right
home.

Because the plugin is read-only once installed (and absent on stateless runners),
proto-learnings can't be stored in the skill. They are filed as **GitHub issues
on the ops repo** `hifi-phil/umbraco-mcp-ops`, labelled `proto-learning`, **and**
appended as a row to the shared **"MCP Loop Learnings" Slack canvas**
(`F0BQ31E4R8F`, posted in the private `#mcp-ops-learning` channel). Both happen
for every capture — the GitHub write needs the working repo and
`hifi-phil/umbraco-mcp-ops` to share a GitHub App installation, which isn't true
when a cloud routine works an `umbraco/*` repo (a different org), so it can
silently fail to file; the canvas has no org boundary and is the path that
always lands. `triage-learnings` (Loop B) reads both.

**Capture is automatic — this file is the contract, not a manual checklist.** The
plugin's `SubagentStop`/`SessionEnd` hooks run an analyzer over the finished
transcript; the analyzer applies the rules below and emits a decision. The hook
(read-only tools) files the GitHub issue deterministically from that decision;
the analyzer itself (given one narrow Slack-canvas write) appends the canvas
row directly, since a bash hook can't call Slack tools. Nobody files by hand.
This doc tells the analyzer (a) when a learning is worth filing and (b) the
exact record shape to emit — for both destinations.

## When to file — and when not to

**File one when something non-obvious happened** that a future run (or the skills)
should benefit from:

- a CI failure you had to diagnose (especially if it recurs or was repo-specific),
- a mistake made because a pattern was unclear, missing, or wrong in the skills,
- review feedback that points at a systemic gap (not a one-off nit),
- a blocker (ambiguous issue, environment problem, un-greenable CI),
- a repo-specific gotcha (a quirk true only of *this* repo),
- a cross-repo pattern worth promoting into the shared MCP skills.

**Do not file** for a clean, by-the-book issue where nothing was learned. Silence
is correct when the run was uneventful — the inbox must stay signal, not noise.
One proto-learning per distinct lesson; don't bundle unrelated observations.

## Format

- **Repo:** `hifi-phil/umbraco-mcp-ops`
- **Label:** `proto-learning`
- **Title:** `[proto-learning] <source-repo>#<issue>: <one-line lesson>`
- **Body:** a single fenced ```json block (the machine-readable record, so Loop B
  can parse it deterministically) followed by a short freeform **Notes** section
  for anything that doesn't fit the fields.

### The JSON record

```json
{
  "sourceRepo": "umbraco/Umbraco-CMS-MCP-Editor",
  "sourceIssue": 42,
  "pr": 128,
  "category": "ci-failure",
  "lesson": "One-line statement of what should change or be remembered.",
  "detail": "What happened, in enough detail to act on later without the transcript.",
  "fix": "What resolved it this time (empty if unresolved / blocked).",
  "guessedHome": "mcp-repo",
  "modelTier": "sonnet",
  "phase": "build"
}
```

| Field | Meaning |
|-------|---------|
| `sourceRepo` | `owner/name` of the repo being worked — an MCP repo (mcp-issue-loop) or a non-MCP repo like the ops / shared-skills repos (content-issue-loop). |
| `sourceIssue` | The `ready-for-ai` issue number. |
| `pr` | The PR number if one was opened (else `null`). |
| `category` | One of: `ci-failure`, `review-feedback`, `pattern-gap`, `repo-gotcha`, `cross-repo-pattern`, `tooling`, `blocked`, `test`, `other`. |
| `lesson` | One-line actionable takeaway. |
| `detail` | Self-contained description — the transcript will be gone. |
| `fix` | How it was resolved this run (empty if blocked/unresolved). |
| `guessedHome` | Best guess at the final home (Loop B decides for real): `mcp-repo`, `shared-mcp-skills`, `loop-self`, `unsure`. |
| `modelTier` | The model tier the subagent ran on (`opus`/`sonnet`/`haiku`) — signal for triage. |
| `phase` | `build`, `review-response`, or `orchestrator`. |

`guessedHome` heuristic (`sourceRepo` is **any** Umbraco MCP repo, not a specific one):
- affects only *that* MCP — a domain-specific quirk of its content/collections →
  `mcp-repo` (Loop B files an issue on that MCP repo; in `notes`, hint whether it
  belongs in `CLAUDE.md` or a project-local skill),
- would help a *different* MCP repo / recurring pattern → `shared-mcp-skills`,
- about how the loop / orchestrator itself behaves → `loop-self`,
- not sure → `unsure` (Loop B will decide).

## The canvas row shape

The canvas's `## Log` table (see the canvas itself for the live header) uses
the same fields, flattened to one row plus a triage-state field the GitHub
issue doesn't need:

`Date | Source Repo#Issue | Category | Lesson | Guessed Home | Status | Notes`

`Date` is the capture date (`YYYY-MM-DD`), `Source Repo#Issue` is
`sourceRepo`#`sourceIssue`, `Category`/`Lesson`/`Guessed Home` map directly to
`category`/`lesson`/`guessedHome`, `Notes` holds `detail` + `fix` (and the `pr`
number if set). `Status` starts as `New` at capture time — Loop B (below) is
what changes it to `Actioned`/`Discarded`.

## How it's filed (analyzer → hook, and analyzer → canvas)

You (the analyzer) do **not** file the GitHub issue — you have read-only tools
over the transcript/repo. Emit a single JSON object and the hook
(`hooks/capture-proto-learning.sh`) files it:

```json
{"file":true,"title":"[proto-learning] <source-repo>#<issue>: <lesson>","record":{ ...the record fields above... },"notes":"optional freeform context"}
```

To capture nothing, emit `{"file":false}`.

The hook then creates the issue (title from `.title`, body = the fenced `record`
JSON followed by **Notes:**), and skips an obvious exact-title duplicate itself.
Deeper deduping and clustering is Loop B's job, not the analyzer's — when in
doubt about whether a learning is worth it, err toward `{"file":false}`.

**You do append the canvas row yourself** — that's the one write tool you're
given (see the hook prompts for the exact `slack_read_canvas` /
`slack_update_canvas` steps). Do it whenever `file:true`, independent of
whether the GitHub issue above is expected to succeed.
