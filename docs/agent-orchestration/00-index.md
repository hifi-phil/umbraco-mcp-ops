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
| [10-label-rename.md](10-label-rename.md) | *(new)* Label rename | Proposed renames (`ready-for-ai`→`ai-ready`, `generated-by-ai`→`ai-generated`, and the command→state gerund fix for `auto-release`/`ai-discuss`/`auto-rework`/`auto-merge`) surfaced by collapsing `State` to the literal label string — not yet executed on any live label |
| [11-outcome-artifact.md](11-outcome-artifact.md) | *(new)* The outcome artifacts | `issue-build-loop` and `auto-release-loop` now write structured outcome comments for all four of their events (additive, alongside existing label swaps/closes) — `translate()` reads them for real. `rework_pushed` needed no artifact at all (native `pull_request.synchronize`); `merge_gate_failed_*` correctly deferred as infrastructure work. A tested `PostToolUse` hook (`plugins/agent-outcomes/hooks/`) forwards artifacts as a non-authoritative fast path — GitHub stays authoritative throughout |

## The one-paragraph version

Right now an event fires a routine with no check on whether the issue was in
a state where that made sense, and agents self-report the outcome by writing
their own labels. Both are the same failure: nothing owns the transition. The
fix is a pure `reduce(state, event)` function in front of the fire call, a
Durable Object per issue to serialize events and watch for dead runs, and
GitHub labels as the one authoritative state. Build it by measuring the
current system in shadow mode before turning on enforcement — see
[07-build-phases.md](07-build-phases.md) for the order.
