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

**Status:** done. The real table is audited against this repo's actual
`loop-dispatch` and loop skills; see
[09-phase-1-real-graph.md](09-phase-1-real-graph.md). All five loops are
covered, and the two shadow runs (Phase 3) folded their gaps back in.

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
and let it enforce nothing. Fire still happens exactly as it does today. Do
a couple of real run-throughs of the basic lane (Build → Review → Integrate
→ Release) and compare. A week of passive traffic isn't needed at our
volume (decided 28-09-2026):

- How often does the current system fire when the table says it shouldn't?
- How often does an event arrive that the table has no rule for?

**Exit:** Two numbers exist. The first is our real failure rate. The second
is the list of rules missing from the table — feed it back into Phase 1
before moving on. This also produces the first real data for the
per-state staleness thresholds the reconciliation sweep needs in Phase 7.

**Status:** the vehicle is built. `worker/` has a `MODE` var, which is
`"shadow"` in `wrangler.toml`, and anything other than the exact string
`"enforce"` means shadow. In shadow mode the Worker runs the same
translate → reduce path and logs to D1 (each row tagged with its `mode`),
but `shadowDeps()` turns every GitHub or routines write into a no-op. The
watchdog still arms, so an expiry logs a `watchdog_expired` row. That
shows how often the routine the existing dispatch fired never reported
back. See `worker/README.md`'s "Shadow mode" section for the two queries
that produce this phase's numbers.

**Run 1 done (29-09-2026)**, deployed on a personal Cloudflare account
against `umbraco-mcp-ops`. Number 1 was **0** (every trigger fire matched
the table). Number 2 found **5 gaps**, now folded back into the table. The
biggest: the outcome comment appeared only 1 time in 4, so the loop's own
label swap is now the completion signal. Full results:
[13-shadow-results.md](13-shadow-results.md).

**Run 2 (29-09-2026): 0 and 0.** One real issue through all five loops.
Every fix confirmed, with no gaps and no false watchdog alarms. **Phase 3
is done.** Two prerequisites for Phase 4 came out of it (see below).

## Phase 4 — Enforce

**Entry:** Phase 3 numbers reviewed, gaps folded back into the table.

**Do:** Turn on dropping. Start with the transitions shadow mode showed as
cleanest, not with everything at once.

**Exit:** At least one transition is enforced in production with no
regressions observed for a full cycle of that transition.

