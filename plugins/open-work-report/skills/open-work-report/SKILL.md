---
name: open-work-report
description: >-
  Daily cross-repo overview of everything currently open — issues and PRs — collected from
  the repos **the routine itself attaches**, so this skill carries no repo list and never
  invents one. Posts one Slack digest: security bot PRs first (Dependabot security updates
  are separated from routine version bumps, since only one of them is urgent), then PRs that
  are ready to merge, blocked on CI, or waiting on a human, then per-repo listings with each
  item's age and last activity, automation labels called out so loop-owned work reads apart
  from human work, and anything untouched for 30 days flagged stale. Report-only — it reads
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
resolved scope in the digest header so the reader can see exactly what was covered.

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
| PR: no review yet, CI green | **Waiting for review** — the commonest actionable state, so it gets its own attention section |
| PR: draft | **Draft** — counted only |
| PR: bot-authored **and** security (label or advisory in body) | **Security bot PR** — listed individually, at the top |
| PR: bot-authored, routine version bump | **Bot** — counted only; add *touches an alerted package* if the optional alerts pass ran and matched |
| PR: bot-authored, security signal unreadable | **Bot, `security unknown`** — counted, and the count is said out loud |
| Item labelled `ready-for-ai`, `ai-discuss`, `auto-merge`, `generated-by-ai`, `ai-blocked`, `proto-learning` | tag the line with that label, so loop-owned work reads apart from human work |
| Item with no activity for **more than 30 days** | additionally flagged **stale** |

Read approval and merge state from the PR payload — never infer either from anything else.

## Step 5 — the digest

Print the full digest to stdout **always**, then post it to Slack
**`#daily-issue-and-pr-overview`** via the Slack integration. If Slack isn't reachable, the
printed digest stands on its own — say you couldn't post rather than failing the run.

Shape it like this (Slack mrkdwn), so a reader can compare today against yesterday at a
glance — a cross-repo attention block first, then one section per repo:

```
:clipboard: *Open work — 2026-08-05*  ·  3 repos in scope
Umbraco-CMS-MCP-Dev · Umbraco-CMS-MCP-Editor · Umbraco-MCP-Base

*:rotating_light: Security bot PRs — Dependabot-declared (2)*
• <link|Editor #75> Bump `brace-expansion` — GHSA-mh99-v99m-4gvg — open 12d
• <link|Dev #178> Bump `uuid` 11.1.0 → 14.0.0 — GHSA-w5hq-g745-h8pq — open 61d — *stale*

*:white_check_mark: Ready to merge (2)*
• <link|Dev #412> Add member-group tools — approved, CI green — `generated-by-ai`
• <link|Base #57> Fix pagination helper — approved, CI green

*:back: Changes requested (1)*
• <link|Dev #401> Refactor document tools — open 34d, last activity 2026-07-02 — *stale*

*:x: Broken CI (1)*
• <link|Editor #91> Add media type tools — 3 checks failing, awaiting review

*:eyes: Waiting for review — CI green (2 of 4 shown, oldest first)*
• <link|Dev #183> Add outputSchema to mutation tools — open 90d — *stale*
• <link|Base #228> Support pointing at a local SDK build — open 8d

*:hourglass: Stale issues, no activity 30d+ (2)*
• <link|Dev #172> Add outputSchema so consumers get types — last activity 2026-04-27
• <link|Base #121> create-umbraco-mcp-server: composer fix — last activity 2026-05-13

────────────────────────
*umbraco/Umbraco-CMS-MCP-Dev* — 6 open PRs, 14 open issues
_PRs (oldest first)_
• <link|#401> Refactor document tools — changes requested, CI green — open 34d
• <link|#412> Add member-group tools — approved, CI green — open 4d — `generated-by-ai`
_Issues (oldest first)_
• <link|#398> Media picker returns wrong variant — open 64d, last activity 2026-06-14 — `ready-for-ai`
• <link|#420> Support segment filters in content queries — open 3d — `ai-discuss`
_Bots: 4 (1 security-declared · 3 version bumps, 1 touching an alerted package) · Drafts: 1_

*umbraco/Umbraco-CMS-MCP-Editor* — 3 open PRs, 5 open issues
…

*umbraco/Umbraco-MCP-Base* — 2 open PRs, 7 open issues
…
────────────────────────
_Totals: 11 open PRs (5 bot: 1 security, 3 version bumps, 1 security unknown), 26 open issues.
Read-only report — nothing was commented on, labelled, or merged._
```

Details that keep the digest readable:

- **Short repo prefixes in the attention sections** (`Dev #412`, `Editor #75`) — up there the
  reader needs the repo, not the org; inside a repo block the bare `#412` is enough.
- **An item appears once in the attention block.** A stale PR is already in its own bucket
  carrying `*stale*`, so the stale section lists **issues only** — otherwise the same PR shows
  up twice and the counts stop meaning anything.
- **Cap *Waiting for review* at the oldest 5** and say `n of m shown`. In practice this is the
  fattest bucket (green PRs nobody has looked at yet), and an uncapped list buries the sections
  above it — which are the ones that need action today.
- **One line per item, no wrapping prose.** The per-repo blocks are a list, not a narrative.
- **The `security unknown` count appears in the totals whenever it's non-zero**, and is left
  out when it's zero — a zero doesn't need saying, a non-zero does.
- **Keep "Dependabot-declared" in the security heading**, and only mention alerted packages if
  the alerts pass actually ran. Both bits of wording exist so nobody reads an empty security
  section as "no vulnerabilities" when it only ever meant "none declared".

Rules for the digest:

- **Zero findings is a result, not silence.** Say "none" per empty section.
- **Never report a cap as completeness.** If a repo had more open items than the cap, say how
  many you didn't cover.
- **Say when a repo failed.** A repo you couldn't read is a gap in the report — name it and
  carry on with the others rather than aborting the run.
- **Nothing beyond the template.** No recommendations, no commentary on what to prioritise;
  that's where day-to-day consistency goes, and the buckets already carry the signal.
- **If the digest exceeds Slack's message limit**, post the header plus the attention sections
  as the message and put the per-repo detail in a threaded reply — never truncate silently.

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
- **One digest per run**, covering every repo in scope — not one message per repo.

## Running as a scheduled routine

Daily (this report isn't event-driven, so it doesn't go through `loop-dispatch`). Routine
prompt:

```text
You are running as a cloud worker; do all GitHub work via the GitHub MCP (github-ops). Run the open-work-report skill over the repos attached to this routine. It is report-only — collect, classify, then post one combined digest to #daily-issue-and-pr-overview. Follow the skill's guardrails verbatim; add no policy of your own, and do not comment on, label, or merge anything.
```

Attach the repos you want covered as the routine's `sources`, and add the Slack connector to
its `mcp_connections`. If you'd rather be explicit than rely on discovery, name the repos in
the prompt — Step 1 takes named repos first.

The skill must be present in the cloud environment — keep `open-work-report` (and
`github-ops`) in the `SKILLS` list of
[`cloud-skill-sync`](../../../../scripts/cloud-skill-sync/cloud-skill-sync.sh), and bump that
script's `VERSION` after changing this skill so the env cache rebuilds.
