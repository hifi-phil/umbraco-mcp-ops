# 3. The parts

[← Previous: Design principles](02-design-principles.md) | [Index](00-index.md) | [Next: Architecture →](04-architecture.md)

---

Seven pieces now, not five. The event-translation layer and the live-status
view were both missing from the original cut — every other piece assumes
clean domain events like `checks_passed` already exist, and nothing produced
them; and nothing gave a human one place to see what's in flight right now.

## A routine produces two outputs, not one

Worth stating this up front, since it cuts across several of the pieces
below: a single routine run writes two genuinely different things, to two
different places, for two different readers.

| | Outcome | Heartbeat |
|---|---|---|
| Written to | GitHub (comment, push, check-run) | The DO, directly |
| Durability | Authoritative — survives the session dying | Best-effort — losing it costs nothing but detail |
| Read by | `translate()` → `reduce()` (3.0/3.2) | A human, via the `state:stuck` comment (3.4) |
| Can it drive a transition? | Yes — it's the only thing that can | Never |

These aren't two mechanisms for the same job. The outcome is the fact the
state machine exists to act on. The heartbeat is a debugging aid for when
the outcome never arrives. Keeping them on separate paths — one through
GitHub's webhook delivery, one a direct call to the DO — is what makes it
safe for the heartbeat to be a callback at all (4). If the two ever get
merged into a single write path, the design has quietly lost the property
that only a verified fact can move the state machine.

## 3.0 The event translator (new)

Raw GitHub webhooks are not domain events. A single commit produces one
`check_run` webhook *per job*, not one `checks_passed` fact. A PR can be
reviewed by a bot, a human, or re-reviewed after a force-push. Label webhooks
fire for every label add, including ones our own system just made.

This layer's only job: turn a raw webhook payload into zero or one domain
event from the `Event` type the reducer understands, or drop it.

```ts
function translate(payload: WebhookPayload): Event | null {
  switch (payload.action) {
    case "check_suite.completed":
      // Aggregate — only fire once all required checks for the SHA report in.
      return allRequiredChecksComplete(payload)
        ? (allRequiredChecksPassed(payload) ? "checks_passed" : "checks_failed")
        : null;

    case "pull_request_review.submitted":
      if (isOwnBot(payload.sender)) return null; // never trust our own review comments as ground truth
      return payload.review.state === "approved" ? "review_approved" : "review_rejected";

    case "issues.labeled":
      if (isOwnBot(payload.sender)) return null; // see 3.3 — self-trigger guard, identity case
      return payload.label.name === "state:ready" ? "issue_labelled_ready" : null;

    case "issue_comment.created":
      // identity check alone misses this: some outputs post as a human account
      // on purpose (see 3.3) — a content marker is the only thing that catches it
      if (hasOwnSignatureMarker(payload.comment.body)) return null;
      return null; // no domain event maps to a plain comment today

    default:
      return null;
  }
}
```

This is where the CI-aggregation logic, the reviewer-identity filtering, and
the self-trigger guard (3.3) all live. It's pure and testable the same way
the reducer is — feed it a fixture payload, assert the event. Treat it as
part of "step 1: derive the table" in the build plan: you cannot write
`on: "checks_passed"` in the table until you've decided exactly what
aggregation rule produces that event.

## 3.1 The transition table

A plain TypeScript file listing every legal move. No database, no framework —
just data.

```ts
type Effect =
  | { kind: "label"; value: State }
  | { kind: "close-issue" }; // native GitHub state, not a label — see auto-release-loop precedent

type Rule = {
  from: State;
  on: Event;
  to: Effect;
  run?: string;        // which routine to fire, if any
  verifiedBy: "deterministic" | "external-judgment"; // see 02-design-principles.md
};

export const rules: Rule[] = [
  { from: "triage",   on: "issue_labelled_ready", to: label("spec"),     run: "write-spec", verifiedBy: "external-judgment" },
  { from: "spec",     on: "spec_written",         to: label("building"), run: "implement",  verifiedBy: "external-judgment" },
  { from: "building", on: "checks_failed",        to: label("rework"),   run: "fix-ci",      verifiedBy: "deterministic" },
  { from: "building", on: "checks_passed",        to: label("review"),   run: "review",      verifiedBy: "deterministic" },
  { from: "review",   on: "review_rejected",      to: label("rework"),   run: "address-review", verifiedBy: "external-judgment" },
  { from: "review",   on: "review_approved",      to: label("merging"),  run: "merge",       verifiedBy: "external-judgment" },
  { from: "rework",   on: "branch_pushed",        to: label("building"), verifiedBy: "deterministic" },
  { from: "merging",  on: "merged",               to: { kind: "close-issue" }, verifiedBy: "deterministic" },
];
```

