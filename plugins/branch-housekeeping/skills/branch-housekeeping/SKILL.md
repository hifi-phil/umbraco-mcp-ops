---
name: branch-housekeeping
description: >-
  Report the state of the remote branches across every configured Umbraco MCP repo in one run,
  then post one Slack digest. Classifies every non-protected branch by its **GitHub PR state** —
  authoritative where git ancestry isn't, because these repos squash-merge and a squashed
  branch is not an ancestor of its base — into: merged and safe to remove, merged but reused
  since (so NOT safe), PR closed unmerged, no PR at all, and open-PR branches left alone. Also
  flags any repo whose "Automatically delete head branches" setting is off, since that setting
  is what stops merged branches accumulating. **Informational and read-only — it never deletes
  anything**, which is why it needs no write scope and runs happily as a scheduled cloud
  routine as well as locally. Removing branches is a separate, deliberate step: the
  `/clean-branches` command, which is local-only. GitHub work goes through the required
  `github-ops` skill. Trigger on "what's the state of the branches", "run branch housekeeping",
  "which branches can I delete", "branch report".
---

# branch-housekeeping

Answers one question: **what is the state of the branches across these repos right now?**

It reads and reports. **It never deletes.** Removing branches is `/clean-branches`, run by hand
when you've decided to act on this report. That split is what makes this half free of
consequence — no write scope, nothing to authorise, safe to schedule or run on a whim.

This file owns the **shape** of the run. The rules live in the reference files.

## Runtime — either environment

All GitHub work goes through the **`github-ops`** skill, which owns the local-vs-web mechanism
(this skill names the operation; `github-ops` has the command or tool).

```
gh available (dev machine)  →  run scripts/sweep.sh   (deterministic, one call)
gh absent   (cloud routine) →  classify via mcp__github__*  (github-ops → MCP reference)
```

Both are supported and produce the **same digest** — see
[Step 1](#step-1--classify-every-branch). Detect with `command -v gh`.

> **`github-ops` must be installed for this skill to run.**

Permissions: `metadata: read` + `pull_requests: read`. **No write scope at all.** If a run
seems to want one, something has drifted from this skill — stop and say so.

For scheduling it as a routine, read [`references/routine-setup.md`](references/routine-setup.md).

## Step 1 — classify every branch

Scope comes from [`scripts/repos.conf`](../../scripts/repos.conf) — **the single source of
truth**, used by this skill and by `/clean-branches`. All configured repos in one run. Narrow
to specific repos only for a one-off look.

**The rules are in [`references/classification.md`](references/classification.md)** — the three
protection guards, the PR-state categories, and the reuse guard. That file is canonical for
both paths; read it rather than reasoning from first principles.

**Local path** — `gh` available:

```bash
bash "$CLAUDE_PLUGIN_ROOT/scripts/sweep.sh" --out "$(mktemp -d)"
# no $CLAUDE_PLUGIN_ROOT (source checkout of the ops repo)?
bash plugins/branch-housekeeping/scripts/sweep.sh --out "$(mktemp -d)"
```

It implements `classification.md` exactly and prints the finished digest on stdout. Prefer it
whenever `gh` is there: one invocation, no judgement calls, and two runs stay comparable.

**Cloud path** — no `gh`: work through `classification.md` using the `mcp__github__*` tools per
`github-ops`. Same rules, same categories, same digest.

`repos.conf` is **not** delivered to a cloud environment — `cloud-skill-sync` copies the skill
directory, and the config lives beside the scripts. So read it from the repo itself
(github-ops → *Get file contents*, `hifi-phil/umbraco-mcp-ops`, path
`plugins/branch-housekeeping/scripts/repos.conf`), or from the checkout if the routine has one.

**If you cannot read it, stop and say so.** Never fall back to a repo list from memory, from
this file, or from the routine prompt: an invented scope produces a confident report about the
wrong set of repos, which is worse than no report. An unresolvable config is a wiring problem
worth surfacing.

## Step 2 — post the digest → [`references/report.md`](references/report.md)

Post to the Slack channel named in
[`references/sweep-config.md`](references/sweep-config.md). On the local path `sweep.sh`'s
stdout **is** the digest — relay it, don't rewrite it. On the cloud path, build it to the
template in `report.md`, which exists so both paths emit byte-comparable output.

## Step 3 — stop

There is no step 3. Do not offer to clean up, and do not clean up.

If the digest shows branches worth removing, say so plainly and name the command:
`/clean-branches` (`--dry-run` first to preview). Then leave it. The report's value is that
running it is always free of consequence.

## Guardrails

- **Read-only, always.** Never delete a branch, and never run `reap.sh` from this skill — not
  even when the digest makes it obvious, not even if asked mid-run. Point at `/clean-branches`
  instead. A report that sometimes deletes is one nobody can run casually, which defeats the
  split.
- **`merged_at` is the only merge signal.** Not `state: closed`, not git ancestry.
- **A merged PR does not make a branch disposable.** The reuse guard in
  [`references/classification.md`](references/classification.md) is the least obvious rule here
  and the one that protects live release lines. Never report a reused branch as safe.
- **The two paths must agree.** If you change how classification works, change
  `classification.md` **and** `sweep.sh` together. A branch reported differently depending on
  where the run happened is worse than either answer alone.
- **Never edit `repos.conf` to change what a run reports.** Scope changes go through a PR.
- **The repo setting beats any cleanup.** "Automatically delete head branches" reaps at merge
  time, for free. A repo with it off is the most actionable line in the digest.
- **Never report a cap or an unreadable repo as completeness.** Both are gaps; keep them in the
  digest.
