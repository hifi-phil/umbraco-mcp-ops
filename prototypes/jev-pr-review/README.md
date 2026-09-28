# Jev PR review (prototype)

Tiered PR triage using [TypeSafe](https://docs.typesafe.ai)'s Jev: cheap, typed judgments per
diff hunk decide which parts of a PR deserve a full review by a reasoning model.

```sh
node review.mjs <pr-number> [--repo owner/name] [--out dir] [--dry-run]
```

Needs `gh` (logged in) and `TYPESAFE_API_KEY`. `--dry-run` builds every Tier 0 request and
writes it to `out/pr-<n>/run.json` without calling Jev. No npm dependencies (Node 22+).

## How it works

| Tier | What | Where |
| --- | --- | --- |
| 0 | Fixed questions on every hunk: change kind, matches description, touches a contract, risk | `questions.mjs` `TIER0` |
| 0s | Speculative follow-ups sent in the same request, each with its premise stated ("Assume this is a refactor…"); only consumed when the premise holds | `TIER0_SPECULATIVE` |
| 1 | Follow-ups needing new state, chosen by rules: test coverage for contract changes, re-ask with the whole file when a judgment is uncertain, which description goal a hunk serves | `policy.mjs` `planFollowups` |
| 2 | Hunks with high risk, or medium risk plus a concrete finding, written to `escalations.json` for Claude to review | `policy.mjs` `judge` |

Uncertain (Noul between 0.35 and 0.65) is handled as missing evidence: the question is asked again
with more context, and it is never escalated for that reason alone.

## Outputs

- `report.md`: escalations plus a per-hunk table.
- `escalations.json`: the Tier 2 hand-off (diff, answers, findings).
- `run.json`: every request and response. This is the calibration and learning log: once real
  outcomes are known, use it to tune thresholds, and to promote recurring Tier 2 questions into
  Tier 1 templates.

## Status

- Thresholds in `policy.mjs` are guesses. Calibrate them on real PRs before using them for anything.
- Tier 2 is a hand-off file only. Claude doesn't generate questions dynamically yet.
- Only the wiring has been tested, against a stubbed Jev. The answers haven't been evaluated.
- This sends PR diffs and file contents to a third-party API. Only use it on repos where that is approved.
