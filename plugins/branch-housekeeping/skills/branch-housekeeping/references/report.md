# The report — posting it, and what not to do to it

## `sweep.sh`'s stdout *is* the report

It's already Slack mrkdwn, already ordered, already carries the counts. **Relay it verbatim;
don't rewrite, re-summarise, or reformat it.** That's the point of generating it in a script:
two runs a week apart stay comparable, and no run can quietly reword a finding into something
softer.

Print it to stdout as well as posting, always. If Slack isn't reachable, the printed report
stands on its own — **say you couldn't post** rather than failing the run.

## Post to `#umbraco-mcp-housekeeping`

One message per run. Not one per repo — sweeping every repo in one pass exists so there's a
single thing to read.

## The sections, and why each stays

`sweep.sh` emits all of these. The failure mode is tidying them away, so don't:

- **Repos missing "Automatically delete head branches"** — the most actionable line in the
  report, because fixing it removes the need to clean up at all.
- **Merged — safe to remove.** Branches whose newest PR merged and whose tip is unchanged
  since. These are what `/clean-branches` would delete.
- **Needs review.** Everything requiring a human: PR closed unmerged, no PR at all, and
  **merged-but-reused-since** — that last one looks disposable and isn't, so never let it
  drift into the safe list.
- **Open-PR count.** One line, no names. It tells the reader the sweep saw active work and
  left it alone.
- **Coverage gaps** — *Not fully covered* and *Could not read*. These exist so a capped or
  unreadable repo can't be mistaken for a clean one.
- **Zero findings is a result, not silence.** Every empty section says "none".

## Naming the cleanup, without doing it

The report is read-only. When it lists branches under *safe to remove*, you may say so and
name the command — `/clean-branches`, or `/clean-branches --dry-run` to preview — and then
**stop**. Don't run it, don't offer to run it as part of this run, and don't imply the report
has already dealt with anything.

Nothing in this report describes an action taken, because the report never takes one. If you
find yourself writing "deleted" or "cleaned", something has gone wrong.

## Nothing beyond the template

No recommendations, no prioritisation, no commentary on what the branch names suggest. The
categories already carry the signal, and prose is where week-to-week comparability dies.
