# graph/ — Phase 1/2 prototype

Pure logic only, per the build order in the design doc
(`agent-orchestration-plan/07-build-phases.md`): the transition table
(`graph.ts`) and the webhook-to-domain-event translator (`translate.ts`),
each with fixture tests. No Worker, no Durable Object, no D1 — none of that
exists yet, and nothing here talks to GitHub for real.

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
  `translate.ts`'s webhook-matching `switch` were two independently-typed
  copies of the same spelling, and a `case` value isn't checked against
  any type — nothing would have caught them drifting apart on a rename.
  See `agent-orchestration-plan/10-label-rename.md` for the full mapping
  from today's live label spelling to the proposed one used here.
- `constants/routines.ts` — `ROUTINES` / `ALL_ROUTINES`, the five real loop
  skills (`plugins/*/skills/*/SKILL.md`) the reducer can fire. Same category
  of gap as labels: `Rule.run` was a bare `string`, so a typo'd routine name
  would compile cleanly.
- `constants/events.ts` — `EVENTS` / `ALL_EVENTS`, the thirteen domain
  events. Doesn't close a safety gap the way the other two do —
  `translate()` already declares its return type as `Event`, so a typo'd
  event is already a compile error at the return statement. It exists
  anyway so *every* fixed string is named once, not just the ones the type
  checker happened to leave exposed.

`graph.ts` and `translate.ts` import all three directly from `constants/`;
nothing re-exports them as a convenience shim, so there's exactly one
import path per symbol.

## What's real vs. still a placeholder

- `graph.ts`'s table is derived from the actual behaviour of
  `loop-dispatch` and the five loop skills it fires — see
  `agent-orchestration-plan/09-phase-1-real-graph.md` for the audit.
- `translate.ts` implements every case that maps cleanly to an existing
  webhook (label events, a PR closing as merged). It deliberately has **no**
  case for `build_succeeded`, `build_blocked`, `release_blocked`,
  `release_published`, `rework_pushed`, or `merge_gate_failed_*` — those
  facts only exist today as an agent's self-report. Defining the structured
  outcome artifact each loop should write instead, and adding the
  `translate()` case that reads it, is Phase 5, not this prototype.
- The CI-aggregation helpers in `translate.ts` are stubs — real aggregation
  needs the full check-run list for a SHA (a `github-ops` call), not just
  the one `check_suite` payload that triggered the webhook.
