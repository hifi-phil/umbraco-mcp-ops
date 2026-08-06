# The PR, the CI loop, and reporting

Detail for **step 7** (open/update the PR), **step 8** (drive to green, close the
superseded PRs) and **step 10** (notify). All GitHub operations go through `github-ops`.

## The rollup PR — step 7

**Create** it against `dev` (→ *Create a PR*), or **update its body** (→ *Update a PR's
body*) if step 1 found an existing one. Title: `chore(deps): security rollup (<date>)`.

Body sections:

- **Included** — per package: name, `from → to` **as verified in step 5** (never a version
  you haven't asserted in the lockfile), highest open advisory severity.
- **Deferred (major — handle separately)** — each DEFER-MAJOR PR number + link.
- **Uncovered alerts** — package, severity, required version.
- **Supersedes** — every INCLUDE PR number.

**Never merge and never enable auto-merge**, whatever the outcome. The PR is handed back
green for human review.

## Drive to green — step 8, the loop

Update the `/goal` to name the PR number now it exists, then loop:

- Poll the PR's **CI / check-run status** (→ *Get PR CI / check-run status*) until it
  settles, rather than busy-waiting.
- On failure: **read the failing check's log** (→ *Read a failing check's log*), fix the
  root cause in code, commit, push, re-poll. A CI failure is a real regression to fix —
  never hand a red PR to the human.
- If CI can't be driven green after ~3 genuine fix attempts, **push what you have and
  stop** with `NEEDS-ME (CI red)` + the PR link. Leave the PR open: a red PR that's been
  reported is recoverable, a silently abandoned branch isn't.

## Close the superseded PRs — only once CI is fully green

This is the step that must never run early: it's the only thing standing between a failed
rollup and lost security fixes.

Per INCLUDE PR (→ *Close a PR without merging (+ comment, delete branch)*), comment naming
the rollup and the recovery path:

```
Superseded by #<ROLLUP> — rolled into the security rollup. If the advisory is still
unresolved once #<ROLLUP> lands, Dependabot will raise it again.
```

Then confirm it's closed (→ *Get a PR*). **Delete the branch here** — Dependabot only
removes its own branch once the update reaches the default branch.

**If a close is denied, do not abort.** Finish everything else, then report
`NEEDS-ME (closes blocked)` with each PR number and a paste-ready command per PR. The
rollup PR is open and green by this point, so the run has already delivered its value —
the closes are tidy-up. Never leave the human to work out which PRs are now redundant.

Denied closes in an unattended run usually mean the routine prompt is missing its consent
line — see [`unattended-operation.md`](unattended-operation.md).

## Notify — step 10, once

One REVIEW-NEEDED summary, only when the PR is open, CI is fully green, and every
superseded PR is closed or reported blocked: the PR link; the count + names of included
fixes **with their verified resolved versions**; the closed/superseded PRs; the
DEFER-MAJOR list with the reminder that majors are handled one-to-one by a human; the
uncovered alerts. Send it as a push notification when running unattended.

Report exactly one outcome tag — `ROLLUP OPEN` / `NO-OP` / `ALREADY AWAITING REVIEW` /
`NEEDS-ME (reason)` — then `/goal clear`. Stay silent for `NO-OP`, but never a *blind*
one: it still prints its evidence ([`classification.md`](classification.md)).
