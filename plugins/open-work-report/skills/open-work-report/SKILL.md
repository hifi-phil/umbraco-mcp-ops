---
name: open-work-report
description: >-
  Daily cross-repo overview of everything currently open — issues and PRs — collected from
  the repos **the routine itself attaches**, so this skill carries no repo list and never
  invents one. Posts a **counts-only summary** to Slack with **one threaded reply per repo**
  underneath, so the channel stays glanceable and the detail sits where you'd go looking for
  it. Every Dependabot PR rolls up to a single line per repo — with the security-declared ones
  called out by number, since only those are urgent — while human PRs get a line each, bucketed
  as ready to merge, changes requested, broken CI, or waiting for review, carrying age,
  automation labels, and a stale flag past 30 days. Report-only — it reads
  GitHub and writes nothing there, so it needs read scopes only; all GitHub work goes through
  the required `github-ops` skill, so there's no token to configure and it runs as a
  scheduled cloud routine. Trigger on "what's open across the repos", "run the open work
  report", "daily issue and PR overview", "summarise open issues and PRs", "what needs my
  attention across the MCP repos".
---

# open-work-report

Every other loop here acts on a *single* event — one issue labelled, one PR reviewed — and
`branch-housekeeping` looks only at branches. Nothing answers the plain daily question:
**what is open across all these repos right now, and what of it needs a human today?** So
approved, CI-green PRs sit unmerged because nobody noticed, and issues quietly age out.

