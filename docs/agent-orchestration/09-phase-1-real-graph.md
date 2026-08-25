# Phase 1 (real): the graph as it actually runs today

[← Previous: Open questions](08-open-questions.md) | [Index](00-index.md)

---

This is the Phase 1 deliverable from [07-build-phases.md](07-build-phases.md),
done against the real system rather than the sketch in
[03-components.md](03-components.md). The dispatch and the loops already
exist in `umbraco-mcp-ops` — `plugins/loop-dispatch` (the router) and the
loop skills it fires (`issue-build-loop`, `rework-loop`, `merge-flow`,
`auto-release-loop`, `issue-discuss-loop`). Nothing here proposes new
infrastructure; it's the audit the design calls for, against the actual
skill files.

## The first correction: it isn't one `state:*` label per issue

The design assumed a single authoritative `state:*` label per issue, swapped
by one reducer. The real system uses **several independent labels, each
owned by a different loop, with no shared state model between them**:

| Label | Owner | Cleared by |
|---|---|---|
| `ready-for-ai` | Human applies; `issue-build-loop` removes | The loop itself, in the same step it adds the next label |
| `generated-by-ai` | `issue-build-loop` applies | Nobody — terminal, bookkeeping only |
| `ai-blocked` | `issue-build-loop` applies | A human, manually |
| `auto-rework` | Reviewer applies; `rework-loop` removes | The loop itself, after pushing |
| `auto-merge` | Human applies; `merge-flow` removes only on hard block | Left **on** for soft failures, so a re-check can retry |
| `auto-release` | Human applies (issue title `release <version>`) | `auto-release-loop` (not audited here) |
| `ai-discuss` | Human applies | Never by the loop — human-owned by design |

Real behaviour is closer to **per-concern edge triggers with an outcome
swap** than a clean FSM. `graph.ts` needs to model issue-lifecycle and
PR-lifecycle as two linked graphs, not one.

## The real events, and what fires

From `loop-dispatch`'s actual routing table (`route-event.sh`):

| from (label present) | on (event) | Run | to (label after) |
|---|---|---|---|
| *(none)* | issue labelled `ready-for-ai` | `issue-build-loop` | *(unchanged until outcome)* |
| `ready-for-ai` | *(agent's own outcome swap — not a webhook)* | — | `generated-by-ai` **or** `ai-blocked` |
| *(none)* | issue labelled `auto-release` (title `release <version>`) | `auto-release-loop` | — |
| *(none)* | issue labelled `ai-discuss` | `issue-discuss-loop` | *(label persists)* |
| `ai-discuss` present | comment created (unsigned, trusted, not a PR) | `issue-discuss-loop` | *(label persists)* |
| *(none)* | PR labelled `auto-merge` | `merge-flow` | removed on merge or hard block; **left on** otherwise |
| *(none)* | PR labelled `auto-rework` | `rework-loop` | removed by the loop after pushing |

The row that matters most: **the issue's outcome (`generated-by-ai` /
`ai-blocked`) is not a webhook event at all.** `issue-build-loop` writes it
itself, inline, as the last step of the same session that did the work.
Nothing re-enters `loop-dispatch` afterward — no row in the routing table
even matches those two labels. This is the load-bearing rule from
[02-design-principles.md](02-design-principles.md) being violated in
practice, not in theory: *the agent writes the outcome and the next label,
in the same breath, with nothing external checking either.*

## Where the three original symptoms already show up

**"Routines appear not to wake on a CI pass"** — `merge-flow`'s own skill
file says it: *"Optional backstop: a low-frequency poll... catches a PR
whose CI went green after its event run's CI-wait timed out."* That sentence
is an admission that the primary path (event-triggered, fires once on
`PR: Labeled`) has exactly the gap [05-technical-elements.md](05-technical-elements.md)'s
reconciliation sweep exists to close — and that the fix currently on offer
is "optional," i.e. probably not actually wired up anywhere. This is the
single strongest piece of evidence in the whole audit: the team that wrote
`merge-flow` already spotted this gap and left a note instead of a fix.

**"Agents don't always add the label back"** — two separate places do a
self-swap with no external check:
- `issue-build-loop` Step 3: removes `ready-for-ai`, adds `generated-by-ai`
  or `ai-blocked`, as its own last action. If the session dies between
  finishing the review and doing this swap, the issue sits with
  `ready-for-ai` still on it, a PR already open, and nothing distinguishing
  "still working" from "died right before finishing." A later cloud-mode
  fire could pick the same issue up again and open a second PR.
- `rework-loop` Step 5: pushes, then clears `auto-rework` itself. If it dies
  after the push but before the label removal, the label stays on with no
  automatic re-check — `loop-dispatch` only fires on the `labeled` action,
  not on the label's continued presence, so nothing re-fires `rework-loop`
  for that PR without a human re-applying the label.

**"Agents don't always finish"** — there is no watchdog anywhere in this
system today. A stalled or killed build/rework session leaves whatever label
state it had before firing; nothing notices the absence of an outcome.

## What this changes about the plan

