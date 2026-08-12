---
description: Delete remote branches whose PR was merged and which haven't been touched since. Purely mechanical — runs reap.sh and reports its output. Never scheduled; run it only when you want branches gone.
argument-hint: "[--dry-run] [OWNER/REPO ...]"
allowed-tools: Bash(bash *reap.sh*), Bash(ls *), Read
---

Run the reaper and report exactly what it printed. Nothing else.

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/reap.sh" $ARGUMENTS
# no $CLAUDE_PLUGIN_ROOT (working in a checkout of the ops repo)?
bash plugins/branch-housekeeping/scripts/reap.sh $ARGUMENTS
```

With no arguments it sweeps every repo in `scripts/repos.conf` fresh, then deletes the
branches that qualify. `--dry-run` runs every check and deletes nothing. Naming repos
(`umbraco/Umbraco-MCP-Base`) limits it to those.

## Your job here is to run it and relay the result

**Do not decide anything.** The script owns every judgement — which branches qualify, which
are protected, which were reused since their PR merged. That is the point of it being a
script: the same input produces the same deletions every time, with no model in the loop.

So:

- **Relay its output as-is.** Per-branch lines (`DEL`, `GONE`, `SKIP`, `FAIL`) plus the
  final tally. Don't summarise a skip away.
- **`FAIL` needs the human.** A delete that was rejected while the branch is still there is
  the one line worth calling out explicitly.
- **`SKIP` is usually correct, not a problem.** `PROTECTED` and `REUSED since PR #N merged`
  are the guards working. Report them without suggesting a way round them.
- **Never delete a branch yourself** — no `git push --delete`, no `gh api -X DELETE`, no
  editing `repos.conf` to widen the net. Those bypass the checks the script exists to run.
  If the script won't delete something, that is the answer.
- **Never re-run it hoping for a different result.** It's deterministic; it won't give you one.

## If it refuses to start

`gh` not authenticated → `gh auth login`. Missing `gh`/`jq` → install them; this is
local-only by design, because the GitHub MCP server has no branch-delete tool.

## What this command is not

It doesn't report on branch state — that's the **`branch-housekeeping` skill**, which
classifies everything and posts a Slack digest without touching anything. Read that first
if you want to know what's out there; run this when you've decided to clear it.