**This skill has no repo list.** Its scope is whatever the routine gives it, and if it can't
resolve a scope it says so and stops rather than guessing — see
[Step 1](#step-1--resolve-scope-from-the-routines-context). That's the one thing to
understand before running it: scope lives in the routine, not in this file.

## Runtime & auth

Every GitHub action here — listing issues and PRs, reading review and check state, reading a
PR body — goes through the **`github-ops`** skill, which owns the local-vs-web mechanism
(this skill names the operation; `github-ops` has the command or tool). Locally that's `gh`;
in a cloud routine it's the GitHub MCP server, authenticated by the connected GitHub App.
**No `GH_TOKEN`, no webhook, nothing to configure.**

> **`github-ops` must be installed for this report to run.**

Needed permissions on the connected App: `metadata: read`, `issues: read`,
`pull_requests: read`. This report needs **no write scope at all**.

## Step 1 — resolve scope from the routine's context

Take the repos from the context you were given, in this order of precedence:

1. **Repos named in the invocation or the routine prompt win.** "run the open work report on
   `umbraco/Umbraco-CMS-MCP-Dev`" scopes the run to that repo, and a routine prompt that
   lists repos is naming them deliberately.
2. Otherwise **enumerate the repos this session has attached** — a routine's `sources` are
   checked out for it. For each checkout directory at the workspace root, read its `origin`
   URL (`git -C <dir> remote get-url origin`); if `git` isn't usable, read `<dir>/.git/config`
   directly, because the cloud path is MCP-only for GitHub work and the CLI can't be assumed.
   Normalise each URL to `owner/repo` and dedupe.
3. If the turn carries a `<github-trigger-context>` block, include its
   `repository.full_name` too.
4. **Nothing resolved → say so and stop.** No hardcoded fallback, no repo list from memory.
   An empty scope is a configuration problem worth surfacing; a silently invented scope
   produces a confident report about the wrong repos, which is worse than no report.

Then, per repo, fetch the repository object (github-ops → *Get repo metadata*) and **skip
archived repos, naming them** — you can't act on them, so findings there are noise. Echo the
resolved scope in the summary message's header so the reader can see exactly what was covered.

## Step 2 — collect the open work

Per repo, in as few calls as you can:

- **Open issues** — github-ops → *List issues by label/state* with `state: open`, paging to
  the cap below. **Drop any entry that carries a `pull_request` field.** GitHub's issues API
  returns pull requests as issues, so skipping this counts every PR twice and inflates the
  whole report — it's the one mistake that quietly ruins the numbers.
- **Open PRs** — github-ops → *List PRs* with `state: open`, paging to the cap.

Ages come from `created_at` and `updated_at`, which those payloads already carry — no extra
calls. Show dates as `YYYY-MM-DD` (matching the `branch-housekeeping` digest) and put the run
date in the header, so "open 34d" is interpretable weeks later.

Caps per repo per run: **100 issues**, **100 PRs**, **30 PRs enriched** in Step 3. They exist
to bound a run, not to define completeness — if a repo has more, say how many you didn't
cover.

## Step 3 — enrich the PRs

**Human PRs** (not bot-authored, not draft): github-ops → *Get PR* for the review decision
and mergeable state, and *CI / check-run status* for the checks. Drafts are counted, not
detailed, so they don't need this — which is what keeps the call cost down.

**Bot PRs — separate security updates from routine version bumps.** These look identical in a
PR list and matter completely differently, so classify every bot PR. The signal comes from the
PR itself, because `list_dependabot_alerts` needs a scope the Claude GitHub App doesn't have
on the cloud path — that's why `dependabot-rollup` is local-only:

1. A **security label**, if the repo applies one (`security`, `dependabot-security`).
2. The **PR body**, which Dependabot writes differently for the two kinds. A security update
   cites the advisory: a `GHSA-…` or `CVE-…` id, a *"Vulnerabilities fixed"* section, or
   *"sourced from … security advisories"*. A routine bump carries release notes and changelog
   links and nothing else. Read the body via github-ops → *Get PR*, within the same cap.
3. **Neither signal readable → report it as `security unknown`, never as routine.** Filing an
   unread security bump under "version bumps" is the only misclassification here that costs
   anything real, so an honest unknown is the better output. State how many were unknown.

**Say what that signal actually means, and don't overclaim.** It identifies PRs *Dependabot
raised as security updates* — not every bump that happens to fix a vulnerable package. On
`Umbraco-CMS-MCP-Editor` (2026-08-05) PRs bumping `hono` and `ip-address` cited no advisory
yet both packages had open Dependabot alerts, so a purely body-driven read would call them
routine. That's why the section is titled *Dependabot-declared* rather than "all security
work": the report is honest about the boundary instead of implying a clean bill of health.

**Where alerts *are* readable** — the local `gh` path, or a cloud App that has been granted
the scope — do one extra pass per repo (github-ops → *Dependabot alerts*, `state: open`), and
mark any bot PR whose bumped package matches an open alert as *touches an alerted package*.
Treat it as an addition to the declared-security list, never a replacement, and if alerts
aren't readable simply leave the marker off — silence there is the accurate output.

Carry each bot PR's `updated_at` as well: a security PR that's been sitting for weeks is
usually the most actionable line in the whole digest.

## Step 4 — classify

| Finding | Bucket |
|---------|--------|
| PR: checks green **and** approved **and** no conflicts | **Ready to merge** |
| PR: review decision is changes-requested | **Changes requested** — back with the author |
| PR: one or more checks failing | **Broken CI** |
| PR: no review yet, CI green | **Waiting for review** — the commonest actionable state, so it gets its own count in the summary |
| PR: draft | **Draft** — counted only |
| PR: bot-authored **and** security (label or advisory in body) | **Security bot PR** — listed individually, at the top |
| PR: bot-authored, routine version bump | **Bot** — counted only; add *touches an alerted package* if the optional alerts pass ran and matched |
| PR: bot-authored, security signal unreadable | **Bot, `security unknown`** — counted, and the count is said out loud |
| Item labelled `ready-for-ai`, `ai-discuss`, `auto-merge`, `generated-by-ai`, `ai-blocked` | tag the line with that label, so loop-owned work reads apart from human work |
| Item with no activity for **more than 30 days** | additionally flagged **stale** |

Read approval and merge state from the PR payload — never infer either from anything else.

## Step 5 — post it: a summary, then one thread reply per repo

Print everything to stdout **always**, then post to Slack `#daily-issue-and-pr-overview`:

1. **One parent message that is a summary only** — counts, no item names.
2. **One threaded reply per repo**, in scope order.

The split exists because a daily report is read in two modes. In the channel you want to know
whether today needs you at all, which is a handful of numbers; in the thread you want the
detail, and only for the repo you actually work on. Putting item-level detail in the parent
made the report a wall nobody read — the shape below is the fix, so keep the parent numeric
even on a quiet day.

If Slack isn't reachable, the printed output stands on its own — say you couldn't post rather
than failing the run. If the parent posts but a reply fails, name the repo whose reply is
missing.

### The parent message

```
:clipboard: *Open work — 2026-08-06*  ·  4 repos
*Needs action:* :rotating_light: 6 security bot PRs · :x: 4 broken CI · :white_check_mark: 0 ready to merge · :back: 0 changes requested
*Waiting:* :eyes: 9 PRs for review · :memo: 20 open issues (2 stale 30d+)
*Volume:* 31 open PRs, 22 of them Dependabot
_Per-repo detail in thread_ :thread:
```

- **Numbers only — no issue or PR names.** A name in the parent is a name everyone scrolls
  past; the thread is where names earn their place.
- **Keep the zeroes.** `0 ready to merge` is information at a glance, and dropping the line
  makes a quiet day look like a broken run.
- **Security first when it's non-zero** — it's the only count that can be urgent.

### One threaded reply per repo

```
*umbraco/Umbraco-CMS-MCP-Dev* — 5 PRs + 6 Dependabot · 5 issues
:x: <link|#334> Upgrade v17/dev to 17.6-rc — 1 check failing — 9d
:x: <link|#351> Prune .claude/.rulesync tooling — 1 check failing — 8d
:eyes: <link|#183> Add outputSchema to mutation tools — green — 90d *stale*
:eyes: <link|#314> Upgrade to Umbraco 18.1.0-rc — green — 13d
:package: *Dependabot: 6* — 2 security-declared (<link|#363>, <link|#178>), 4 version bumps
:memo: *Issues: 5*
• <link|#172> Add outputSchema so consumers get types — 100d *stale* — `enhancement`
• <link|#329> Prune .claude/.rulesync tooling — 11d — `ready-for-ai`
• <link|#333> Upgrade v17/dev to 17.6-rc — 9d — `generated-by-ai`
```

- **One line per human PR**, prefixed with its bucket emoji and ordered urgent → quiet:
  `:white_check_mark:` ready to merge, `:back:` changes requested, `:x:` broken CI, `:eyes:`
  waiting for review. Title, the state that put it in that bucket, its age, `*stale*` if it
  qualifies, and its loop labels — nothing else.
- **Dependabot rolls up to a single line.** Never one line per bump. This is the change that
  makes the report readable at all: bot PRs are usually the clear majority of what's open (22
  of 31 on 2026-08-05), so enumerating them buries every item a human can act on. Give the
  count, then the **security-declared ones by number** — those are the only bot PRs anyone
  opens on purpose — plus the version-bump count, the `security unknown` count when non-zero,
  and the alerted-package count only if that pass actually ran.
