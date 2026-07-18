# Proto-learning schema

A **proto-learning** is a raw, un-triaged observation captured while working an
issue — a CI failure you had to diagnose, a mistake you repeated, review feedback
that revealed a pattern, a blocker, or a gap in the skills / `CLAUDE.md`. It is
**not** a fix; it's a note that *something is worth improving somewhere*. A later
triage routine (Loop B) reads these, clusters them, and opens PRs to the right
home.

Because the plugin is read-only once installed (and absent on stateless runners),
proto-learnings can't be stored in the skill. They are filed as **GitHub issues
on the ops repo** `hifi-phil/umbraco-mcp-ops`, labelled `proto-learning`.

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
  "guessedHome": "repo-claude-md",
  "modelTier": "sonnet",
  "phase": "build"
}
```

| Field | Meaning |
|-------|---------|
| `sourceRepo` | `owner/name` of the MCP repo being worked. |
| `sourceIssue` | The `ready-for-ai` issue number. |
| `pr` | The PR number if one was opened (else `null`). |
| `category` | One of: `ci-failure`, `review-feedback`, `pattern-gap`, `repo-gotcha`, `cross-repo-pattern`, `tooling`, `blocked`, `test`, `other`. |
| `lesson` | One-line actionable takeaway. |
| `detail` | Self-contained description — the transcript will be gone. |
| `fix` | How it was resolved this run (empty if blocked/unresolved). |
| `guessedHome` | Best guess at the final home (Loop B decides for real): `repo-claude-md`, `project-local-skill`, `shared-mcp-skills`, `loop-self`, `unsure`. |
| `modelTier` | The model tier the subagent ran on (`opus`/`sonnet`/`haiku`) — signal for triage. |
| `phase` | `build`, `review-response`, or `orchestrator`. |

`guessedHome` heuristic (matches the loop's routing):
- true only of this repo → `repo-claude-md` (if global + cross-cutting) or
  `project-local-skill` (if specific/detailed — keep `CLAUDE.md` lean),
- would help a *different* MCP repo → `shared-mcp-skills`,
- about how the loop itself behaves → `loop-self`,
- not sure → `unsure` (Loop B will decide).

## Filing it

The issue loop runs on a dev machine, so `gh` is available:

```bash
gh issue create \
  --repo hifi-phil/umbraco-mcp-ops \
  --label proto-learning \
  --title "[proto-learning] <source-repo>#<issue>: <lesson>" \
  --body "$(cat <<'BODY'
```json
{ ... the record above ... }
```

**Notes:** optional freeform context.
BODY
)"
```

A quick `gh issue list --repo hifi-phil/umbraco-mcp-ops --label proto-learning
--search "<keywords>"` before filing avoids an obvious exact duplicate — but don't
over-invest; deduping and clustering is Loop B's job, not yours.
