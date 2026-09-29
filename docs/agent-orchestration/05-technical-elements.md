# 5. Technical elements

[← Previous: Architecture](04-architecture.md) | [Index](00-index.md) | [Next: Platform alternative →](06-platform-alternative.md)

---

## Cloudflare

(See [06-platform-alternative.md](06-platform-alternative.md) for the Azure
option.)

| Component | Service | Why |
|---|---|---|
| Webhook receiver | Workers | HTTP entry point, signature verification, routing |
| Event translation | Workers (same request) | Pure function, no need for its own service |
| Per-issue serialisation | Durable Objects | Single-threaded execution per key. Nothing else on the platform gives this |
| Watchdog timers | DO Alarms | Per-issue precision. A cron sweep is coarse and scans everything |
| Transition log | D1 | SQL for after-the-fact questions |
| Current-status view + dashboard | D1 (separate table) + Workers | One row per open issue, upserted not appended — a live board, distinct from the append-only log |
| Secrets | Worker secrets | Claude API key, GitHub webhook secret, GitHub App credentials |

**Cost.** The Workers Paid plan is $5/month minimum and includes 1M DO
requests and 400K GB-seconds. At ~50 issues a month with ~20 events each, we
use around 1,000 DO requests. D1's free tier alone covers 3M row writes. So
$5/month, and that's the plan floor rather than our usage. Each `setAlarm()`
bills as one row written — negligible at our volume.

The real cost is agent sessions, with a design consequence: **splitting into
more nodes costs more, not less.** One agent doing spec → build → test loads
context once. Five nodes load it five times, each starting cold. Split where
we need a validation gate or a state worth seeing on the board — not because
it feels tidier.

## Claude Code routines

We already fire via the API endpoint, which is the right pattern — the
reducer becomes the only thing allowed to make that call:

```ts
await fetch(`https://api.claude.com/routines/${routineId}`, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${env.CLAUDE_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    additional_context: `Issue #412. Branch feat/412. Tests passed. Do the review.`,
  }),
});
```

What changes is not the call, it's that a transition has to be legal before
the call happens. Nothing else in the system gets to fire a routine.

Keep dispatch behind a thin interface — routines are in research preview and
the API surface may change.

## Constraints to design around

**Dropped events are silent stalls, and now there's a concrete fix.** Events
over the per-account hourly cap are dropped. A dropped fire means an issue
sits forever with nothing coming. The reconciliation sweep:

- Runs on a schedule (start at every 15 minutes; tune once real data exists).
- Reads D1 for the last transition per open issue.
- Flags anything where `now - last_transition_at` exceeds a per-state
  threshold (a config map, e.g. `building: 2h`, `review: 24h` — these are
  guesses until Phase 3's shadow-mode data gives real numbers).
- For each flagged issue, re-reads the label from GitHub directly (never
  trusts D1 for current state — D1 says what *should* have happened, GitHub
  says what *did*) and re-fires the translate → reduce path as if the
  relevant event had just arrived.
- This is the one place D1 is read to influence behaviour, which is a
  deliberate exception to "append-only, never read to decide" in
  [03-components.md §3.5](03-components.md#35-the-log--d1) — call it out
  explicitly rather than let the two statements quietly contradict each
  other.
- This is also the fallback for the CI wake-up symptom if it turns out to be
  caps rather than guard logic (see [08-open-questions.md](08-open-questions.md)).

**No idempotency key on fire.** One GitHub event can spawn multiple sessions.
The DO owns dedup, but the ordering of the two writes matters:

- **Record-then-fire**, not fire-then-record. Write "firing node X for issue
  Y at transition Z, delivery ID W" to D1 (or DO storage) *before* the POST
  to the routines API.
- If the DO dies between the record and the POST, the alarm fires at the
  30-minute mark, sees a recorded fire with no outcome, and treats it exactly
  like a dead agent — starts attempt 2. Slightly wasteful (an extra recorded
  row for a routine that never actually started) but never silent, which is
  the property that matters.
- Dedupe incoming webhooks on delivery ID regardless — this handles GitHub's
  own at-least-once redelivery, which is a separate problem from the
  crash-in-the-middle case above.

**Sessions don't share context.** Each run is independent — which is what we
want, but everything a node needs must be reconstructible from the issue and
the outcome payload. No implicit carry-over.

**No way to nudge a running session.** If a routine goes quiet we can't wake
it, only start a fresh one. So the timer means: give up on that run, start a
new one with everything we know, including "this is attempt 2." Outcomes
still have to be written to GitHub as work progresses, not held in the
agent's head — that's unchanged and non-negotiable (3.0/3.2). Separately, a
best-effort progress heartbeat straight to the DO (not GitHub) means a dead
run leaves behind *which* step it died on, not just that it died. See
[03-components.md §3.4](03-components.md#34-the-serialiser-and-watchdog--durable-object-per-issue)
for why that channel is allowed to be a direct callback when the outcome
channel isn't.

**Cycles need budgets.** Rework → building → rework will run forever given
the chance. Default: **3 rework cycles per issue**, tracked in the DO's
rework counter (3.4). On the 4th, route to `state:stuck` instead of firing
again, and post a comment tagging a human — don't rely on someone noticing
the label. Revisit the number once Phase 3's shadow data shows the real
distribution; 3 is a starting guess, not a measured value. Also worth a
global in-flight limit with a ready queue — easier to add now than to
retrofit while debugging why three issues stalled overnight (open question:
where does the queue live — see [08-open-questions.md](08-open-questions.md)).

## What we give up versus gh-aw

`github/gh-aw` buffers agent writes, validates them, and applies them in a
separate job with scoped permissions — the agent/effect separation enforced
architecturally. Routines commit and open PRs as us, so we rebuild that
discipline by convention: routines write outcomes to a structured artifact
(fenced JSON in a comment, or check-run output), and only the reducer mutates
`state:*` labels.

Weaker than architectural enforcement. Worth knowing what we're trading for
staying on routines.

---

[Next: 06 — Platform alternative →](06-platform-alternative.md)
