# Release-PR review checklist (auto-release-loop)

The pre-publish sanity gate for `auto-release-loop` (Step 2.5). Because publishing is
irreversible and un-gated by a human, review the release PR against **every** check
below before merging/tagging/publishing.

- A **BLOCK** finding **stops the publish** — comment the finding on the triggering
  issue, leave the PR open, and do **not** merge/tag/publish.
- A **WARN** finding does **not** block — note it in the completion comment so a human
  can glance at it.
- Judge each check from what's observable on the PR (title/branch/issue, the diff, CI,
  mergeability). If a check can't be evaluated, treat it as a BLOCK and say why.
- **Reason beyond the list.** These checks are a *floor*, not a ceiling — also step back
  and ask *"does anything about this PR look wrong or risky to ship?"* Flag anything off
  even when no row covers it (BLOCK if clearly wrong, WARN if merely suspect), and add a
  check for it below so it's explicit next time.

> **This list is meant to grow.** When a release goes wrong in a new way, add a row —
> keep it objective and PR-observable, with a clear severity. See *Adding checks* below.

| # | Check | Severity | How to judge |
|---|-------|----------|--------------|
| 1 | **Version is correct & intentional** | BLOCK | The version in the issue title matches what the PR bumps the version files to. It's a sane increment from the current latest release — no downgrade, no accidental skipped number. |
| 2 | **Pre-release vs latest is right** | BLOCK | A version with a `-alpha`/`-beta`/`-rc` suffix must publish as a **prerelease** (never as "latest"); a stable version (no suffix) must **not** be flagged prerelease. Don't ship a beta as latest or a stable as a pre-release. |
| 3 | **Correct release channel/line** | BLOCK | The version targets the right line (e.g. the v18 line vs an LTS v17 line) and the branch/base match that line. |
| 4 | **PR scope is release-only** | BLOCK (unexpected code) / WARN (large but explained) | A release PR should be essentially version-file bumps + changelog (+ any security fixes it rolled in). Unexpected source/behaviour changes or files outside the expected set → BLOCK. A large-but-accounted-for diff → WARN. |
| 5 | **Mergeable — no conflicts** | BLOCK | The PR reports mergeable with no conflicts against `main`. If it's behind `main`, it must be updated and re-greened — never force-merged. |
| 6 | **Correct base & source branch** | BLOCK | Targets `main`, from `release/<version>` cut off `dev` (gitflow). Not a stray branch, not the wrong base. |
| 7 | **CI genuinely green** | BLOCK | Every required check passed — not pending, not a should-have-run check that was skipped. Re-confirm; never trust a bypassing auto-merge. |
| 8 | **Changelog updated & matches** | WARN | The changelog / release notes were updated and reference this version. |

## Adding checks

Append a row above with:
- a short **name**,
- a **severity** (BLOCK = never publish if it fails; WARN = note but proceed),
- a concrete, **PR-observable** "how to judge".

Keep checks objective — the reviewer should be able to decide from the PR, its diff, the
issue, CI, and mergeability, without guessing intent.
