---
name: branch-housekeeping
description: >-
  Weekly remote-branch sweep across **every** configured Umbraco MCP repo in one run, then
  one Slack digest. Two deterministic scripts do the work: `sweep.sh` classifies every
  non-protected branch by its **GitHub PR state** — authoritative where git ancestry isn't,
  because these repos squash-merge and a squashed branch is not an ancestor of its base —
  and `reap.sh` deletes the merged ones, re-verifying each against the API first. Branches
  whose PR was closed unmerged, or that have no PR at all, are never touched; they go to
  Slack for a human to judge. Also flags any repo whose "Automatically delete head branches"
  setting is off, since that setting — not this sweep — is what stops merged branches
  accumulating. **Local-only**, like `dependabot-rollup`: the deletes need `gh`, and the
  GitHub MCP server has no branch-delete tool, so a cloud routine can never do this.
  Reaping requires explicit authorisation in the routine prompt; without it the run is
  report-only. Requires the `github-ops` skill. Trigger on "run branch housekeeping",
  "sweep the branches", "clean up merged branches", "which branches can I delete".
---

# branch-housekeeping

Stale remote branches pile up and make every repo harder to read. This sweep says exactly
which are safe to lose and which need a human — from the **PR state**, never git ancestry,
because these repos squash-merge and `git branch --merged` misses a squashed branch entirely.

This file owns the **shape** of the run. The rules live in the reference files and, wherever
a step can be deterministic, in a script — read each when you reach it.

## Local-only, and why → [`references/unattended-operation.md`](references/unattended-operation.md)

Read that file before setting up or debugging a scheduled routine. It covers why this can't
be a cloud routine, the **consent line the routine prompt must carry** for the deletes, and
what `/goal` is and isn't needed for here.

The short version: `gh` does the deleting, cloud routines have no `gh`, and the GitHub MCP
server exposes no branch-delete tool at all. So this runs on your machine or not at all.

## Environment

**GitHub work goes through the `github-ops` skill** — but note that almost none of it is
yours to do here: the scripts call `gh` directly. You need `github-ops` for the operations
you perform *around* the scripts (and it must be installed), and `gh` must be authenticated.
`sweep.sh` checks that itself and fails loudly if not.

Permissions: report-only needs `metadata: read` + `pull_requests: read`. Reaping additionally
needs `contents: write`. Your `gh` login already carries these.

## Procedure

### 1. Sweep — one run covers every configured repo

```bash
bash "$CLAUDE_PLUGIN_ROOT/scripts/sweep.sh" --out "$(mktemp -d)"
# no $CLAUDE_PLUGIN_ROOT (source checkout of the ops repo)?
bash plugins/branch-housekeeping/scripts/sweep.sh --out "$(mktemp -d)"
```

Scope comes from [`scripts/repos.conf`](../../scripts/repos.conf) — **the single source of
truth**, read by both scripts. Pass `OWNER/REPO` arguments only to narrow a one-off run to
specific repos; the weekly run takes no arguments and sweeps them all.

`sweep.sh` is **read-only** and prints the finished Slack digest on stdout. It also writes
`merged.tsv`, `review.tsv`, `setting-off.tsv` and `skipped.tsv` into the `--out` directory —
note the directory it echoes on stderr as `OUT=…`, because step 2 needs `merged.tsv`.

Why it's a script: classification is pure mechanism (three protection guards, then one PR
lookup per branch) with an exact right answer. Doing it by hand invites a wrong call on a
destructive decision, and makes two runs incomparable.

For scope changes and the reasoning behind the current protected lists, read
[`references/sweep-config.md`](references/sweep-config.md).

### 2. Reap — only if the routine prompt authorised it

**Check for authorisation first.** The routine prompt (or the user, in an interactive run)
must explicitly authorise deleting the merged branches. **No authorisation → skip this step
entirely and report the run as report-only.** Never infer consent from the fact that merged
branches exist; see the consent rules in
[`references/unattended-operation.md`](references/unattended-operation.md).

```bash
bash "$CLAUDE_PLUGIN_ROOT/scripts/reap.sh" --list "$OUT/merged.tsv"
# rehearse first if you want to see the guards fire, deleting nothing:
bash "$CLAUDE_PLUGIN_ROOT/scripts/reap.sh" --list "$OUT/merged.tsv" --dry-run
```

`reap.sh` does not trust its input. Per branch it re-reads the repo's live default branch and
branch protection, re-checks `repos.conf`, and **re-verifies MERGED against the API** before
deleting — so a stale list can only cause a skip, never a wrong delete. It's idempotent: an
already-deleted branch is a success, not an error.

**Read its output and carry the real numbers into the digest.** A `SKIP` or `FAIL` line is a
result the human needs, not noise to summarise away.

### 3. Post the digest to Slack → [`references/digest.md`](references/digest.md)

Post `sweep.sh`'s stdout to the Slack channel named in
[`references/sweep-config.md`](references/sweep-config.md), amended with what step 2 actually
did. That file has the rules — the important one being that the script's output is already
the digest, so **relay it, don't rewrite it**.

## Guardrails

- **Only `reap.sh` ever deletes, only category MERGED, and only with authorisation.** Never
  delete a branch with `git push --delete` or a bare `gh api -X DELETE` by hand — you'd skip
  every guard the script exists to apply.
- **`CLOSED-unmerged` and `NO-PR` are permanently human decisions.** They go to Slack. No
  amount of age makes them auto-deletable.
- **`merged_at` is the only merge signal.** Not `state: closed`, not git ancestry.
- **A merged PR does not make a branch disposable.** Recurring branches (`chore/merge-main-to-dev`,
  `merge/v17-*`) get pushed to again after their PR merges, so they can hold work that was never
  merged anywhere. Both scripts guard against it by comparing the branch tip to the closed PR's
  frozen `head.sha`; a mismatch means REUSED, which goes to review and is never deleted. Don't
  weaken that guard to make a stubborn branch reapable — read the explanation in
  [`references/sweep-config.md`](references/sweep-config.md) first.
- **Never edit `repos.conf` to make a run "work".** If a branch you expected to be reaped got
  skipped as protected, that's the guard doing its job — check
  [`references/sweep-config.md`](references/sweep-config.md) before touching the list.
- **The repo setting beats this sweep.** "Automatically delete head branches" reaps at merge
  time, for free. If the digest lists a repo with it off, say so — that fix outranks running
  this more often.
- **Never report a cap or a failed repo as completeness.** `sweep.sh` emits both; keep them in
  the digest.
