---
name: branch-housekeeping
description: >-
  Weekly remote-branch sweep across the configured Umbraco MCP repos. Classifies every
  non-protected branch by its **GitHub PR state** — the authoritative signal, because
  squash merges mean a merged branch is not a git ancestor of `main`, so
  `git branch --merged` misses it — then posts one Slack digest: merged leftovers that
  should already be gone, ambiguous branches (PR closed unmerged, or no PR at all) for a
  human to judge, and a silent count of open-PR branches left alone. Also checks each
  repo's "Automatically delete head branches" setting and flags it when off, since that
  setting — not this sweep — is what stops merged branches accumulating. Report-only by
  default; all GitHub work goes through the required `github-ops` skill, so it needs no
  token and runs as a scheduled cloud routine. Trigger on "run branch housekeeping",
  "sweep the branches", "clean up merged branches", "which branches can I delete".
---

# branch-housekeeping

Stale remote branches pile up and make every repo harder to read. This sweep tells you
exactly which are safe to lose and which need a human — using the **PR state**, not git
ancestry, because the MCP repos squash-merge and a squashed branch is *not* an ancestor
of its base.

**This skill does not delete branches.** That's deliberate, and it's the one thing to
understand before running it — see [Why report-only](#why-report-only).

## Runtime & auth

Every GitHub action here — listing branches, reading repo settings, looking up PRs —
goes through the **`github-ops`** skill, which owns the local-vs-web mechanism (this
skill names the operation; `github-ops` has the command or tool). Locally that's `gh`;
in a cloud routine it's the GitHub MCP server, authenticated by the connected GitHub
App. **No `GH_TOKEN`, no webhook, nothing to configure.**

> **`github-ops` must be installed for this sweep to run.**

Needed permissions on the connected App: `metadata: read` (repo settings, branches) and
`pull_requests: read` (classification). Report-only mode needs **no write scope at all**.

## Why report-only

The GitHub MCP server exposes **no branch- or ref-delete tool**. Its `repos` toolset has
`create_branch` but no delete; its `git` toolset is a single tool (`get_repository_tree`);
`merge_pull_request` has no delete-branch parameter. Verified against the server's own
tool registration list ([`pkg/github/tools.go`](https://github.com/github/github-mcp-server/blob/main/pkg/github/tools.go)).
So on the cloud path — where this sweep actually runs — deletion is not available, full stop.

That turns out to be the better design anyway, because deletion belongs upstream:

**GitHub's per-repo "Automatically delete head branches" setting reaps every merged
branch at merge time, natively, with no automation at all.** Turn it on once per repo
(Settings → General → Pull Requests) and the `MERGED` category stops growing. This sweep
then does the part a checkbox can't: judging the ambiguous branches, and telling you if
the checkbox got switched off. **Step 2 checks the setting and flags it** — so a repo
missing it shows up in the digest instead of quietly accumulating.

Anything the digest lists under *merged leftovers* predates the setting (or was merged
outside a PR). Clear those with [the optional local reap](#optional-clearing-the-merged-backlog-locally).

## Config

Read [`references/sweep-config.md`](references/sweep-config.md) for the repos in scope,
each repo's protected branches, the Slack destination, and the per-run caps. **Do not
hardcode a repo list here or in a routine prompt** — that file is the single source of
truth, and changing scope means editing it in a PR.

If the invocation names a specific repo ("run branch housekeeping on
`umbraco/Umbraco-CMS-MCP-Dev`"), sweep **that** repo instead of the configured set, but
still apply every guard below.

## Step 1 — resolve targets

Read the config file and take **every** repo in its table, noting each one's configured
protected branches. Sweep them all in one run and produce **one** digest covering the lot —
not one message per repo.

## Step 2 — get each repo's facts

Per repo, fetch the repository object (github-ops → *Get repo metadata*; on the MCP path
that's `search_repositories` with query `repo:OWNER/NAME` and **`minimal_output: false`**,
which is required — the minimal shape omits `delete_branch_on_merge`). Record:

- **`default_branch`** — a protection guard.
- **`delete_branch_on_merge`** — if `false`, add the repo to a **"setting off"** list for
  the digest. This is the single most useful thing the sweep reports.
- **`archived`** — if `true`, skip the repo entirely and say so; you can't act on it.

## Step 3 — build the protected set (three guards)

**List the repo's branches** (github-ops → *List branches*), paging until exhausted. A
branch is protected — and skipped without comment — if **any** of:

1. it's in the repo's configured list in `sweep-config.md`, **or**
2. it equals `default_branch` from Step 2, **or**
3. its branch entry reports `protected: true` (live GitHub branch protection).

All three are checked independently. Never collapse them to one.

## Step 4 — classify each remaining branch by PR state

Build a **head-branch → newest-PR** map in as few calls as possible: list the repo's PRs
with `state: all`, sorted by `updated` descending, up to the page cap in the config. For
any branch not present in that map, do one targeted lookup filtered by
`head: OWNER:BRANCH` with `state: all` (github-ops → *List PRs*, which supports `head`).
Take the **highest-numbered** PR for the branch — a branch can have several.

| Finding | Category |
|---------|----------|
| newest PR is `open` | **OPEN** |
| newest PR is `closed` **and** has a `merged_at` | **MERGED** |
| newest PR is `closed` **and** `merged_at` is null | **CLOSED-unmerged** |
| no PR has this branch as head | **NO-PR** |

Do not infer a merge from anything other than `merged_at`. A closed PR is not a merged PR.

## Step 5 — what each category means

| Category | Action |
|----------|--------|
| **OPEN** | Leave alone, **count only** — no per-branch noise. Active work, including Dependabot. |
| **MERGED** | Report as a **leftover that should already be gone**. Do not delete. Include the PR number and link. |
| **CLOSED-unmerged** | Report for **human review** with the PR link and the branch's last-commit date — someone abandoned it, and only they know if the work matters. |
| **NO-PR** | Report for **human review** with a tree link and the last-commit date — could be work in progress or an orphan. |

For the two review categories, get the branch's last commit date (github-ops → *List
branches* already carries the commit SHA; fetch the commit if you need the date) and show
it as `YYYY-MM-DD`. It's the main signal a human uses to decide.

## Step 6 — the digest

Print the full digest to stdout **always**, then post it to the Slack channel named in
the config via the Slack integration. If Slack isn't reachable, the printed digest stands
on its own — say that you couldn't post rather than failing the run.

Shape it like this (Slack mrkdwn):

```
:broom: *Umbraco MCP branch housekeeping* — report-only

*Repos missing "Automatically delete head branches": 1*
• umbraco/Umbraco-MCP-Base — turn it on: Settings → General → Pull Requests

*Merged leftovers (safe to delete — work is already in mainline): 2*
• umbraco/Umbraco-MCP-Base  feat/thing  (PR #41)
• umbraco/Umbraco-MCP-Base  fix/other   (PR #38)

*Needs review (no auto-action): 1*
• <link|umbraco/Umbraco-MCP-Base@spike/idea> — no PR found, last commit 2026-05-02

_Kept 4 branch(es) with open PRs untouched._
```

Rules for the digest:

- **Zero findings is a result, not silence.** Say "none" per empty section.
- **Never report a cap as completeness.** If a repo had more branches than the config's
  cap, say how many you didn't classify.
- **Say when a repo failed.** A repo you couldn't list is a gap in the sweep — name it
  and carry on with the others rather than aborting the run.

## Optional: clearing the merged backlog locally

Merged leftovers only accumulate *before* the repo setting goes on, so this is a one-off,
not a routine job. If the user explicitly asks to reap them **and** you're on the local
path (`gh` available — see `github-ops`), you may delete the branches the digest listed
as **MERGED**, one at a time, echoing each. Never in a cloud routine (no tool for it),
never for any other category, and never without being asked — the sweep's default is
report-only.

## Guardrails

- **Never delete a branch that isn't category MERGED**, and only ever in the explicit
  local reap above. `CLOSED-unmerged` and `NO-PR` are human decisions, permanently.
- **All three protection guards, every run.** Config list + live default branch + live
  `protected: true`. A branch matching any one of them is untouchable.
- **`merged_at` is the only merge signal.** Not `state: closed`, not git ancestry — the
  repos squash-merge, so ancestry is wrong by construction.
- **Skip archived repos** rather than reporting phantom findings on them.
- **Report-only needs no write permission.** If a run seems to want one, something has
  drifted from this skill — stop and say so.

## Running as a scheduled routine

Weekly, on a schedule (this sweep is not event-driven, so it doesn't go through
`loop-dispatch`). Routine prompt:

```text
You are running as a cloud worker; do all GitHub work via the GitHub MCP (github-ops). Run the branch-housekeeping skill over every repo listed in its sweep-config. It is report-only — classify, then post one combined digest to the Slack channel the config names. Follow the skill's guardrails verbatim; add no policy of your own, and do not attempt to delete any branch.
```

The skill must be present in the cloud environment — keep `branch-housekeeping` (and
`github-ops`) in the `SKILLS` list of
[`cloud-skill-sync`](../../../../scripts/cloud-skill-sync/cloud-skill-sync.sh), and bump
that script's `VERSION` after changing this skill so the env cache rebuilds.
