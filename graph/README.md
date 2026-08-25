# graph/ — Phase 1/2 prototype

Pure logic only, per the build order in the design doc
(`agent-orchestration-plan/07-build-phases.md`), split into pipeline
stages, each with its own fixture tests:

```
github/from-github.ts  ─┐
                         ├─→  graph.ts  →  github/to-github.ts
routines/from-routine.ts ┘
   (webhook/signal→event)   (event→rule)     (rule→GitHub calls)
```

- `github/from-github.ts` — raw GitHub webhook payload → abstract domain
  `Event`. GitHub telling us something happened. **Authoritative** — this
  is the only path that ever drives a state transition.
- `routines/from-routine.ts` — a direct signal from a routine (not via
  GitHub at all) → either a heartbeat update or a fast-path echo of an
  outcome. **Never authoritative** — see below.
- `graph.ts` — the transition table and `reduce()`: which rule fires, given
  the current state and an event. The state machine itself, nothing else —
  it knows nothing about GitHub's actual API shapes.
- `github/to-github.ts` — a fired rule's effect → the concrete GitHub label
  add/remove/close calls it requires, given the labels actually present
  right now. Us telling GitHub what to do about it — the mirror image of
  `from-github.ts`.

Grouping the GitHub-facing files under `github/` and naming them by
direction (`from-`/`to-`) makes that split structural, not just something
documented in a comment: `graph.ts` is the domain core and never imports
anything GitHub-shaped (`WebhookPayload`, `LabelOp`); `github/` is the
boundary that does. `routines/` is a second, smaller boundary for data that
skips GitHub entirely — see
[the design doc's rationale](../docs/agent-orchestration/11-outcome-artifact.md)
for why a routine's outcome still has to go through `github/from-github.ts`
to count, and what `routines/from-routine.ts` is for instead (the watchdog
cancelling its alarm promptly, the dashboard showing "done" sooner — never
a state transition on its own). No `routines/to-routine.ts` exists: nothing
sends data back to a routine today.

No Worker, no Durable Object, no D1 — none of that exists yet, and nothing
here talks to GitHub, or anything else, for real.

This is the first code in this repo that isn't shell or Markdown — a
deliberate, scoped choice: a `package.json` here doesn't change how any
existing plugin/skill works, and this whole directory is disposable if the
eventual platform decision (Cloudflare vs. Azure — see
`06-platform-alternative.md`) points somewhere that doesn't want it in this
form (e.g. C#/Durable Functions would port the *logic*, not this file).

## Run the tests

```
cd graph
npm install
npm test
```

## No magic strings

Every fixed-vocabulary string in this system has exactly one named home,
grouped in `constants/` so anything that only needs the list doesn't have
to pull in the reducer:

- `constants/labels.ts` — `LABELS` / `ALL_LABELS`, the seven tracked GitHub
  labels. Closes a real gap: before this, `graph.ts`'s `State` union and
  `github/from-github.ts`'s webhook-matching `switch` were two
  independently-typed copies of the same spelling, and a `case` value isn't
  checked against any type — nothing would have caught them drifting apart
  on a rename. See `agent-orchestration-plan/10-label-rename.md` for the
  full mapping from today's live label spelling to the proposed one used
  here.
- `constants/routines.ts` — `ROUTINES` / `ALL_ROUTINES`, the five real loop
  skills (`plugins/*/skills/*/SKILL.md`) the reducer can fire. Same category
  of gap as labels: `Rule.run` was a bare `string`, so a typo'd routine name
  would compile cleanly.
- `constants/events.ts` — `EVENTS` / `ALL_EVENTS`, the thirteen domain
  events. Doesn't close a safety gap the way the other two do —
  `translate()` (in `github/from-github.ts`) already declares its return
  type as `Event`, so a typo'd event is already a compile error at the
  return statement. It exists anyway so *every* fixed string is named once,
  not just the ones the type checker happened to leave exposed.

`graph.ts` and both `github/` files import from `constants/` directly,
whichever they need; nothing re-exports them as a convenience shim, so
there's exactly one import path per symbol.

## One outcome shape, two transports

`outcomes.ts` holds the outcome catalog's shape validation
(`parseBuildOutcomeShape`) — the same content as
`plugins/agent-outcomes`'s SKILL.md catalog, kept in code. Both
`github/from-github.ts` (extracting JSON out of a comment body) and
`routines/from-routine.ts` (validating a typed field on a direct signal)
call the same function, so the two transports can't drift into two
different ideas of "a valid `build_succeeded`."

## What's real vs. still a placeholder

- `graph.ts`'s table is derived from the actual behaviour of
  `loop-dispatch` and the five loop skills it fires — see
  `agent-orchestration-plan/09-phase-1-real-graph.md` for the audit.
- `github/from-github.ts` has real cases for `build_succeeded` and
  `build_blocked` now (via `issue-build-loop`'s outcome comment — see
  `agent-orchestration-plan/11-outcome-artifact.md`), plus every case that
  maps cleanly to an existing webhook (label events, a PR closing as
  merged). It deliberately still has **no** case for `release_blocked`,
  `release_published`, `rework_pushed`, or `merge_gate_failed_*` — those
  facts only exist today as an agent's self-report. Same shape of work as
  `build_succeeded`/`build_blocked`, just not done yet.
- `routines/from-routine.ts` is pure logic with nothing calling it *for
  real* — but the mechanism that would call it now exists and is tested:
  `plugins/agent-outcomes/hooks/report-completion.sh`, a `PostToolUse`
  hook that fires automatically and forwards a detected outcome artifact
  to `AGENT_OUTCOMES_ENDPOINT`. Nothing is listening at that endpoint —
  there's no DO/Worker — so the hook logs only. See
  `agent-orchestration-plan/11-outcome-artifact.md`.
- The CI-aggregation helpers in `github/from-github.ts` are stubs — real
  aggregation needs the full check-run list for a SHA (a `github-ops`
  call), not just the one `check_suite` payload that triggered the webhook.
