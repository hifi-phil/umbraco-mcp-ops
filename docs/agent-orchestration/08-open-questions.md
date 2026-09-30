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
- **Why do the loops skip the `agent-outcomes` marker?**
  In [13-shadow-results.md](13-shadow-results.md) the marker appeared in
  only 1 of 6 outcome opportunities: #114's build comment carried it,
  while #116's build comment, both of #118's release comments and #125's
  "PR opened: #126" comment did not, and #127's release closed the issue
  without posting any outcome comment at all. A missing comment is a
  different gap from a comment without a marker. The loops' own label
  swaps are the completion signal today, so nothing breaks, but in Phase 5
  the reducer owns labels and the marker becomes the only self-reported
  signal.
  - **What was seen:** two distinct gaps. Four comments lacked the marker,
    and one release (#127) posted no outcome comment at all. Both are a
    different failure from a marker written but never forwarded by the
    `PostToolUse` hook (hooks in cloud routines are still unconfirmed,
    above). All ran in the same cloud environment, and a session there
    listed `agent-outcomes` among its skills.
  - **Suspects:**
    1. The "only if `agent-outcomes` is available" wording from #108 in
       `issue-build-loop` and `auto-release-loop`, an escape hatch the
       session decides for itself.
    2. The session never reading the `agent-outcomes` skill.
    3. A long session losing the instruction. Weakened: #125's build took
       about 2 minutes and still skipped the marker.
  - **What would tell them apart**, per skipped session's transcript, with
    #114's build as the control: was the skill listed, and was it invoked?
    Did the session reach the outcome step, and did it mention the marker at
    all?
    - Listed but never invoked points to the wording.
    - Not listed points to environment or plugin loading.
    - Invoked early but silent at the step points to long-session loss.
  - **Next transcript to check:** #125's build session, a fresh and short
    one.
  - **Also check:** #127's release session. Did it reach the outcome step at
    all? A session that never got there is a different question from one that
    got there and wrote nothing.
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
  applies to a row the reducer didn't produce. *Narrowed:* the most common
  exit from stuck (re-adding a trigger label, e.g. `auto-rework` on an
  `ai-stuck` PR) is now a real rule in `graph/graph.ts`, not an override.
  The question still stands for relabels no rule covers.
- **Does a late routine's own label removal tolerate a label that's already
  gone?** Once the watchdog has swapped `ready-for-ai` → `ai-stuck`, a slow
  `issue-build-loop` still tries to remove `ready-for-ai` before adding
  `generated-by-ai` and posting its outcome. The Worker's own
  `github-client.ts` treats that 404 as fine, but nobody has checked
  whether the loops' `gh issue edit --remove-label` / GitHub MCP calls do.
  If one aborts on it, the late outcome never arrives and the issue stays
  `ai-stuck` until a human retries it. That's safe, but it isn't the
  intended recovery.
- **Atomic or incremental label rename — deferred, no longer urgent.**
  The text was reverted to the live spelling (28-09-2026, see
  [10-label-rename.md](10-label-rename.md)), so nothing is mismatched
  today. The question returns when the rename is picked up again, after
  the basic lane works: atomic-per-repo is cleaner but has a bigger blast
  radius; incremental means some repos run broken label swaps until
  they're migrated.
- ~~The outcome artifact's reducer rule fires inconsistently~~ — **resolved**:
  `build_succeeded`/`build_blocked`/`release_blocked` are now keyed on their
  post-swap state (`AI_GENERATED`/`AI_BLOCKED`/`"none"`), matching
  `release_published`'s shape, each firing an idempotent `noop` confirm.
  See `graph/graph.ts`'s comments on each rule and `worker/README.md`'s
  "black-box shape" section for how the inconsistency was found.
- ~~**`worker/`'s `coordinateWebhook()` has no shadow-mode toggle.**~~ —
  **resolved** (28-09-2026): `MODE` var, shadow by default, see
  [07-build-phases.md](07-build-phases.md)'s Phase 3 status. **New,
  smaller follow-up:** `MODE` is all-or-nothing, but Phase 4 wants to
  enforce one transition at a time. Decide whether that's a per-event
  allowlist or something else once the shadow run-throughs show which
  transition is cleanest. Original note: it was
  built as Phase 4's real enforcement mechanism (unconditional label
  writes + routine fire), not Phase 3's observe-only one — see
  [07-build-phases.md](07-build-phases.md)'s Phase 3/4 status notes. A
  small, contained addition (skip the write-side `Deps` calls while still
  calling `logTransition`) closes this; not built yet because nothing had
  asked for Phase 3 specifically when this was built.

---

[← Index](00-index.md)
