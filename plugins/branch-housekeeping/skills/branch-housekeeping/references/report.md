# The digest — the canonical format, and posting it

Two paths produce this digest — `sweep.sh` locally, you via MCP tools in a cloud routine — so
**this file is the format's single definition.** Both must emit the same thing, or a
week-to-week comparison breaks the moment a run happens somewhere else.

- **Local path:** `sweep.sh`'s stdout **is** the digest. **Relay it verbatim** — don't rewrite,
  re-summarise, or reformat. It already matches the template below.
- **Cloud path:** build it to the template below, exactly. Same sections, same order, same
  wording, even when a section is empty.

Print it to stdout as well as posting, always. If Slack isn't reachable, the printed digest
stands on its own — **say you couldn't post** rather than failing the run.

## Destination

The Slack channel named in [`sweep-config.md`](sweep-config.md). **One message per run** — not
one per repo. Sweeping every repo in one pass exists so there's a single thing to read.

## The template

```
:broom: *Umbraco MCP branch housekeeping* — 2026-08-12

*Repos missing "Automatically delete head branches": 1*
• umbraco/Umbraco-MCP-Base — turn it on: Settings → General → Pull Requests

*Merged — safe to delete, work already in mainline: 2*
• umbraco/Umbraco-CMS-MCP-Dev  `release/18.0.2`  (PR #338)
• umbraco/Umbraco-MCP-Base  `chore/thing`  (PR #251)

*Needs review — never auto-actioned: 3*
• <https://github.com/umbraco/Umbraco-MCP-Base/compare/dev...chore/merge-main-to-dev|umbraco/Umbraco-MCP-Base@chore/merge-main-to-dev> — PR #251 merged BUT branch reused since (2 commit(s) not in dev) — NOT deleted, last commit 2026-08-06
• <https://github.com/umbraco/Umbraco-CMS-MCP-Dev/pull/99|umbraco/Umbraco-CMS-MCP-Dev@claude/install-dotnet-U6yLm> — PR #99 closed unmerged, last commit 2026-01-22
• <https://github.com/umbraco/Umbraco-CMS-MCP-Dev/tree/spike/idea|umbraco/Umbraco-CMS-MCP-Dev@spike/idea> — no PR found, last commit 2026-05-15

_Kept 18 branch(es) with open PRs untouched._
```

Empty sections keep their line and say so — `• none` for the merged list, `• none :tada:` for
the review list, and for the settings check:

```
• none — all swept repos reap merged branches at merge time :tada:
```

Two sections appear **only when they apply**, after the kept-count line:

```
*Not fully covered:*
• umbraco/Some-Repo — archived, skipped
• umbraco/Other-Repo — 12 branch(es) past the 200 cap, NOT classified

*Could not read (gap in this sweep):*
• umbraco/Whatever
```

## Per-line rules

- **Merged lines:** `repo  ` + backticked branch + `  (PR #n)`. Two spaces between fields, as
  `sweep.sh` emits.
- **Review lines:** a Slack link whose text is `repo@branch`, then the reason, then
  `last commit YYYY-MM-DD`. Link target depends on the reason — compare view for a reused
  branch, the PR for a closed-unmerged one, the tree for a no-PR one.
- **A reused branch's reason must carry its divergence and the words `NOT deleted`.** It's the
  one line a reader could otherwise mistake for something disposable.
- **Dates are `YYYY-MM-DD`.** Unknown is `unknown`, never `null` or blank.
- **Keep each line to one screen line** where you can; a long branch name is more useful intact
  than truncated, so don't cut branch names.

## Sections that must never be dropped

The failure mode is tidying the digest, so don't:

- **Zero findings is a result, not silence.** Every empty section says so.
- **The settings check** — the most actionable line, because fixing it removes the need to clean
  up at all.
- **`REUSED` stays in *needs review*.** Never promote it to the safe list.
- **Coverage gaps** — *Not fully covered* and *Could not read*. These exist so a capped or
  unreadable repo can't be mistaken for a clean one.
- **The open-PR count** — one line, no names. It tells the reader the sweep saw active work and
  deliberately left it alone.

## Naming the cleanup, without doing it

When the digest lists branches under *safe to delete*, you may say so and name the command —
`/clean-branches`, or `/clean-branches --dry-run` to preview — and then **stop**. Don't run it,
don't offer to as part of this run, and don't imply the report has dealt with anything.

Nothing in this digest describes an action taken, because the report never takes one. If you
find yourself writing "deleted" or "cleaned", something has gone wrong.

## Nothing beyond the template

No recommendations, no prioritisation, no commentary on what the branch names suggest. The
categories carry the signal, and prose is where week-to-week comparability dies.
