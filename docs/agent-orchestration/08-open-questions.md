# 8. Open questions

[← Previous: Build phases](07-build-phases.md) | [Index](00-index.md)

---

## Carried over from the original draft

- What's doing the GitHub → fire call today, and does the DO sit in front of
  it or replace it?
- Does anything currently record that a routine was fired for an issue, or is
  it fire-and-forget? Determines how much of shadow mode (Phase 3) can be
  reconstructed from history rather than waiting a week.
- Which GitHub events reach the dispatch layer today? If CI check events
  aren't arriving at all, that's a different fix than a missing guard — and
  it's the same underlying question the reconciliation sweep (Phase 7) exists
  to catch regardless of which cause it turns out to be.
- Which nodes are real code changes and which are bookkeeping — triage,
  labelling, release notes? The bookkeeping ones are probably cheaper as
  plain Actions than as routines.
- What's the right in-flight concurrency cap, and does the ready queue live
  in the DO or in a separate coordinator? (Phase 9.)
- Cloudflare or Azure? Decide on maintainership rather than capability — see
  [06-platform-alternative.md](06-platform-alternative.md).

## Resolved by this pass (design decided, not yet validated)

- ~~What owns the question "was this transition rule correct?"~~ — Partially
  answered: the D1 log plus `verifiedBy` tagging is the input. The loop that
  actually revises the table from that data still doesn't exist — this is
  now a Phase 10+ question, not an unowned one.
- ~~How do raw webhooks become domain events?~~ — Answered by
  [03-components.md §3.0](03-components.md#30-the-event-translator-new). Not
  yet validated against real payloads.
- ~~Does the DO's own label write cause a feedback loop?~~ — Answered: the
  self-trigger guard in `translate()` drops events from our own bot identity.
  Needs confirming that the GitHub App's `sender.login` is stable and
  distinguishable from any human acting through the same App installation.

## New from this pass

- ~~**Can a routine make an arbitrary outbound HTTP call mid-session?**~~ —
  Resolved for the *mechanism*: not the model calling out mid-turn, but a
  `PostToolUse` hook — a deterministic script the harness fires after every
  tool call, outside the model's own action space entirely. Confirmed
  working locally in
  [`plugins/agent-outcomes/hooks/report-completion.sh`](https://github.com/hifi-phil/umbraco-mcp-ops/tree/main/plugins/agent-outcomes/hooks)
  (real `curl` POST, tested against a local stub server). Same mechanism
  the progress heartbeat
  ([03-components.md §3.4](03-components.md#34-the-serialiser-and-watchdog--durable-object-per-issue))
  needs, and what
  [11-outcome-artifact.md](11-outcome-artifact.md)'s fast-path completion
  ping now uses. **Still open:** whether hooks fire the same way in a
  *cloud* routine as they do locally — `self-learning`'s existing
  SubagentStop/SessionEnd hooks are the closest precedent that they do, but
  that's not the same event type, and this hasn't been confirmed against a
  real cloud routine run.
- **How is the heartbeat endpoint authenticated per attempt?** It needs a
  short-lived, narrowly-scoped credential (write-a-step-name only, nothing
  else) threaded into the routine's invocation — worth deciding whether
  that's a signed URL, a per-attempt token, or something the routines API
  already gives us.
- **How much detail should a heartbeat step carry?** A step name is the
  minimum; whether it's worth a short reason string (e.g. "3rd test rerun
  failed") depends on how noisy that gets in practice.
- **Who can see the dashboard, and does it need auth?** It surfaces internal
  working state (which issue, which routine, which step) rather than
  anything customer-facing, but "internal-only, unauthenticated Worker URL"
  is still a choice someone should make on purpose rather than by default.
- **Does "live" ever need to mean push, not poll-on-load?** Phase 8 assumes
  refresh-on-load is enough at our volume. Worth revisiting only if someone
  actually wants to watch a single issue in real time rather than check the
  board occasionally.

- **Does `review_approved` ever come from an agent, or only a human?** This
  changes whether that transition is `deterministic` or `external-judgment`
  in the table (see [02-design-principles.md](02-design-principles.md)). If
  it's sometimes an agent, do we want a stronger signal for merge-worthiness
  than a single agent's approval?
- **What are the real per-state staleness thresholds for the reconciliation
  sweep?** Phase 3's shadow-mode data should answer this, but until then the
  numbers in [05-technical-elements.md](05-technical-elements.md) are
  guesses.
- **Is 3 the right rework-cycle cap?** Same answer — a placeholder pending
  Phase 3/9 data, not a considered number yet.
- **Where does the synthetic `manual_override` log entry get its `from`
  state?** If a human relabels an issue that was previously `state:stuck`
  straight to `state:rework`, the log needs to record that jump even though
  no rule in the table permits it — worth deciding whether `verifiedBy` even
  applies to a row the reducer didn't produce.
- **Atomic or incremental label rename — now urgent, not hypothetical.**
  See [10-label-rename.md](10-label-rename.md) — the 14 referencing skill
  files are already migrated to the new spelling (surfaced and fixed via
  `worker/`'s real-agent test), but no live repo's actual label and no
  routine's trigger config are. Until the remaining two land, coordinated,
  per repo, a real loop run on a real repo will fail to clear its own
  trigger label. Atomic-per-repo is cleaner but higher-blast-radius;
  incremental means accepting broken label swaps on every not-yet-migrated
  repo, not just an inconsistent routing table.
- ~~The outcome artifact's reducer rule fires inconsistently~~ — **resolved**:
  `build_succeeded`/`build_blocked`/`release_blocked` are now keyed on their
  post-swap state (`AI_GENERATED`/`AI_BLOCKED`/`"none"`), matching
  `release_published`'s shape, each firing an idempotent `noop` confirm.
  See `graph/graph.ts`'s comments on each rule and `worker/README.md`'s
  "black-box shape" section for how the inconsistency was found.
- **`worker/`'s `coordinateWebhook()` has no shadow-mode toggle.** It was
  built as Phase 4's real enforcement mechanism (unconditional label
  writes + routine fire), not Phase 3's observe-only one — see
  [07-build-phases.md](07-build-phases.md)'s Phase 3/4 status notes. A
  small, contained addition (skip the write-side `Deps` calls while still
  calling `logTransition`) closes this; not built yet because nothing had
  asked for Phase 3 specifically when this was built.

---

[← Index](00-index.md)
