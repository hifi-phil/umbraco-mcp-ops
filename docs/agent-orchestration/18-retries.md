# 18. Retries: what recovers from what

[← Index](00-index.md)

---

**Status:** Describes the system as of 2.3.1. **Date:** 09-10-2026

The orchestrator has several retry layers. Each covers a different failure;
none of them overlap. This is the map: which failure each one handles, how
they stay out of each other's way, and what still needs a person.

---

## The layers, from the network up

| Layer | Where | What fails | What it does |
|---|---|---|---|
| **Fire call** | `routines-client.ts` | The routines API errors or times out when a run is started | Up to 3 attempts, on a 5xx or a network error. Network level only. |
| **Alarm retry** | Cloudflare, for the DO's `alarm()` | The watchdog's own code throws part-way through an expiry | Cloudflare runs the alarm again. The watchdog clears its pending fire **last**, so a re-run picks up where it failed. |
| **Sweep** | `reconcile.ts`, every few minutes | A trigger label with **no watchdog running**: a fire that never got out, or a watchdog that was lost | Fires the routine again, once per idle stretch (twice its timeout). |
| **Watchdog retry** | `watchdog.ts` | A run that **was** fired and watched, but went silent without ever reporting a step | Fires it once more, with a 🔁 comment. A second silent expiry goes to `ai-stuck`. |
| **Loop caps** | `coordinate/` (CI fixes, review rounds) | The work itself fails: CI is red, the review has findings | Hands it to `rework-loop`, a limited number of times, then `merge-blocked` or `ai-stuck`. |
| **Idempotent steps** | release merge, hand-offs, deliveries | The same event arrives twice | Doing it again is a no-op: a delivery is deduped by its id, a hand-off by its own, a release PR "already merged at the reviewed commit" counts as done. |

The e2e suite's "RETRY 2/2" is something else again: the test driver gives a
failing scenario a second attempt, to absorb GitHub's flakiness. It's test
only, and nothing in the Worker depends on it.

## The watchdog, and its retry

They're one mechanism in two parts:

- **The watchdog is the timer.** When the Worker fires a watched routine it
  starts a countdown (60 minutes for most routines; 2 on the e2e sandbox).
  Each heartbeat from the routine pushes the deadline back; its outcome stops
  it. If the time runs out with nothing heard, the watchdog **expires**: the
  run has gone silent.
- **The retry is one answer to that expiry.** If the run **never reported a
  single step**, it died before doing anything (a session that was refused or
  never started), so a second run can't duplicate its work: it's fired once
  more. If that run is silent too, or the first one **had** reported progress,
  the issue goes to `ai-stuck` for a person: a run that made progress may have
  pushed half its work.

### It relies on heartbeats, so it's per repo

"Never reported a step" only means "never started" if the routines send
steps at all. They do through the `agent-outcomes` hook
(`report-completion.sh`), which runs after every tool call and POSTs the step
to the Worker's `/routine-signal`. `cloud-skill-sync` registers it in the
routines' settings (since 2.3.1), and it sends only when the environment sets
`AGENT_OUTCOMES_ENDPOINT` and `AGENT_OUTCOMES_TOKEN`.

Before that hook was wired in, no real routine ever reported a step, so every
quiet run looked like it had never started, and the retry could have fired a
second run on top of one that had done real work. So the retry is **off
unless a repo turns it on**: `retry: true` in its `WATCHDOG_OVERRIDES_JSON`
entry (tofu), next to `mode` and `minutes`.

| Repo | Retry | Why |
|---|---|---|
| The e2e sandbox | On | Its stub's silent runs really never start; the e2e suite tests the retry |
| umbraco-mcp-ops, and anything else | Off | Until a real run shows heartbeats arriving (the dashboard's *Last step*, or a watchdog comment quoting a step) |

## How they stay out of each other's way

- **The sweep and the watchdog retry never both fire a run.** The sweep acts
  only when no watchdog is running for the item; the retry acts only when one
  is (it is the watchdog). After either fires, the item is watched again, so
  the sweep leaves it alone. Once an item reaches `ai-stuck`, which isn't a
  trigger state, neither touches it.
- **A person's re-added label wins.** It's a new fire: it replaces the
  pending fire and starts clean (no `retried` mark).
- **Every watched fire goes through one helper,** `fireWatched` in
  `coordinate/apply.ts`: a rule's run, the sweep's re-fire and the watchdog's
  retry. It arms the watchdog **before** firing, so a crash between the two
  leaves the watchdog to notice; a refused fire disarms (nothing's running,
  so the sweep can pick the trigger up again) and throws.

## What still needs a person

1. **A run that made progress and then died.** It goes to `ai-stuck` on
   purpose: it may have pushed half its work, and a person decides whether to
   re-add the label.
2. **A webhook GitHub dropped.** GitHub doesn't redeliver automatically
   (e2e #689: it drops any webhook not answered within 10 seconds; the Worker
   answers within 8). The sweep catches a dropped trigger label, but not other
   events. A dropped **outcome comment** shows as a watchdog expiry on a run
   that actually finished; the heartbeat hook's completion signal now covers
   that, by stopping the watchdog when the outcome is posted.
3. **The Worker being down.** Webhooks in that window are lost. The sweep
   recovers trigger labels afterwards; anything else needs a person.
4. **A routine that keeps failing the same way.** Every layer here is
   bounded (3 fire attempts, one retry, capped rework rounds), so a repeating
   failure ends in `ai-stuck` or `merge-blocked` rather than a loop. Finding
   the cause is a person's job.

---

[← Index](00-index.md)
