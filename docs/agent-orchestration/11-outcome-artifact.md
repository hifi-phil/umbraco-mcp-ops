# 11. The outcome artifacts — build_succeeded/build_blocked, release_blocked/release_published

[← Index](00-index.md)

---

Phase 5's whole premise is "an agent writes a fact, it never writes the next
state" — but that only means something once a loop actually writes a fact
the reducer can read. `translate()` in `github/from-github.ts` now has real
cases for four events, across two loops: `issue-build-loop`'s
`build_succeeded`/`build_blocked` (the first ones wired), and
`auto-release-loop`'s `release_blocked`/`release_published`.

Two more events in the reducer's vocabulary turned out **not** to need
this treatment at all — `rework_pushed` (`rework-loop`) is sourced from a
native `pull_request.synchronize` webhook instead (a git push is already
independently observable; see below), and `merge_gate_failed_soft`/
`merge_gate_failed_hard` (`merge-flow`) need a live gate re-check, which
is infrastructure work, not an artifact. That's every event in the table
now accounted for, one way or another — none are still "not done yet" for
lack of a plan.

## The artifact

A marker plus a fenced JSON block, appended to a comment the reporting
loop already posts. The exact format
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
because **nothing today actually reads this artifact and acts on it** — a
Worker + Durable Object exists now (`worker/`) and can, but nothing is
*deployed* — no live Cloudflare account access, no real webhook
subscription, nothing enforcing anything for real. If the loop stopped
doing its own label swap now, on the theory that "the reducer will handle
it," real issues would get stuck forever: nothing live exists yet to pick
up the slack. Removing the loop's self-swap is only safe once something
real is *deployed* that performs it instead — that's the actual Phase 4/5
cutover, a separate, later step from this one.

So right now: the artifact is inert. It gets written on every real PR this
loop finishes, and nothing consumes it. That's deliberate — it means the
format can be exercised against real GitHub payloads (once shadow mode or
equivalent reads real traffic) before anything depends on it.

**This is scaffolding, not the destination.** The plan is not to leave
every loop dual-writing (self-swap + artifact) indefinitely — each
self-swap gets deleted once its specific precondition clears, tracked
row by row in [07-build-phases.md Phase 5](07-build-phases.md#phase-5--reducer-owns-labels).
Nothing here is meant to still be additive a year from now.

## What changed in `graph/`

- `github/from-github.ts`: `parseOutcomeArtifact()` now matches *any*
  loop's marker (`OUTCOME_MARKER_PATTERN`, a pattern rather than a single
  routine-specific constant) and dispatches on the outcome name inside the
  JSON, not the routine — so adding `auto-release-loop`'s two outcomes
  needed no new marker-matching logic, only two new `switch` arms.
- `outcomes.ts`: the shape type was `BuildOutcome` (two shapes); it's
  `Outcome` now (four), still one shared definition between
  `github/from-github.ts` and `routines/from-routine.ts`.
- **Found and fixed a real bug while wiring the first of these in**: the
  self-trigger guard's identity check (`isOwnBot`) was applied to *every*
  payload before the outer `switch`, not just to label webhooks. Since a
  loop posts its comments under the same bot identity a future reducer
  would use, that blanket check would have silently swallowed the exact
  artifact it was meant to protect against echoing. Moved the identity
  check into the `issues.labeled`/`pull_request.labeled` cases
  specifically, where a self-authored label write is the actual risk.
  `issue_comment.created` is guarded only by content markers now (the
  signature marker for `issue-discuss-loop`, the outcome marker for any
  loop reporting one) — the same pattern §3.3 already established, just
  correctly scoped.
- **`rework_pushed` gets its own `translate()` case, sourced from
  `pull_request.synchronize`** — no outcome artifact at all. A git push
  is already a native, independently-observable webhook; `rework-loop`
  needed zero changes, since it already pushes in its own Step 4. `reduce()`
  gates on the PR's current label the same way it gates every label-event
  case, so this maps unconditionally regardless of which PR pushed.
- **`merge_gate_failed_soft`/`merge_gate_failed_hard` are still absent,
  correctly** — their deterministic source is a live re-check of
  CI/approval/conflict state (the same checks `merge-flow` itself runs
  before commenting a blocker), not something a comment can carry. Same
  category as the CI-aggregation stub already in the file: needs a real
  `github-ops` call from whatever ends up driving the reducer, which
  doesn't exist yet. Building a fake artifact for these would report a
  fact no more verifiable than the thing it's replacing.