- **Phase 1 is done for the issue/PR label surface** — the table above is
  real, not a sketch. What's still missing before Phase 2: reading
  `auto-release-loop` and `issue-discuss-loop` with the same scrutiny (not
  done in this pass), and deciding whether `issue-discuss-loop`'s
  intentionally-human-owned `ai-discuss` label needs a row in the eventual
  `graph.ts` at all, given it's explicitly designed to never transition on
  its own.
- **Phase 5 ("reducer owns labels") has two named, concrete targets**:
  `issue-build-loop` Step 3's outcome swap and `rework-loop` Step 5's label
  clear. Both need to change from "the agent sets the next label" to "the
  agent writes an outcome fact (PR comment, check-run output); a reducer
  reads that fact and sets the label."
- **Phase 7's reconciliation sweep has a real, named precedent to build on**:
  `merge-flow`'s "optional backstop" poll. Don't design that sweep from
  scratch — read what that backstop was meant to do, and why it stayed
  optional, before building the general version.
- **`ready-for-ai` → outcome is genuinely one continuous session today**,
  which matters for [05-technical-elements.md](05-technical-elements.md)'s
  cost argument against splitting nodes: `issue-build-loop` already runs
  spec → build → CI-fix → review → outcome as one context. The design's
  graph should represent that as *one* node with internal steps (visible via
  the heartbeat, §3.4/§3.6), not as five graph nodes — splitting it into
  real state-machine nodes would be a regression against what's already
  working, not an improvement.

## `auto-release-loop` and `issue-discuss-loop`

Completing the audit.

**`auto-release-loop`** — issue labelled `auto-release` (title `release
<version>`) → cut branch, bump versions, PR to main, drive CI green, run the
independent `release-reviewer` agent, publish, sync `dev`, close the issue.

- **Another fully independent reviewer**, same shape as `mcp-review` in
  `issue-build-loop`: `release-reviewer` is a separate agent that didn't do
  the work, returning `PASS`/`BLOCK`. Second real-world confirmation of
  [02-design-principles.md](02-design-principles.md)'s point — an
  independent agent's judgment is legitimately external, even though it
  isn't deterministic the way a CI result is.
- **A `BLOCK` finding does the same self-swap pattern**: the loop itself
  removes `auto-release` on block. Third instance of the pattern flagged
  above, not two.
- **The terminal signal on success is native GitHub state, not a label** —
  the issue gets closed via the API, not relabelled. Worth folding into
  `graph.ts`: a transition's "to" isn't always a `state:*` label: closing
  the issue *is* the terminal state here, and the design's table sketch in
  [03-components.md §3.1](03-components.md#31-the-transition-table) should
  allow `to` to be `closed`, not just another label.
- **"One release per triggering issue"** is a written guardrail, not an
  enforced invariant — nothing stops a human re-labelling a blocked release
  issue `auto-release` twice. Same category as the rework cap in
  [05-technical-elements.md](05-technical-elements.md): a rule an agent is
  trusted to follow, not one the reducer can currently check, because
  nothing yet counts attempts centrally.
- **No watchdog here either.** A session dying between "merged to main" and
  "tagged," or between "tagged" and "dev synced," leaves a release
  half-published with nothing noticing — arguably the highest-stakes place
  in the whole system for the watchdog in Phase 6 to land first.

**`issue-discuss-loop`** — issue or comment labelled/carrying `ai-discuss` →
one comment per fire, loop persists until a human clears the label.

- **This is a genuine level-state with no exit rule, by design** — not a
  workaround, not the human-override escape hatch in
  [03-components.md §3.3](03-components.md#33-state--github-labels). The
  label means "discussion open," full stop; only a human ever removes it
  (barring the round cap below). `graph.ts` can model it as a state with
  zero outbound transitions owned by the reducer at all.
- **The self-trigger guard already exists here, and it isn't identity-based
  — it's a content marker.** This loop posts comments *as the maintainer's
  own account*, not a bot, specifically so a human can't tell the two apart
  by author. So `loop-dispatch`'s real routing table doesn't filter by
  sender identity for this row — it filters on **an HTML comment marker
  (`<!-- issue-discuss-loop -->`) signed on every comment the loop posts**,
  and skips any comment carrying it. **This corrects
  [03-components.md §3.3](03-components.md#33-state--github-labels)**, which
  only described identity-based filtering (`isOwnBot(payload.sender)`) — that
  works for label writes from a bot identity, but not for any output written
  as a human account, which needs a content-marker check instead. Both
  mechanisms belong in `translate()`; identity alone isn't sufficient.
- **The round cap self-clears the label** — same shape as the rework cap in
  [05-technical-elements.md](05-technical-elements.md), applied to "give up
  discussing" rather than "flag a human," and again enforced by the agent
  following an instruction rather than by anything external counting.

## Phase 1 status: complete

All five loops audited. `graph.ts`/`github/from-github.ts` can now be written against
real behaviour rather than a sketch — see the corrections above before
starting Phase 2's fixture tests.

---

[← Index](00-index.md)
