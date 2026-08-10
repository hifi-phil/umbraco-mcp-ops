---
name: branch-housekeeping
description: >-
  Report the state of the remote branches across every configured Umbraco MCP repo in one
  run, then post one Slack digest. Classifies every non-protected branch by its **GitHub PR
  state** — authoritative where git ancestry isn't, because these repos squash-merge and a
  squashed branch is not an ancestor of its base — into: merged and safe to remove, merged
  but reused since (so NOT safe), PR closed unmerged, no PR at all, and open-PR branches
  left alone. Also flags any repo whose "Automatically delete head branches" setting is off,
  since that setting is what stops merged branches accumulating. **Read-only — it never
  deletes anything.** Cleaning is a separate, deliberate step: the `/clean-branches` command.
  Local-only (its sweep uses `gh`). Trigger on "what's the state of the branches", "run
  branch housekeeping", "which branches can I delete", "branch report".
---

# branch-housekeeping

Answers one question: **what is the state of the branches across these repos right now?**

It reads and reports. **It never deletes.** Deleting is `/clean-branches`, run by hand when
you've decided to act on this report. That split is deliberate — a report you can run any
time without consequence is worth more than one you have to think twice about, and the
destructive half stays a separate, explicit decision.

This file owns the **shape** of the run; the rules live in the reference files and in
`sweep.sh`.

## Environment

Its sweep is a script that uses **`gh`**, so this runs **locally** — see
[`references/routine-setup.md`](references/routine-setup.md) for why, and for wiring it as a
scheduled report. `github-ops` should be installed for any GitHub work you do around the
script, though the script itself calls `gh` directly.

Permissions: `metadata: read` + `pull_requests: read`. **No write scope at all** — if a run
seems to want one, something has drifted from this skill; stop and say so.

## Step 1 — sweep

```bash
bash "$CLAUDE_PLUGIN_ROOT/scripts/sweep.sh" --out "$(mktemp -d)"
# no $CLAUDE_PLUGIN_ROOT (source checkout of the ops repo)?
bash plugins/branch-housekeeping/scripts/sweep.sh --out "$(mktemp -d)"
```

Scope comes from [`scripts/repos.conf`](../../scripts/repos.conf) — **the single source of
truth**. No arguments sweeps every repo in it, which is the normal run. Pass `OWNER/REPO` to
narrow a one-off look.

`sweep.sh` is read-only and prints the finished digest on stdout. Classification is pure
mechanism with one right answer, which is why it's a script and not your judgement: it keeps
two runs a week apart comparable.

For the scope, the protection guards, and why the reuse check exists, read
[`references/sweep-config.md`](references/sweep-config.md).

## Step 2 — post the digest → [`references/report.md`](references/report.md)

Post `sweep.sh`'s stdout to the Slack channel named in
[`references/sweep-config.md`](references/sweep-config.md). The script's output *is* the
digest — **relay it, don't rewrite it.** That file has the rules.

## Step 3 — stop

There is no step 3. Do not offer to clean up, and do not clean up.

If the digest shows branches worth removing, say so plainly and name the command:
`/clean-branches` (add `--dry-run` first to see it without acting). Then leave it to the
human. The report's value is that running it is always free of consequence.

## Guardrails

- **Read-only, always.** Never delete a branch, and never run `reap.sh` from this skill — not
  even when the digest makes it obvious, not even if asked mid-run. Point at
  `/clean-branches` instead. A report that sometimes deletes is a report nobody can run
  casually, which defeats the point of splitting them.
- **`merged_at` is the only merge signal.** Not `state: closed`, not git ancestry.
- **A merged PR does not make a branch disposable.** Recurring branches
  (`chore/merge-main-to-dev`, `merge/v17-*`) get pushed to again after their PR merges, so
  they can hold work that was never merged anywhere. `sweep.sh` detects that by comparing the
  branch tip to the closed PR's frozen `head.sha` and reports it as **reused**. Report those
  as *not* safe to remove — see [`references/sweep-config.md`](references/sweep-config.md).
- **Never edit `repos.conf` to change what a run reports.** Scope changes go through a PR.
- **The repo setting beats any cleanup.** "Automatically delete head branches" reaps at merge
  time, for free. A repo with it off is the most actionable line in the digest.
- **Never report a cap or an unreadable repo as completeness.** `sweep.sh` emits both; keep
  them in the digest.
