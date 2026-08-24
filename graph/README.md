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
