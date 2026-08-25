# 10. Label rename — text migrated, live cutover still not done

[← Index](00-index.md)

---

While building the Phase 1/2 prototype (`graph/`), collapsing `State` down to
the literal GitHub label string (rather than a separate internal name — see
`graph/graph.ts`'s header comment) exposed a real inconsistency in the
labels themselves, not just in how the design talked about them. This file
records the renames that fell out of that, why each one is more than a
style preference, and — separately — what it takes to make any of them
real.

**Status, updated after running `worker/`'s real-agent test against the
actual live `issue-build-loop/SKILL.md` (see `worker/README.md`):** that
test surfaced this file's mapping as a live mismatch, not a hypothetical
one — `graph/` used the renamed vocabulary while the skill files still
said the old names. Step 2 below (updating the 18 files) is now done. Step
1 (renaming the label on every live repo) and step 3 (updating every
routine's trigger filter config) are **not** done, and — this is the
important part — **doing step 2 alone, without 1 and 3, makes things worse,
not better.** A real loop running today against a real GitHub repo now
instructs itself to remove/add labels spelled the new way, but the actual
label on the actual issue is still spelled the old way — so the swap
silently fails to clear the real trigger label. This must land as one
coordinated cutover (1 + 2 + 3 together) on every affected repo; until
then, don't treat "the skill files are updated" as "the rename is safe to
rely on."

`graph/constants/labels.ts` exports a `LABELS` constant as the single source of
truth for these seven strings — `graph.ts`'s `State` and
`graph/github/from-github.ts` both import from it rather than retyping the
spelling. The table below is
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

This was not a small find-and-replace, and it's only two-thirds done. A
repo-wide search turned up **14 skill/reference files across 7 plugins**
actually naming these labels (as opposed to naming the *loop*, e.g.
`auto-release-loop`, or GitHub's own unrelated native "auto-merge" PR
setting, which several files also mention and which this rename doesn't
touch): `loop-dispatch` (the routing table itself, plus its
`webhook-context.md` reference and `new-loop-routine`'s setup skill),
`issue-build-loop` (and its 3 reference files), `issue-discuss-loop` (and
its `thread-protocol.md` reference), `rework-loop`, `merge-flow`,
`auto-release-loop` (its own `SKILL.md`), `open-work-report`, and
`self-learning`'s `triage-learnings/references/routing-procedures.md`.
Actually making a live label rename real needs, at minimum:

1. Renaming the label definition in every repo it exists on. GitHub
   preserves all existing issue/PR associations on a label rename — this
   part is non-destructive. **Not done — no access to any live repo's
   labels from this repo.**
2. Updating every hardcoded string in the 14 files above to match. **Done**
   — see the file list above; verified by re-running `worker/`'s real-agent
   test against the updated `issue-build-loop/SKILL.md` (`worker/README.md`).
3. Updating every routine's trigger filter (e.g. `new-loop-routine`'s
   "Labels is one of `auto-merging`" config) — these live outside the repo,
   in the routine configuration itself, and are easy to miss in a
   file-based search. **Not done — outside this repo's reach.**
4. A window where old muscle memory (a human typing the old label name) and
   the new spelling coexist, until everyone's re-trained.

**Steps 1 and 3 being undone is now an active hazard, not just remaining
work** — see `worker/README.md`'s "coordination hazard" note. The 14 files
now instruct every loop with the new spelling while every live repo's
actual label and every routine's trigger filter still use the old one.
This needs to close (1 + 3, coordinated) before any repo relying on these
skills would work correctly, and is squarely Phase 5 territory
([07-build-phases.md](07-build-phases.md)) — not something to do
unilaterally from this repo.

## Open question this creates

The 14 skill files already being migrated forces this question sooner than
planned: should the *remaining* cutover (rename the label + update every
trigger config, per repo) land atomically per repo — every affected label
renamed and every trigger config updated in one change, per repo — or
incrementally per-loop within a repo, accepting that `loop-dispatch`'s
routing table has to carry both the old and new spelling for whichever
loops haven't migrated yet on that repo? The former is cleaner but
higher-blast-radius; the latter is safer but means the routing table
temporarily loses the consistency this rename was for — and, now, that the
skill text is already committed to the new spelling, "incremental" also
means accepting broken label swaps on every not-yet-cut-over repo in the
meantime, not just an inconsistent routing table. Added to
[08-open-questions.md](08-open-questions.md).

---

[← Index](00-index.md)
