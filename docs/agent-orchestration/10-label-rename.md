# 10. Label rename — proposed, not yet executed

[← Index](00-index.md)

---

While building the Phase 1/2 prototype (`graph/`), collapsing `State` down to
the literal GitHub label string (rather than a separate internal name — see
`graph/graph.ts`'s header comment) exposed a real inconsistency in the
labels themselves, not just in how the design talked about them. This file
records the renames that fell out of that, why each one is more than a
style preference, and — separately — what it would actually take to make
any of them real. **Nothing on GitHub is renamed yet.** `graph/` is written
against the proposed names as its target; the live labels in every repo
are still spelled the old way.

`graph/constants/labels.ts` exports a `LABELS` constant as the single source of
truth for these seven strings — `graph.ts`'s `State` and `translate.ts`
both import from it rather than retyping the spelling. The table below is
the same mapping in prose; if the two ever disagree, `LABELS` in code is
authoritative and this file is out of date.

## The two inconsistencies

**1. Command-form vs. state-form.** Three labels already read as an
ongoing *condition* (adjectival): `ready-for-ai`, `generated-by-ai`,
`ai-blocked`. Four read as an *instruction* (imperative): `auto-release`,
`ai-discuss`, `auto-rework`, `auto-merge` — "please do this." A tracked
`State` has to describe a condition, not a command, so the second group
gets the gerund form: `auto-releasing`, `ai-discussing`, `auto-reworking`,
`auto-merging`.

**2. `ai` as suffix vs. prefix.** Within the family of labels describing an
issue's relationship to AI-authored work, two put `ai` at the end
(`ready-for-ai`, `generated-by-ai`) and two put it at the front
(`ai-blocked`, and now `ai-discussing`). Renamed the suffix pair to prefix
form: `ai-ready`, `ai-generated`.

**Deliberately not renamed into the `ai-*` family:** `auto-releasing`,
`auto-reworking`, `auto-merging`. Those describe a request for a specific
automated git action, not a claim about AI authorship of the issue — a real
semantic line, not a spelling accident, so `auto-*` stays a separate,
intentional namespace.

## The full mapping

| Today (live) | Proposed | Used by |
|---|---|---|
| `ready-for-ai` | `ai-ready` | `issue-build-loop` (trigger), `loop-dispatch` |
| `generated-by-ai` | `ai-generated` | `issue-build-loop` (outcome) |
| `ai-blocked` | *(unchanged)* | `issue-build-loop` (outcome) |
| `auto-release` | `auto-releasing` | `auto-release-loop`, `loop-dispatch` |
| `ai-discuss` | `ai-discussing` | `issue-discuss-loop`, `loop-dispatch` |
| `auto-rework` | `auto-reworking` | `rework-loop`, `loop-dispatch` |
| `auto-merge` | `auto-merging` | `merge-flow`, `loop-dispatch` |

## What executing this for real actually costs

This is not a small find-and-replace. A repo-wide search turns up **18
skill/reference files across 8 plugins** naming these labels today:
`loop-dispatch` (the routing table itself, twice), `issue-build-loop` (and
its 3 reference files), `rework-loop`, `issue-discuss-loop` (and its
reference file), `merge-flow`, `auto-release-loop` (and 2 reference files,
including the `release-reviewer` agent definition), plus incidental
mentions in `github-ops`, `dependabot-rollup`, `open-work-report`, and
`self-learning`'s `triage-learnings`. Actually renaming a live label means,
at minimum:

1. Renaming the label definition in every repo it exists on. GitHub
   preserves all existing issue/PR associations on a label rename — this
   part is non-destructive.
2. Updating every hardcoded string in the 18 files above to match.
3. Updating every routine's trigger filter (e.g. `new-loop-routine`'s
   "Labels is one of `auto-merge`" config) — these live outside the repo,
   in the routine configuration itself, and are easy to miss in a
   file-based search.
4. A window where old muscle memory (a human typing the old label name) and
   the new spelling coexist, until everyone's re-trained.

That's real, coordinated work touching production automation across every
repo these loops run on — squarely Phase 5 territory
([07-build-phases.md](07-build-phases.md)), not something to fold into this
design PR. `graph/` describes the target now, precisely so Phase 5 has an
unambiguous spec to migrate toward, rather than discovering this
inconsistency mid-migration.

## Open question this creates

Should the rename land as a single atomic cutover (rename the label +
update all 18 files + update every trigger config in one coordinated
change), or incrementally per-loop, accepting that `loop-dispatch`'s
routing table has to carry both the old and new spelling for whichever
loops haven't migrated yet? The former is cleaner but higher-blast-radius;
the latter is safer but means the routing table temporarily loses the
consistency this rename was for. Added to
[08-open-questions.md](08-open-questions.md).

---

[← Index](00-index.md)
