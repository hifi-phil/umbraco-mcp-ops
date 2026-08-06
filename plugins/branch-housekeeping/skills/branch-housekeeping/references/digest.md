# The digest — posting it, and what not to do to it

## `sweep.sh`'s stdout *is* the digest

It's already Slack mrkdwn, already ordered, already carries the counts. **Relay it verbatim;
don't rewrite, re-summarise, or reformat it.** That's the whole point of generating it in a
script: two runs a week apart stay comparable, and no run can quietly reword a finding into
something softer.

Print it to stdout as well as posting, always. If Slack isn't reachable, the printed digest
stands on its own — **say you couldn't post** rather than failing the run.

## Post to `#umbraco-mcp-housekeeping`

One message per run. Not one per repo — the whole point of sweeping every repo in one pass is a
single thing to read.

## Amend it with what the reap actually did

`sweep.sh` runs before any deleting, so its "Merged — safe to delete" section describes
*candidates*. Add one line at the end recording the outcome, using `reap.sh`'s real numbers:

```
_Reaped 51 merged branch(es); 0 skipped, 0 failed._
```

or, when the routine prompt carried no authorisation:

```
_Report-only — no deletions attempted (routine prompt carried no authorisation)._
```

Rules for that line:

- **Use the numbers `reap.sh` printed.** Don't recompute them from the candidate list; a skip
  or a failure is exactly the discrepancy worth surfacing.
- **Name any `FAIL`** with its repo and branch. A delete that was rejected while the branch is
  still there is the one outcome that needs a human.
- **Name any `SKIP` that wasn't expected.** `PROTECTED` skips are the guards working as
  designed and need no commentary; *"not merged on re-check"* means the sweep and the reap
  disagreed, which is worth a line.

## Things the digest must keep

`sweep.sh` already emits all of these — the failure mode is editing them out, so don't:

- **Zero findings is a result, not silence.** Every empty section says "none".
- **The settings check.** A repo with "Automatically delete head branches" off is the most
  actionable line in the digest, because fixing it removes the need for the reap.
- **Coverage gaps.** The *Not fully covered* and *Could not read* sections exist so a capped or
  unreadable repo can't be mistaken for a clean one. Never drop them to make the digest tidier.
- **The open-PR count.** One line, no names — it's what tells the reader the sweep looked at
  active work and deliberately left it alone.

## Nothing beyond the template

No recommendations, no prioritisation, no commentary on what the branch names suggest. The
categories already carry the signal, and prose is where week-to-week comparability dies. The
one permitted addition is the reap-outcome line above.
