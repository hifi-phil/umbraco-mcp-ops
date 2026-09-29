# 13. Shadow mode results

[← Index](00-index.md)

---

Phase 3's output (07-build-phases.md): the two numbers, and the gaps fed
back into the table.

## Run 1 — 29-09-2026

**Setup:** the Worker in `MODE=shadow` on a personal Cloudflare account
(`worker/terraform/`), with a webhook on `hifi-phil/umbraco-mcp-ops`. The real
loops ran as normal from `main`, with `agent-outcomes` loaded in the
routine's environment. **26** D1 rows. Covered: discuss (#113, #114, #116),
build (#114, #116), rework (PR #115), merge (PRs #112, #115, #117) and a
release (#118 → blocked, then finished by hand as 1.1.0).

### Number 1: fires the table would have blocked — **0**

All 12 trigger-label events matched a rule and chose the same loop the
real dispatcher fired. In this sample the current system never fired in
the wrong state.

### Number 2: gaps — 5

| | Gap | Evidence | Fix |
|---|---|---|---|
| A | Discussion rounds were invisible. The dispatcher fires `issue-discuss-loop` on each trusted reply (`route-event.sh`), but `translate()` only read outcome markers from comments. | #116: about 9 rounds, 1 row | `discussion_reply` event with the dispatcher's gates; rule `ai-discuss → ai-discuss`, runs the loop, unwatched |
| B | The watchdog relied on the outcome comment, which appeared **1 time in 4**. The table also watched `generated-by-ai`/`ai-blocked`, so a finished build would have gone `ai-stuck`. | #116 row 15; #118's blocked comment had no marker | The loop's own label swap ends the run: `generated-by-ai`/`ai-blocked` added → `build_*`; trigger label removed → `unlabelled_*`; `issues.closed` in `auto-release` ends a release. Outcome labels are no longer watched. |
| C | 30 minutes is too short for a release. | #118: watchdog at 19:35, the loop posted at 19:41 | Per-routine timeout: release 120, build 60, others 30 (first guesses) |
| D | Every push became `rework_pushed`. | rows 14, 17, 23, 24 | Contextual event: ignored (not logged) outside `auto-rework` |
| E | Merges without a loop label were logged as gaps. | rows 22, 25, 26 | Contextual event: ignored outside `auto-merge` |

### Main lesson

The loops' own label swaps were 100% reliable; the self-reported outcome
comments weren't. Until Phase 5 (reducer owns labels), the swap is the
completion signal and the marker is enrichment. Why #116 and #118 skipped
the marker when #114 wrote it, in the same environment, is still unknown.

### Also observed

- Every action is attributed to `hifi-phil`, loops included. That's fine in
  shadow, but the self-trigger guard needs a separate identity (the GitHub
  App) before enforce.
- `auto-merge` added to an *issue* (#114) was correctly ignored.
- Heartbeats weren't wired (`AGENT_OUTCOMES_ENDPOINT` unset), so the
  watchdog had only the fire time to go on.

## Next

Redeploy, then run 2 to confirm A–E: number 2 should drop to about 0,
with no false `watchdog_expired` rows.