- **One line per issue**, same treatment as the human PRs: title, age, `*stale*` if it
  qualifies, and **every label it carries** — on an issue the labels *are* the state, so
  `bug` and `enhancement` matter as much as the automation ones. Oldest first, since age is
  what makes a backlog item interesting. Only Dependabot rolls up.
- **A repo with nothing open still gets a reply** saying so — silence reads as a failed run.
- **Keep each line to one screen line.** Long titles get cut at a word boundary with `…`; a
  title chopped mid-word (`…duplicated fr`) reads like a bug in the report.

Rules for the whole post:

- **Zero findings is a result, not silence.** Say "none" rather than dropping a line.
- **Never report a cap as completeness.** If a repo had more open items than the cap, say how
  many you didn't cover.
- **Say when a repo failed.** A repo you couldn't read is a gap in the report — name it in the
  parent and carry on with the others rather than aborting the run.
- **Nothing beyond the template.** No recommendations, no commentary on what to prioritise;
  the buckets already carry the signal, and prose is where day-to-day comparability dies.
- **Keep "security-declared" wording on the Dependabot line**, and mention alerted packages
  only if the alerts pass ran — so nobody reads a zero as "no vulnerabilities" when it only
  ever meant "none declared".

## Guardrails

- **Read-only, always.** Never comment, label, close, merge, or push. If a run seems to need a
  write scope, something has drifted from this skill — stop and say so.
- **No hardcoded repo list, ever.** Scope comes from the routine's context (Step 1). If
  discovery fails, fix the routine, don't paste repos in here.
- **Never infer approval or a merge.** Read them from the PR payload.
- **A bot PR is security-or-unknown, never silently routine.** The unknown bucket exists
  precisely so an unread body can't hide a security bump.
- **Never present the security section as a vulnerability audit.** It reports what Dependabot
  declared (plus alert correlation when that's readable); an empty section means "nothing
  declared", and saying more than that would be presenting an assumption as a verified fact.
- **Skip archived repos**, naming them, rather than reporting phantom findings.
- **One thread per run** — a summary parent plus one reply per repo. Never several top-level
  messages, and never per-item detail in the parent.

## Running as a scheduled routine

Daily (this report isn't event-driven, so it doesn't go through `loop-dispatch`). Routine
prompt:

```text
You are running as a cloud worker; do all GitHub work via the GitHub MCP (github-ops). Run the open-work-report skill over the repos attached to this routine. It is report-only — collect, classify, then post the counts-only summary to #daily-issue-and-pr-overview with one threaded reply per repo underneath, exactly as the skill's Step 5 templates it. Follow the skill's guardrails verbatim; add no policy of your own, and do not comment on, label, or merge anything.
```

Attach the repos you want covered as the routine's `sources`, and add the Slack connector to
its `mcp_connections`. If you'd rather be explicit than rely on discovery, name the repos in
the prompt — Step 1 takes named repos first.

The skill must be present in the cloud environment — keep `open-work-report` (and
`github-ops`) in the `SKILLS` list of
[`cloud-skill-sync`](../../../../scripts/cloud-skill-sync/cloud-skill-sync.sh), and bump that
script's `VERSION` after changing this skill so the env cache rebuilds.
