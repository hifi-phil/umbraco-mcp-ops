# Agent Orchestration: Phased Plan

**Status:** Draft for discussion
**Supersedes:** `agent-orchestration-design.md` (13-08-2026)
**Date:** 23-08-2026

---

This is the original state-machine design, split into one file per topic and
built out with the gaps found in review. Nothing in the original's shape
changed — agent writes a fact, reducer writes the state, labels are
authoritative, build in shadow mode before enforcing. What's new is named
explicitly below instead of living as a footnote.

## How to read this

Files 01–06 are the **design** — what we're building and why. File 07 is the
**plan** — the phases, in order, that get us there. File 08 is what's still
unresolved. If you only read one file, read 07.

## Contents

| File | Section | What changed from the original |
|---|---|---|
| [01-current-state.md](01-current-state.md) | Where we are | Unchanged — still the diagnosis |
| [02-design-principles.md](02-design-principles.md) | The reasoning | Added: which "facts" are actually verifiable and which aren't |
| [03-components.md](03-components.md) | The parts | Added: the event-translation layer; self-trigger loop guard; audit policy for human label edits; the outcome-vs-heartbeat split; the live-status view and dashboard |
| [04-architecture.md](04-architecture.md) | How it fits together | Diagram updated to show the translation layer, the heartbeat as a separate dashed edge, and the current-status table feeding the dashboard |
| [05-technical-elements.md](05-technical-elements.md) | Technical elements | Added: concrete reconciliation sweep design; rework cap default; fire/log ordering; the current-status table |
| [06-platform-alternative.md](06-platform-alternative.md) | Azure alternative | Unchanged |
| [07-build-phases.md](07-build-phases.md) | Build order | Restated as 10 numbered phases with entry/exit criteria; new Phase 8 for the dashboard, heartbeat write-side folded into Phase 6 |
| [08-open-questions.md](08-open-questions.md) | Open questions | Some resolved by 03/05; new ones added |
| [09-phase-1-real-graph.md](09-phase-1-real-graph.md) | *(new)* Phase 1 in progress | The real transition table, audited against `loop-dispatch` and the loop skills already in this repo — not a sketch |
| [10-label-rename.md](10-label-rename.md) | Label rename | The renames (`ready-for-ai`→`ai-ready`, `generated-by-ai`→`ai-generated`, and the command→state gerund fix for `auto-release`/`ai-discuss`/`auto-rework`/`auto-merge`) surfaced by collapsing `State` to the literal label string. **Update:** the 14 referencing skill files are now migrated to the new spelling — but no live GitHub label and no routine trigger config are, which is now an active coordination hazard, not just remaining work; see the file and [08-open-questions.md](08-open-questions.md) |
| [11-outcome-artifact.md](11-outcome-artifact.md) | The outcome artifacts | `issue-build-loop` and `auto-release-loop` now write structured outcome comments for all four of their events (additive, alongside existing label swaps/closes) — `translate()` reads them for real, each now keyed on the post-swap state, matching for real what `verifiedBy: "deterministic"` already claimed. `rework_pushed` needed no artifact at all (native `pull_request.synchronize`); `merge_gate_failed_soft`/`hard` correctly have no artifact either — their real source is now a live re-check (`coordinate.ts`'s `handleCheckSuiteCompleted` + `graph/github/merge-gate.ts`), not a self-report, so `merge-flow` needed zero changes. A tested `PostToolUse` hook (`plugins/agent-outcomes/hooks/`) forwards artifacts as a non-authoritative fast path — GitHub stays authoritative throughout. **The fast path now has a real receiving endpoint**: `worker/src/index.ts`'s `POST /routine-signal`, bearer-secret guarded, routing to `coordinate.ts`'s `coordinateRoutineSignal` (extends the watchdog on a heartbeat, cancels it early on completion, never a state transition) — unit tested end to end, but `AGENT_OUTCOMES_ENDPOINT` has never actually been pointed at it, so it's still unconfirmed against a real cloud routine |
| [`../../worker/README.md`](../../worker/README.md) | The real receiver | A Cloudflare Worker + Durable Object exist as code now, importing `graph/` directly — 91 unit tests across `worker/` alone, 166 including `graph/` (`index.ts`/`issue-coordinator.ts` themselves covered: signature verification, DO routing/isolation, the watchdog alarm actually firing, the direct routine→DO heartbeat channel, the real merge-gate aggregation — all via fakes, no `@cloudflare/vitest-pool-workers`), clean type-check. Converged into a **black-box harness**: everything real (Worker, DO, D1, the reducer, the mock's webhook emission) except the five loops, each black-boxed the way it's actually observed — a real `@anthropic-ai/claude-agent-sdk` session vs. verbatim skill text for the two loops that self-report an outcome comment, a direct synthetic webhook for the two loops whose real signal is a native GitHub event, and (new) a direct synthetic webhook *plus* an independently re-verified live gate check for `merge-flow`'s gate-failed cases — no agent for any of the native/re-verified ones, more faithful, not a shortcut. Run for real end to end, every one of these landed correctly against the real Worker + D1, and surfaced real findings along the way: three of the four outcome-artifact rules were keyed on the wrong (pre-swap) state and always dropped — fixed, all four now keyed correctly; `issue-build-loop`'s live skill text was still on the pre-rename label spelling while `graph/` already used the new one — fixed across all 14 referencing files (see [10-label-rename.md](10-label-rename.md) for the coordination hazard that fix now creates, still unresolved). Not deployed anywhere — no live Cloudflare account access for this repo. Built as Phase 4's enforcement mechanism (real writes, no toggle), not Phase 3's — see [07-build-phases.md](07-build-phases.md)'s status notes and the shadow-mode-toggle gap in [08-open-questions.md](08-open-questions.md) |

## The one-paragraph version

Right now an event fires a routine with no check on whether the issue was in
a state where that made sense, and agents self-report the outcome by writing
their own labels. Both are the same failure: nothing owns the transition. The
fix is a pure `reduce(state, event)` function in front of the fire call, a
Durable Object per issue to serialize events and watch for dead runs, and
GitHub labels as the one authoritative state. Build it by measuring the
current system in shadow mode before turning on enforcement — see
[07-build-phases.md](07-build-phases.md) for the order.