- `graph.ts`'s `release_published` rule was tagged `verifiedBy:
  "deterministic"` in the original Phase 1 audit — the underlying facts
  (merged, tagged, release created, dev synced) genuinely are, but as
  *implemented* here it's sourced from a self-reported comment, same as
  `build_succeeded`. Retagged `external-judgment` to match what's actually
  verified rather than what could be, with a comment noting a future
  implementation that watches the real merge+tag+release chain directly
  would earn "deterministic" back.

## What changed in the live skills

`plugins/mcp-issue-loop/skills/issue-build-loop/SKILL.md` Step 3 and
`plugins/release-flow/skills/auto-release-loop/SKILL.md` Steps 2.5 and 4
each now append the marker + JSON to a comment they already post. Real,
live changes to production automation — every future run of either loop
writes these artifacts on real issues, starting now. Neither changes
*behaviour*: the label swap, the close-out, the comment's existing
content are all unchanged; this only adds a machine-readable trailer to a
comment that already existed. `rework-loop` and `merge-flow` needed **no**
skill changes — see above.

New plugin: `plugins/agent-outcomes`, matching `github-ops`'s shape — one
shared skill, other plugins point at it rather than each re-explaining the
format. Both loops reference it by name instead of inlining the
marker/JSON; the catalog now has four rows, added without touching either
loop's own format definition (there isn't one) or `report-completion.sh`
(it matches on the marker itself, not on any particular routine or shape).

## The fast path: a hook, not a replacement for GitHub

§4 of the design is explicit that **the routine does not call us back
with its outcome**, specifically because a direct call can be lost if the
session dies mid-call, while a GitHub write either exists or doesn't and
survives independently of the session. A direct "completion" ping doesn't
get to skip that just because it's more convenient — so the resolution is:

- **The GitHub comment stays the authoritative write**, unchanged in
  role. `github/from-github.ts` reading it is still the only path that
  drives a state transition.
- **A direct ping is allowed, but only as a non-authoritative fast path**
  — the same category as the heartbeat (§3.4/§3.6): losing it costs
  detail (the watchdog waits out its full alarm instead of cancelling
  early; the dashboard shows "in progress" a little longer), never
  correctness.

The mechanism is a **`PostToolUse` hook**, not the model calling out
mid-turn: `plugins/agent-outcomes/hooks/report-completion.sh` fires
automatically, deterministically, after every tool call in the loop's
session — the harness runs it, not the model, so there's nothing for the
loop to remember to do beyond writing the comment as already documented.
It cheaply greps the tool call's input for the `<!-- agent-outcome:...`
marker, extracts the JSON, and forwards it to `AGENT_OUTCOMES_ENDPOINT` if
that env var is set — logs only otherwise, since no such endpoint exists
yet. Tested against fixture `PostToolUse` events for both the local
(Bash + `gh`) and cloud (GitHub MCP tool) paths, plus a real POST against
a local stub server — see `plugins/agent-outcomes/hooks/test/run.sh`.

`graph/routines/from-routine.ts` is the prototype for what would eventually
receive that POST — it parses a "process" (heartbeat) or "completion"
(fast-path outcome echo) signal, sharing the same outcome shape validation
(`graph/outcomes.ts`) that `github/from-github.ts` uses for the
comment-based path, so the two transports can't validate against two
different ideas of what counts as a valid outcome. Nothing is actually
listening at `AGENT_OUTCOMES_ENDPOINT` yet — that's the DO/Worker that
doesn't exist. The hook's job today is proving the mechanism works, not
delivering anything real.

**What this doesn't fix:** the comment's JSON is still hand-typed by the
model into a fence, which is exactly the kind of thing that can go quietly
wrong — a mangled fence, a typo'd field, and both `translate()` and the
hook just skip it with nothing to show for it (the hook's own shape check
catches this gracefully rather than forwarding garbage, but that's
damage control, not a fix). Having `agent-outcomes` construct the comment
itself from typed arguments, rather than leaving the model to hand-type
it, is still a separate, unbuilt improvement.

## Open questions this raises

- **Whether hooks fire the same way in a cloud routine as they do
  locally is unconfirmed** — see [08-open-questions.md](08-open-questions.md).
  Everything above is verified against fixture events run locally; nothing
  has exercised it against a real cloud routine session yet.
- **The comment's JSON is still hand-typed, not script-constructed** — see
  above. Worth a point of visibility once something is actually consuming
  the fast path (a reconciliation-sweep-style check: "this issue's hook
  fired but the shape was invalid").
- `pr` in the `build_succeeded` payload isn't used by anything downstream
  yet (no rule consumes it) — kept because the design docs' original
  sketch implied the outcome fact should carry a branch/PR reference; if
  nothing ever needs it, it's fine to drop later.

---

[← Index](00-index.md)
