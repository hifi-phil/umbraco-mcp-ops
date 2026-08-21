# Proto-learning schema

A **proto-learning** is a raw, un-triaged observation captured while any of
this repo's automated loops ran. This is shared infrastructure, not specific
to `issue-build-loop` — every loop in this repo captures through the same hooks
and the same canvas. It is **not** a fix; it's a note that *something is worth
improving somewhere* (see "When to capture" below for the actual criteria). A
later triage routine (Loop B) reads these, clusters them, and opens PRs to the
right home.

Proto-learnings are captured as a row on the shared **"MCP Loop Learnings" Slack
canvas** (`F0BQ31E4R8F`, posted in the private `#mcp-ops-learning` channel) —
**not** as GitHub issues. An earlier version of this system filed them as GitHub
issues on `hifi-phil/umbraco-mcp-ops`; that write needed the working repo and the
ops repo to share a GitHub App installation, which silently isn't true once a
cloud routine works an `umbraco/*` repo (a different org) — captures from those
runs were being lost. The canvas has no org boundary, so it's the only
destination now. `triage-learnings` (Loop B) reads it.

**Capture is automatic — this file is the contract, not a manual checklist.** The
plugin's `SubagentStop`/`SessionEnd` hooks run an analyzer over the finished
transcript; the analyzer applies the rules below and — given one narrow
Slack-canvas write tool — appends the row itself. Nobody files by hand. This
doc tells the analyzer (a) when a learning is worth capturing and (b) the exact
row shape to emit.

## When to capture — and when not to

**Capture one when something non-obvious happened** that a future run (or the
skills) should benefit from:

- a CI failure you had to diagnose (especially if it recurs or was repo-specific),
- a mistake made because a pattern was unclear, missing, or wrong in the skills,
- review feedback that points at a systemic gap (not a one-off nit),
- a blocker (ambiguous issue, environment problem, un-greenable CI),
- a repo-specific gotcha (a quirk true only of *this* repo),
- a cross-repo pattern worth promoting into the shared MCP skills.

**Do not capture** a clean, by-the-book issue where nothing was learned. Silence
is correct when the run was uneventful — the canvas must stay signal, not noise.
One row per distinct lesson; don't bundle unrelated observations.

## The canvas row shape

The canvas's `## Log` table (see the canvas itself for the live header):

`Date | Source Repo#Issue | Category | Lesson | Guessed Home | Status | Notes`

| Field | Meaning |
|-------|---------|
| `Date` | Capture date, `YYYY-MM-DD`. |
| `Source Repo#Issue` | `owner/name#issue` (or `#PR`) of what was being worked — any repo the loop touched, MCP or not. Not every loop has a single issue/PR to point at (a repo-wide sweep, a loop-level/orchestrator observation) — in that case just the repo, or the loop's own name if the learning is about the loop itself rather than any one repo. |
| `Category` | One of: `ci-failure`, `review-feedback`, `pattern-gap`, `repo-gotcha`, `cross-repo-pattern`, `tooling`, `blocked`, `test`, `other`. |
| `Lesson` | One-line actionable takeaway. |
| `Guessed Home` | Best guess at the final home (Loop B decides for real): `mcp-repo`, `shared-mcp-skills`, `loop-self`, `unsure`. |
| `Status` | Always `New` at capture time — only Loop B changes it (`Actioned`/`Discarded`). |
| `Notes` | Self-contained detail — what happened, what resolved it (if anything), the PR number if one exists, and which loop/phase this came from (the analyzer's own words — no fixed enum, since loops name their steps differently). The transcript will be gone by the time this is read back, so make it stand alone. |

`Guessed Home` heuristic (`Source Repo` is **any** Umbraco MCP repo, not a specific one):
- affects only *that* MCP — a domain-specific quirk of its content/collections →
  `mcp-repo` (Loop B files an issue on that MCP repo; note in `Notes` whether it
  belongs in `CLAUDE.md` or a project-local skill),
- would help a *different* MCP repo / recurring pattern → `shared-mcp-skills`,
- about how the loop / orchestrator itself behaves → `loop-self`,
- not sure → `unsure` (Loop B will decide).

## How it's captured (analyzer → canvas)

You (the analyzer) append the row yourself — this is the one write tool you're
given (see the hook prompts for the exact `slack_read_canvas` /
`slack_update_canvas` steps: re-read the canvas immediately before appending,
since section IDs go stale after every edit). Do it whenever you decide
something is worth capturing; when in doubt, don't append a row.

You also emit a small JSON object for the calling hook's log only — nothing
downstream parses or acts on it:

```json
{"file":true,"lesson":"one-line summary"}
```

or, to capture nothing:

```json
{"file":false}
```

Deeper deduping and clustering across rows is Loop B's job, not the analyzer's.