`label(x)` is a one-line helper (`{ kind: "label", value: x }`) — most rows
still just set a `state:*` label. The last row is the one that doesn't:
`auto-release-loop`'s real precedent closes the issue natively on success
rather than labelling it `done`, and the table needs to represent that
directly instead of forcing every terminal state through a label that
nothing actually sets.

The `verifiedBy` field isn't enforced by code — it's a review aid. When
someone proposes a new rule, it forces the question "where does this event
actually come from, and can it be gamed by a bad agent run?"

The table above is a starting sketch, not our actual graph. Deriving the real
one from what the current system does in practice is Phase 1 — see
[07-build-phases.md](07-build-phases.md).

This is where all the thinking goes. The whole graph is readable on one
screen, and a diagram can be generated from it so the picture can't drift
from the code.

## 3.2 The reducer

The function that decides. Current state plus what happened, out comes what
to do next.

```ts
export function reduce(current: State, event: Event): Rule | null {
  return rules.find(r => r.from === current && r.on === event) ?? null;
}
```

`null` means the move isn't legal — drop the event. Not an error, just
nothing to do. That single line is most of our safety, and it's exactly
what's missing today: an event arriving at the wrong time currently fires a
routine anyway.

It's pure. No GitHub, no fetch, no labels. It doesn't know it runs on
Cloudflare. Which means the entire graph is testable in milliseconds:

```ts
expect(reduce("review", "review_rejected")?.to).toEqual(label("rework"));
expect(reduce("done", "branch_pushed")).toBeNull();
```

Given how much we lean on deterministic validation elsewhere, this is where
the confidence comes from. The table becomes reviewable as a spec rather than
as code.

## 3.3 State — GitHub labels

One `state:*` label per issue. Labels are **authoritative**. Everything else
is a copy.

We chose GitHub as the visible layer. If truth lives in a database and labels
mirror it, then when they disagree — and they will — the board is lying to
the team.

**Self-trigger guard — identity isn't always enough.** The DO writing a
label is itself a label-add event, which fires a webhook, which routes back
to the same DO. Where the write comes from our GitHub App identity, the
translator (3.0) drops it by checking `payload.sender`. But not every agent
output in this system writes as a bot — `issue-discuss-loop` (the existing
loop this exact problem already shows up in) posts comments **as the
maintainer's own account**, specifically so a human can't tell its comments
from theirs. Identity filtering can't catch that case, so its actual guard
is a signed marker in the comment body (`<!-- issue-discuss-loop -->`),
checked and skipped in `translate()` alongside the identity check. Any
future domain-event source that can be written as a human account needs the
same content-marker treatment, not just a sender check.

**The identity check itself has to be scoped, not blanket.** Wiring the
first real outcome artifact (`issue-build-loop`'s `build_succeeded` —
see [11-outcome-artifact.md](11-outcome-artifact.md)) surfaced the other
side of this: `issue-build-loop` posts its outcome comment under the same
bot identity a future reducer would use to write labels. A blanket "drop
anything from our own bot identity" check — applied to every payload
rather than scoped to label webhooks specifically — would silently
swallow that comment, because it's the loop's own new fact, not an echo
of anything the reducer wrote. The identity check belongs on the specific
webhook shape a self-authored write actually produces (a label add/remove
from the DO), not on every payload that happens to share a bot account.

**Human escape hatch — and its audit gap.** A human can drag an issue back to
`state:rework` and the machine picks it up. That's a feature, not a case to
defend against. But done directly on GitHub, it bypasses `reduce()` and the
D1 log: no legality check runs, and no transition row gets written. Policy:
the *next* webhook the DO receives for that issue reads the label fresh
(3.4 already does this), notices the state doesn't match what the log last
recorded, and writes a synthetic `D1` row — `event: "manual_override"` — so
the log stays a complete history instead of silently gaining a gap. This
doesn't validate the human's move against the table (the table has no
opinion on human overrides by design), it just makes sure the override is
visible later when someone's asking "how did this issue get here."

## 3.4 The serialiser and watchdog — Durable Object per issue