**Decision (30-09-2026): enforce the whole lane at once, not one
transition at a time.** Both shadow runs were clean (0 wrong fires, 0 gaps
after #123). While the loops still swap their own labels, enforcing mostly
means the Worker takes over firing; the other enforced writes are removals
and closes the loops already do. The one genuinely new behaviour is the
watchdog, so that keeps its own switch until its timeouts are proven.

**Status:** the mechanism is in place.
- `MODE=enforce`: the Worker fires each repo's loop-dispatch routine
  (`REPO_ROUTINES_JSON`, exactly as the edge does) and applies label
  writes. `WATCHDOG` is separate and defaults to shadow. Each D1 row
  records its own mode.
- Switching a repo over is a clean break: its loop-dispatch caller workflow
  is deleted, so the Worker is its only dispatcher (`umbraco-mcp-ops`
  first). The shared reusable workflow and `route-event.sh` stay until the
  other repos have moved, then go in one cleanup.

The procedure and switch order are in `worker/README.md`'s "Enforcing".
The self-trigger guard didn't block this: at the time the table never added
a trigger label, so the Worker's own writes (removals, `ai-stuck`) came back
as no-ops. Phase 5's CI-fix cycle changed that: it adds `auto-reworking` and
`auto-merging`, and relies on those writes echoing back to fire the loops. So
the guard (Phase 7) has to come with a `run` on those two rules; see
`worker/README.md`'s known gaps. The GitHub App (a separate identity) is still wanted for Phase 5,
multiple orgs, and the Checks permission.

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
| `issue-build-loop` Step 3 (success) | remove `ai-ready`, add `pr-open` | the DO applies `to-github.ts`'s `labelOps()` output for `build_succeeded` itself, shadow-mode-verified against real traffic |
| `issue-build-loop` Step 3 (blocked) | remove `ai-ready`, add `ai-blocked` | same, for `build_blocked` |
| `auto-release-loop` Step 2.5 | remove `auto-releasing` on BLOCK | same, for `release_blocked` |
| `auto-release-loop` Step 4 | close the issue on publish | same, for `release_published` |
| `rework-loop` Step 5 | remove `auto-reworking` | same, for `rework_pushed` — already sourced from a native signal, so this one only needs the DO live, not a new artifact |
| `merge-flow` Step 4 (hard block) | remove `auto-merging` | same, for `merge_gate_failed_hard` — the live gate re-check this event needs now exists for real (`worker/src/coordinate/webhook.ts`'s `handleCheckSuiteCompleted` + `graph/github/merge-gate.ts`, see 11-outcome-artifact.md and `worker/README.md`), so this row now only needs the DO live and shadow-verified, same bar as every other row — no longer blocked on infrastructure that doesn't exist |

**Exit:** Every row above deleted, one at a time as its precondition
clears — not "removed everywhere" as a single cutover, and never left
half-done indefinitely: each row that's shadow-verified gets its self-swap
deleted in the same change that turns on enforcement for it, not
sometime after. The missing-label symptom is gone by construction, not
mitigated, once the table is empty.

**Status (30-09-2026): built as "orchestrated mode".** The skills are shared
with repos not yet on the Worker, so the self-swaps can't simply be deleted.
Instead the Worker's fire text carries `orchestrated=true`, `loop-dispatch`
passes it on, and each loop skips its own swap only in that mode:

| Row | In orchestrated mode |
|---|---|
| build success / blocked | loop posts the **required** marker, no swap; Worker swaps via new pre-swap rules (`ai-ready` + `build_*`) |
| release blocked | loop posts the required marker, keeps the label; Worker removes `auto-releasing` |
| release published | unchanged: the loop's close is itself native, and the marker is required too |
| rework pushed | loop doesn't remove `auto-reworking` after a push; Worker does on the native push. Still removes it itself if it pushed nothing |
| merge hard block | the **Worker** checks for a conflict or requested changes when `auto-merging` is added (reviews aren't expected after that) and whenever CI finishes, swaps `auto-merging` → **`merge-blocked`** and comments the reason, without firing merge-flow. Re-adding `auto-merging` retries. merge-flow makes the same swap only for a block the Worker missed |
| merge CI failure | when CI is red under `auto-merging` (at label time or when a suite finishes), the **Worker** swaps `auto-merging` → **`auto-reworking`** and comments the failing checks; rework-loop fixes them, and its push swaps `auto-reworking` back to `auto-merging`, which re-runs the gate. After 3 attempts on one PR it goes to `merge-blocked` |

The risk this moves: an orchestrated loop that skips the marker now leaves
the issue in its trigger label (the marker appeared 1 in 6 times while it
was optional; see 08's open question). The watchdog, still in shadow, logs
it. Validated end to end in the UI: see 13-shadow-results.md.

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

**Status (01-10-2026):**
- **Built.** The alarm on fire, cancelling it on an outcome, expiry →
  `ai-stuck` with a comment, the heartbeat route (`/routine-signal`:
  `process` extends the alarm and records the step; `completion` cancels
  it), and per-routine timeouts. Expiries only log until `WATCHDOG=enforce`.
- **Proven live** on the e2e sandbox, which has a real 2-minute watchdog:
  expiry, a heartbeat quoted in the expiry, a completion signal cancelling
  it, and late outcomes or retries out of `ai-stuck` from every watched
  state (14-e2e-testing.md).
- **Timeouts set from data.** These come from `umbraco-mcp-ops`'s D1 log
  (`worker/queries/routine-durations.sql`): build 60 min, release 60,
  rework and merge-flow 30. The slowest real runs were 23, 7, 2.4 and 3.3
  minutes. The four shadow expiries:
  - two were run-1 issues, both since fixed: one false alarm (#116), and
    one release that really did run long (#118)
  - one was a real stall: a merge-flow left on `auto-merging` before
    `merge-blocked` existed (#138)
  - one fire never got anything back (#139)
- **Turning it on** for `umbraco-mcp-ops` is `watchdog = "enforce"` in tofu.
- **The real routines' heartbeats.** The `agent-outcomes` hook (every
  loop has it) now signals `/routine-signal` from any session the Worker
  fired:
  - a heartbeat naming the step, at most once a minute, which extends the
    watchdog and gets quoted by an expiry
  - a completion when the loop posts its outcome

  It finds the run from the fire text in the session's transcript. Tested
  in the hook's own suite and live by two e2e scenarios, which run the real
  hook against the real Worker. It's live once the routine environment
  sets `AGENT_OUTCOMES_ENDPOINT` and `AGENT_OUTCOMES_TOKEN`.
  - **Heartbeats change what times out:** a run now expires only after a
    whole timeout with no tool calls, so a dead session, not a slow one.
    A run that stays busy but never finishes won't expire. That's Phase
    9's rework cap.

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

**Status (02-10-2026):**
- **The self-trigger guard** shipped with the GitHub App (#181).
- **`manual_override`** shipped in #193. It's logged straight away, when a
  person's change arrives, not on the next webhook: the App makes the
  Worker's own changes recognisable.
- **The reconciliation sweep is built**, as a **Scheduler Durable Object
  alarm**, not a Cron Trigger. Alarms are retried; cron triggers can stop
  without anyone knowing.
  - Every 15 minutes, while anything is in a trigger state, it asks each
    such issue whether it was left behind: no watchdog, and idle for twice
    its routine's timeout. If so, it re-fires the routine and logs
    `reconcile_refire`.
  - When nothing live is left to watch it slows to hourly (never stops, so
    a lost webhook is still caught), and the next webhook speeds it up.
  - Real repos sweep in **shadow**, logging only, until `sweep_mode` is set
    to `enforce`. The sandbox enforces.
  - It's the base for scheduled agents later.

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

**Status (02-10-2026):**
- **Built:** the `issue_status` table and `GET /status`, a read-only page
  styled to the Umbraco Cloud Portal design system, behind "Sign in with
  GitHub" for verified `@umbraco.com` / `@umbraco.dk` emails. Each issue's DO upserts its row on
  enforced transitions, sweep re-fires, heartbeats and completions, and
  deletes it when the issue closes. The worker README's "The live-status
  dashboard" has the detail.
- **Shadow repos show nothing:** only enforced events write it, since a
  shadow event's labels never moved.
- **Also on the dashboard:** one list of every issue and PR the Worker
  has logged, filtered by pills (type, status, repo), with the selected
  one's D1 transition log beside it, and per-repo controls (`repo_controls`),
  starting with switching a repo's sweep off: the start of turning agents
  on and off per repo, as the target graph needs.

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

**Status (04-10-2026):**
- **Rework cap: built.** CI-fix reworks were already capped
  (`MAX_CI_FIX_ATTEMPTS`, 3, then `merge-blocked`). Review rework rounds
  (`auto-reworking` added by a reviewer, person or bot) are now counted per
  PR: past `MAX_REVIEW_REWORKS` (3) the next goes to `ai-stuck`
  (`rework_cap_reached`) with a comment, firing nothing. A person re-adding
  `auto-reworking` from `ai-stuck` retries with a fresh count.
- **Record-then-fire: built.** The watchdog is armed before the fire, on
  the webhook path and the sweep's re-fire alike, so a crash between them
  leaves the watchdog to notice. A fire that's refused (an error, not a
  crash) disarms and fails, as before: nothing is running, and the sweep
  re-fires a trigger left with nothing watching it.
- **Concurrency cap and ready queue: deferred until there are several
  users.** With one person labelling, every burst is one they started and
  can see; nothing has stalled or collided so far. Adding it later is cheap:
  every fire goes through the one arm-then-fire step (`coordinate/apply.ts`,
  `coordinate/reconcile.ts`), and `transitions` already records each fire,
  so peak in-flight per repo can be read back when it's needed. The design
  agreed for then is in [08-open-questions.md](08-open-questions.md).

## Phase 10 — Split nodes that still fail too often

**Entry:** Phases 1–9 live, with real per-node failure/timeout data from the
watchdog and the D1 log.

**Do:** Split only the specific node the data points at — a validation gate
or a state worth seeing on the board, not a general refactor. Remember
splitting costs more agent context, not less (see
[05-technical-elements.md](05-technical-elements.md)).

**Exit:** N/A — this phase repeats as needed, driven by data rather than a
schedule.

**Status (04-10-2026):** the first two splits are designed: build/review
and release, in [15-agent-splits.md](15-agent-splits.md). They come from
long sessions losing context and a review that isn't independent, rather
than failure data. Build/review goes first, in the sandbox.
- **Build/review, graph and Worker: built.** `ai-reviewing` and its CI gate,
  `review-loop`'s three outcomes, the push back to `ai-reviewing`, and the
  review's own round cap (`MAX_BOT_REVIEW_REWORKS`), counted apart from a
  person's. Tested with the e2e stub; dormant on real repos until the
  skills change (nothing adds `ai-reviewing` there yet).
- **Still to build:** the decision and build logs, the skills, and what
  people see.

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
