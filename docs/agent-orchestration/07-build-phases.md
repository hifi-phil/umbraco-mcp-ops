# 7. Build phases

[← Previous: Platform alternative](06-platform-alternative.md) | [Index](00-index.md) | [Next: Open questions →](08-open-questions.md)

---

Because something already works, the first move is measurement rather than
change. Each phase below has an entry condition (what must be true to start
it) and an exit condition (what must be true to call it done and move on).
Phases 1–3 are most of the value. Splitting nodes (Phase 10) is deliberately
last: granularity is currently a hunch, and Phase 6 is what tells us which
node is actually the problem.

## Phase 1 — Derive the table and the event mapping

**Entry:** Nothing — this is the starting point.

**Do:**
- Write down the graph as the current system actually behaves, not as we'd
  like it to. Every state, every event, what fires.
- Write `translate()` alongside it — you cannot write `on: "checks_passed"`
  in the table until you've decided the exact aggregation rule (all required
  check-runs for the SHA, not the first one to report) that produces that
  event. See [03-components.md §3.0](03-components.md#30-the-event-translator-new).
- Mark each rule `verifiedBy: deterministic | external-judgment` per
  [02-design-principles.md](02-design-principles.md).

**Exit:** `graph.ts` and `github/from-github.ts` exist as reviewable files. No code
runs against production yet.

**Status:** started — see [09-phase-1-real-graph.md](09-phase-1-real-graph.md)
for the real table audited against this repo's actual `loop-dispatch` and
loop skills. Two loops (`auto-release-loop`, `issue-discuss-loop`) still need
the same scrutiny before this phase is complete.

## Phase 2 — Test it

**Entry:** Phase 1 files exist.

**Do:** Table of `(state, event) → expected` for the reducer. Fixture
payloads → expected domain event (or `null`) for the translator. No
infrastructure.

**Exit:** Both pure functions have test coverage a reviewer can read as the
spec.

## Phase 3 — Shadow mode

**Entry:** Phase 2 passing.

**Do:** Put `translate()` → `reduce()` in the path, have it log its decision,
and let it enforce nothing. Fire still happens exactly as it does today. Run
for a week and compare:

- How often does the current system fire when the table says it shouldn't?
- How often does an event arrive that the table has no rule for?

**Exit:** Two numbers exist. The first is our real failure rate. The second
is the list of rules missing from the table — feed it back into Phase 1
before moving on. This also produces the first real data for the
per-state staleness thresholds the reconciliation sweep needs in Phase 7.

**Status:** `worker/` exists now — a Cloudflare Worker + Durable Object
that actually calls `translate()`/`reduce()` against real `graph/` code,
with a real D1 transition log. Unit tested (40 tests) and smoke-tested
locally end to end via `wrangler dev --local` against a stub API server
(see `worker/README.md`) — never deployed, no Cloudflare account access
exists for this repo.

**It's not actually a Phase 3 vehicle as built — it's Phase 4's.**
`coordinateWebhook()` performs real label writes and fires the routine
unconditionally whenever a rule matches; there's no dry-run/observe-only
mode. Deploying it as-is today, alongside loops that still self-swap,
would mean two systems writing labels at once — the opposite of safe
shadow mode. Before this can run Phase 3 for real, it needs a shadow-mode
toggle: log the decision (already happens, via `logTransition`) but skip
`addLabel`/`removeLabel`/`closeIssue`/`fireRoutine` while it's on. Not
built yet — a small, contained change once wanted, not a redesign.

## Phase 4 — Enforce

**Entry:** Phase 3 numbers reviewed, gaps folded back into the table.

**Do:** Turn on dropping. Start with the transitions shadow mode showed as
cleanest, not with everything at once.

**Exit:** At least one transition is enforced in production with no
regressions observed for a full cycle of that transition.

**Status:** the actual enforcement mechanism is what `worker/` already
is — `coordinateWebhook()` unconditionally applies `labelOps()` and fires
the routine when a rule matches, real writes, no toggle. What's missing
isn't the mechanism, it's everything around safely turning it on: real
deployment, a shadow-mode pass first (see Phase 3's status above) to
confirm the table's accurate against real traffic before this starts
writing labels for real, and picking which transition graduates first.

## Phase 5 — Reducer owns labels

**Entry:** Phase 4 stable on the transitions covered so far.

**Do:** Remove label-setting from agent prompts entirely — but per
transition, not all at once, and only once its own precondition holds.
"Additive, not a replacement" (11-outcome-artifact.md) was always meant to
be temporary scaffolding, not the destination — deleting a self-swap
before its replacement is live would strand every issue mid-flight with
nothing to pick up the slack, which is worse than the symptom this phase
exists to fix. Every self-swap in the system today, and exactly what has
to be true before it's deleted:

| Loop / step | Self-swap today | Deletable once |
|---|---|---|
| `issue-build-loop` Step 3 (success) | remove `ready-for-ai`, add `generated-by-ai` | the DO applies `to-github.ts`'s `labelOps()` output for `build_succeeded` itself, shadow-mode-verified against real traffic |
| `issue-build-loop` Step 3 (blocked) | remove `ready-for-ai`, add `ai-blocked` | same, for `build_blocked` |
| `auto-release-loop` Step 2.5 | remove `auto-release` on BLOCK | same, for `release_blocked` |
| `auto-release-loop` Step 4 | close the issue on publish | same, for `release_published` |
| `rework-loop` Step 5 | remove `auto-rework` | same, for `rework_pushed` — already sourced from a native signal, so this one only needs the DO live, not a new artifact |
| `merge-flow` Step 4 (hard block) | remove `auto-merge` | the live gate re-check this event actually needs exists (see the `merge_gate_failed_*` note in 11-outcome-artifact.md) — furthest from ready, since that infrastructure doesn't exist yet at all |

**Exit:** Every row above deleted, one at a time as its precondition
clears — not "removed everywhere" as a single cutover, and never left
half-done indefinitely: each row that's shadow-verified gets its self-swap
deleted in the same change that turns on enforcement for it, not
sometime after. The missing-label symptom is gone by construction, not
mitigated, once the table is empty.

## Phase 6 — Watchdog timer

**Entry:** Phase 5 done (no point watching for death while agents can still
race to set labels themselves).

**Do:**
- DO sets a 30-minute alarm on fire, cancels it on outcome, moves to
  `state:stuck` on expiry.
- Add the heartbeat endpoint: a Worker route the routine POSTs a step name
  to, routed to the DO by issue ID, stored as `lastStep`/`lastStepAt` in DO
  storage — see [03-components.md §3.4](03-components.md#34-the-serialiser-and-watchdog--durable-object-per-issue).
  This is what lets the `state:stuck` comment say *what* the routine was
  doing, not just that it timed out.

**Exit:** A killed/dead session becomes a visible, automatic `state:stuck`
within 30 minutes, quoting its last known step, not an invisible stall.

## Phase 7 — Full logging and reconciliation

**Entry:** Phase 6 live (Phase 3's shadow logging may already satisfy most of
this — check before building it twice).

**Do:**
- Formalize the D1 transition log if shadow-mode logging hasn't already
  become it.
- Add the self-trigger guard to `translate()` (own-bot label writes never
  become domain events) — see
  [03-components.md §3.3](03-components.md#33-state--github-labels).
- Add the synthetic `manual_override` log entry for human label edits that
  bypassed the reducer.
- Build the reconciliation sweep described in
  [05-technical-elements.md](05-technical-elements.md) using the per-state
  staleness thresholds Phase 3 gave real data for.

**Exit:** The transition log is a complete history (including human
overrides), and a stale issue gets automatically re-fired instead of sitting
forever.

## Phase 8 — Live-status view and dashboard

**Entry:** Phase 6 live (heartbeat data exists) and Phase 7 live (the
transition log is the historical complement to it).

**Do:**
- Add the current-status table (D1, separate from the transition log) —
  upserted, not appended, one row per open issue — per
  [03-components.md §3.6](03-components.md#36-the-live-status-view-and-dashboard-new).
- DO writes to it on every state transition and every heartbeat, as a side
  effect only — nothing reads it back to decide anything.
- Build the thin read-only dashboard on top: a Worker route rendering the
  table, refreshed on load. No websockets/push infra at our volume.

**Exit:** One place shows every open issue's current state, current routine
and attempt, and last-known step, without querying GitHub or a DO directly.

## Phase 9 — Harden against loss and loops

**Entry:** Phase 8 live.

**Do:**
- Rework cap: default 3 cycles per issue, then `state:stuck` with a human
  ping, per [05-technical-elements.md](05-technical-elements.md). Tune the
  default from real data once available.
- Record-then-fire ordering for the routines POST, so a DO crash mid-fire is
  caught by the watchdog instead of silently losing the attempt.
- Decide the in-flight concurrency cap and where the ready queue lives (DO or
  separate coordinator) — see [08-open-questions.md](08-open-questions.md).

**Exit:** A pathological rework loop terminates in a human hand-off instead
of running forever, and a crash between "decided to fire" and "actually
fired" is never silent.

## Phase 10 — Split nodes that still fail too often

**Entry:** Phases 1–9 live, with real per-node failure/timeout data from the
watchdog and the D1 log.

**Do:** Split only the specific node the data points at — a validation gate
or a state worth seeing on the board, not a general refactor. Remember
splitting costs more agent context, not less (see
[05-technical-elements.md](05-technical-elements.md)).

**Exit:** N/A — this phase repeats as needed, driven by data rather than a
schedule.

## Note on infrastructure timing

The Durable Object can be deferred if it's adding conceptual load early —
compare-and-swap in a D1 transaction plus a cron sweep for the watchdog is
slightly worse on collision-safety and timer precision, but is one fewer
concept, and nothing in Phases 1–3 changes either way. The dashboard (Phase
8) still works in that world — it just reads whatever table the watchdog
sweep is already writing to instead of DO storage. Platform choice
(Cloudflare vs. Azure, [06-platform-alternative.md](06-platform-alternative.md))
can also wait — shadow mode runs fine as a plain GitHub Action before either
is picked.

---

[Next: 08 — Open questions →](08-open-questions.md)