Two jobs, no more.

**Stop collisions.** Reading a label and writing a new one isn't atomic.
GitHub sends several events at once for one issue — `push`, then
`check_run`, then `check_suite`. On a stateless handler two of these run in
parallel, both read `building`, both fire. This is the most likely cause of
the cases where two agents end up on one branch.

A DO addressed `issue-412` handles one event at a time. The second reads the
state the first wrote, finds no rule, drops.

**Watch for death.** Fire a routine, set an alarm for 30 minutes. Outcome
arrives, cancel it. Alarm fires instead, the agent died — move to
`state:stuck`. This is what turns an invisible failure into an automatic one,
and it's the piece that's entirely absent today.

**Knowing why it died.** The watchdog tells you a routine died, not why.
With a normal live agent session you'd read the transcript; a routine
doesn't give the orchestrator that. The gap closes with a progress heartbeat
written *during* the run, not just at the end — but this lives in the DO,
not GitHub. The routine POSTs a short "currently at step X" message
(`started`, `wrote spec`, `running tests`, `pushed fix`, ...) to a Worker
endpoint scoped to that issue and attempt; the Worker routes it to the DO by
issue ID, and the DO stores `lastStep` / `lastStepAt` in its own durable
storage. If the alarm fires, the `state:stuck` comment it posts to GitHub
quotes that last recorded step instead of just "timed out."

This is a **second, best-effort ingestion path, and it must stay
diagnostic-only.** Unlike the outcome writes in 3.0/3.2, a dropped heartbeat
call is harmless — worst case you get "died, last step unknown," which is
exactly today's behaviour. That's *why* it's safe for this one channel to be
a direct callback instead of going through GitHub: nothing downstream
depends on it arriving, and it never feeds `reduce()`. It answers a human's
question ("why is this stuck") and nothing else. If a future change makes a
heartbeat drive an actual transition, it has quietly become an outcome and
belongs back in 3.0's translation layer with the verifiability discipline
that implies.

The DO holds no state in the state-machine sense — just delivery IDs already
seen, the rework counter, and which routine is running. It re-reads the label
from the API on every wake-up rather than caching, so it can't drift.

## 3.5 The log — D1

One row per transition. Issue, from, to, event, timestamp, `verifiedBy`.
Mostly append-only — the one deliberate exception is the reconciliation sweep
in [05-technical-elements.md](05-technical-elements.md), which has to read it
to know what "stale" means. Nothing else reads it to make a live decision.

This answers questions labels can't: which issues keep bouncing back, how
long each node takes, which transitions get dropped most.

It's also the evidence base for a question we can't currently answer — *was
this transition rule correct?* Labels only show where things are now, not
how they got there. Same instinct as the learnings capture work, one level
up: session learnings feed skill improvement, transition logs feed graph
revision.

## 3.6 The live-status view and dashboard (new)

The log (3.5) answers "what happened." Nobody could look at one place and
answer "what's happening *right now*" — which issue is mid-run, on which
routine, on which step, and for how long. GitHub's label gives you the
coarse state; the heartbeat data (3.4) that makes the fine-grained step
visible only exists inside each issue's own DO, and DOs aren't listable —
there's no "give me every active instance" call.

So this needs its own table, separate from the append-only log: a
**current-status view**, one row per open issue, upserted (not appended) on
every state transition and every heartbeat —

```
issue_id | state | routine | attempt | last_step | last_step_at | rework_count
```

This is a different animal from 3.5 on purpose. The log is history and stays
append-only. This table is *only* ever the latest snapshot — old rows get
overwritten, not kept — and nothing about mutating it freely conflicts with
the append-only discipline, because nothing downstream ever reads this table
to decide a transition either. It exists for one reader: a human looking at
a board.

The dashboard itself is a thin read path on top — a Worker route rendering
that table, refreshed on load. Nothing about our volume (§5) justifies
websockets or push updates; "live" here means "always current when you look
at it," not "updates while you watch." Worth revisiting only if that
assumption turns out wrong in practice.

One thing this does *not* need to rebuild: the coarse "what state is each
issue in" view is already close to free, since `state:*` is a real GitHub
label — a GitHub Project board grouped by that label gets you most of it
today. The actual net-new value here is the step-level detail the heartbeat
carries, which has never been visible anywhere until now.

---

[Next: 04 — Architecture →](04-architecture.md)
