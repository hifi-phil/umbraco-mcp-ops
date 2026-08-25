# 2. The reasoning

[← Previous: Current state](01-current-state.md) | [Index](00-index.md) | [Next: The components →](03-components.md)

---

Two different ideas get called "graph engineering" and only one is what we're
building.

**Graph as orchestration topology.** Nodes are tasks and states, edges are
transitions, with branching and exception handling. LangGraph, Temporal, Step
Functions. This is us.

**Graph as a network of control loops.** Nodes are improvement cycles;
reliability lives in which loop can veto which. The cybernetics reading — a
level above us for now.

The first is honestly not new. What we're describing is a state machine over
a workflow, the same shape as BPM or Airflow. The only genuinely new thing is
that the nodes are non-deterministic.

That reframes the purpose. **The graph isn't there to coordinate agents. It's
there to contain them.** Effort goes into edge conditions and gates, not into
making nodes cleverer.

It also tells us where our existing work fits. The common failure of agent
orchestration is topology with no ground truth — a graph whose transitions
depend on an agent's opinion of its own work. Our deterministic validation is
that ground truth. We have the harder half already, and we're adding topology
to it, which is the right order round.

## The load-bearing rule

**An agent writes an outcome. It never writes the next state.**

If a finishing agent sets `state:ready-for-review`, we don't have a state
machine — we have a handoff chain wearing one, and no invariant survives an
agent having a bad day. This is the direct cause of the missing-label
symptom.

The agent writes a fact: "finished, branch is X, here's the test run."
Something else reads that fact plus the current state and decides the
transition. That separation is the entire value of the design.

Corollary: the fact must be verifiable, not self-reported. "Tests passed"
comes from the CI check, not from the agent's summary of itself.

## Not every fact is equally verifiable

The corollary above is doing a lot of work, and it's worth being honest about
where it actually holds.

| Event | Source of truth | Verifiable? |
|---|---|---|
| `checks_passed` / `checks_failed` | CI check-run/check-suite conclusion | Yes — deterministic, machine-produced |
| `branch_pushed` | Git ref update | Yes — deterministic |
| `merged` | PR merged state | Yes — deterministic |
| `review_approved` / `review_rejected` | PR review submission | **Partially** |

A review approval is a judgment call, not a deterministic check — even when a
human makes it. If the reviewer is a person, that judgment is exactly what we
want the gate to capture, and it's fine to treat it as ground truth: it's
*external* to the agent that did the work, which is the property we actually
need. But if the "review" step is itself another agent session, then
`review_approved` is a self-report one hop removed — it's still a model's
opinion, just not the same model. That doesn't fail the design (independent
review by a second agent is still worth more than self-review), but it
shouldn't be filed under the same "deterministic ground truth" heading as CI
results. Track which transitions in the table rest on a deterministic check
versus an external judgment call — see the `verified_by` note in
[03-components.md](03-components.md#31-the-transition-table).

---

[Next: 03 — The components →](03-components.md)
