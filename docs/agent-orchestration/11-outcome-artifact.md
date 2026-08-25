# 11. The first outcome artifact — issue-build-loop's build_succeeded/build_blocked

[← Index](00-index.md)

---

Phase 5's whole premise is "an agent writes a fact, it never writes the next
state" — but that only means something once at least one loop actually
writes a fact the reducer can read. This is that first one, wired end to
end into `graph/`. `translate()` in `github/from-github.ts` now has real
cases for `build_succeeded` and `build_blocked`; four events still don't
(`release_blocked`, `release_published`, `rework_pushed`,
`merge_gate_failed_*`) — same shape of work, not done yet.

## The artifact

A marker plus a fenced JSON block, appended to the same comment
`issue-build-loop` already posts on the triggering issue. The exact format
and the growing catalog of outcome shapes now live in their own shared
skill — [`plugins/agent-outcomes`](https://github.com/hifi-phil/umbraco-mcp-ops/tree/main/plugins/agent-outcomes)
— rather than here or inlined into `issue-build-loop`'s own `SKILL.md`,
for the same reason `github-ops` is its own skill: five loops will end up
needing this, and a format duplicated into five places is a format that
silently drifts. This doc stays the design rationale; that skill is the
spec other loops (and this one) actually follow.

The marker is per-routine (`agent-outcome:<routine>`) so a later loop's
artifact can never be mistaken for this one. The format reuses
`issue-discuss-loop`'s existing signed-comment convention — a marker line
plus content — rather than inventing something new; no new GitHub API
surface, no new permissions, just a comment `issue-build-loop` already had
a reason to post.

## Additive, not a replacement — on purpose, for now

`issue-build-loop`'s real Step 3 still does the label swap itself (`remove
ready-for-ai, add generated-by-ai/ai-blocked`) exactly as before. The
artifact is new output alongside it, not instead of it. This matters
because **nothing today actually reads this artifact and acts on it** — no
Worker, no Durable Object, nothing enforcing anything. If the loop stopped
doing its own label swap now, on the theory that "the reducer will handle
it," real issues would get stuck forever: nothing exists yet to pick up
the slack. Removing the loop's self-swap is only safe once something real
is deployed that performs it instead — that's the actual Phase 4/5
cutover, a separate, later step from this one.

So right now: the artifact is inert. It gets written on every real PR this
loop finishes, and nothing consumes it. That's deliberate — it means the
format can be exercised against real GitHub payloads (once shadow mode or
equivalent reads real traffic) before anything depends on it.

## What changed in `graph/`

- `github/from-github.ts`: added `parseBuildOutcome()` and the
  `OUTCOME_MARKER` constant; wired `EVENTS.BUILD_SUCCEEDED` /
  `EVENTS.BUILD_BLOCKED` from a real `issue_comment.created` payload
  instead of leaving them permanently unreachable.
- **Found and fixed a real bug while wiring this in**: the self-trigger
  guard's identity check (`isOwnBot`) was applied to *every* payload
  before the outer `switch`, not just to label webhooks. Since
  `issue-build-loop` posts its comments under the same bot identity a
  future reducer would use, that blanket check would have silently
  swallowed this exact artifact — the loop's own new fact, not an echo of
  anything the reducer wrote. Moved the identity check into the
  `issues.labeled`/`pull_request.labeled` cases specifically, where a
  self-authored label write is the actual risk. `issue_comment.created` is
  guarded only by content markers now (the signature marker for
  `issue-discuss-loop`, this outcome marker for `issue-build-loop`) — the
  same pattern §3.3 already established, just correctly scoped.

## What changed in the live skill

`plugins/mcp-issue-loop/skills/issue-build-loop/SKILL.md` Step 3 now
appends the marker + JSON to the same comment it already posts for the
success and blocked paths. This is a real, live change to production
automation — every future `issue-build-loop` run writes this artifact on
real PRs, starting now. It changes no *behaviour*: the label swap, the
comment's existing content, and everything else about what the loop does
is unchanged; this only adds a machine-readable trailer to a comment that
already existed.

New plugin: `plugins/agent-outcomes`, matching `github-ops`'s shape —
one shared skill, other plugins point at it rather than each re-explaining
the format. `issue-build-loop` references it by name for both outcomes
instead of inlining the marker/JSON; the next loop to get this treatment
(`rework-loop`, `merge-flow`, or `auto-release-loop`) adds a catalog row
there and its own `translate()` case, not a second copy of the format.

## Open questions this raises

- The JSON is currently unvalidated beyond `parseBuildOutcome()`'s shape
  check — if `issue-build-loop`'s prompt ever produces slightly malformed
  JSON (e.g. from a model mangling the fence), `translate()` silently
  returns `null` rather than surfacing the mismatch anywhere. Worth a
  point of visibility once something is actually consuming this (a
  reconciliation-sweep-style check: "this issue has an outcome comment
  that didn't parse").
- `pr` in the `build_succeeded` payload isn't used by anything downstream
  yet (no rule consumes it) — kept because the design docs' original
  sketch implied the outcome fact should carry a branch/PR reference; if
  nothing ever needs it, it's fine to drop later.

---

[← Index](00-index.md)
