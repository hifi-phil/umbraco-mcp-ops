---
name: skill-tighten
description: >-
  Iteratively trims a Claude Code skill down to exactly what it needs: repeatedly
  reviews the skill's entire directory against a concrete checklist, then applies the
  fixes, repeating until two consecutive rounds find nothing left to change — or a hard
  iteration cap is hit and reported as non-convergence, never silently accepted as
  done. Use on an existing skill that's grown organically
  and needs trimming to its skinniest correct form. Not for drafting a brand-new skill
  from scratch or running eval benchmarks (use skill-creator for that) or for a one-off
  spot check (just ask for a review of the file). Trigger on "tighten this skill",
  "trim <skill> down to essentials", "make this skill skinny", "boil this skill down",
  or "run skill-tighten on <path>" — and whenever the user says a skill has grown
  bloated, repetitive, or too long for what it does, even if they never use the word
  "tighten".
---

# skill-tighten

A single review pass tells you what's wrong right now, but the fix itself can introduce
a new problem (an edit that removes duplication can also strip a rationale worth
keeping), and review output isn't perfectly deterministic — one clean pass could be a
lucky read rather than genuinely nothing left. Two consecutive clean rounds, from a
reviewer with no memory of what was just changed, protects against both.

## Input

Needs the path to a skill's directory (the one containing its `SKILL.md`). If the user
names a skill without a path, resolve it from context (e.g. "the skill we were just
looking at") rather than asking — only ask if it's genuinely ambiguous which skill they
mean.

## Config

| Thing | Value |
|-------|-------|
| Clean-streak target | **2** consecutive rounds with no findings |
| Hard iteration cap | **8** rounds |
| Reviewer | fresh `skill-tightener-reviewer` agent every round |
| Verification model | different from whichever model is running this skill right now — check your own identity. Default: `opus`, unless you *are* already Opus, then `sonnet`. |

## Step 0 — note any pre-existing changes, snapshot the directory

Run `git status` on the skill's directory before starting. If it's already dirty, say
so before making any edits of your own — the loop's edits land on top of whatever's
already there, and the user should be able to tell their own in-progress changes apart
from the loop's when they look at the final diff. This is disclosure, not a gate — it
doesn't block starting.

Also copy the skill's directory to a scratch location (`cp -r <skill-dir>
"$(mktemp -d)/snapshot"`) regardless of git state. Step 5's lossless review diffs
against this snapshot, not git history, so it works the same whether or not the
directory was already dirty.

## Step 1 — review round

Spawn the **`skill-tightener-reviewer`** agent (defined in this plugin) against the
skill directory and this skill's own `references/` folder — `tightening-checklist.md`
(the checks it grades against) and `generic-skill-shape.md` (the router, determinism,
and output-material tests behind checklist rows 4-6). It returns either **CLEAN** or
**FINDINGS**, per the agent's own output contract.

## Step 2 — apply

If the round had findings, apply every one directly (edit the files) — each finding
already specifies the fix, so this step is mechanical, not another judgment call. Then
continue to Step 3 regardless of outcome — every round is checked for convergence, not
just clean ones.

## Step 3 — convergence check

- Round was **CLEAN** → increment the clean-streak. Streak reaches the target (see
  Config) → stop. Report **converged**.
- Round had **findings** → reset the streak to 0 (the fix was already applied in Step 2).
- Round count reaches the cap (see Config) without hitting the clean-streak target → stop. Report
  **not converged** — a distinct outcome, not a quiet "good enough." Show the last two
  rounds' findings side by side: if the same location keeps getting flagged for
  contradictory reasons (a fix in round N gets undone or re-flagged in round N+2),
  that's oscillation — say so explicitly, since it means a human needs to break the tie,
  not run another round.
- Otherwise → return to Step 1 for a fresh round over the now-edited files.

## Step 4 — skill-creator structural validation

Run this whether the loop converged or hit the cap — validate whatever the final
state is either way. Locate the installed `skill-creator` plugin by globbing
`**/plugins/skill-creator/skills/skill-creator/SKILL.md` under the plugin marketplace
directory (typically `~/.claude/plugins/marketplaces/`). If it isn't installed, skip
this step and Step 6, and say so in the Output — the tightening loop's result still
stands without them.

Otherwise spawn the **`skill-creator-validator`** agent (defined in this plugin)
against the skill directory and that `SKILL.md`, using the Verification model (see
Config) — a different model than the one that ran the tightening rounds, so it isn't
grading its own blind spots. It returns **CLEAN** or **FINDINGS**.

Apply findings directly (mechanical, same as Step 2) — except a finding that would
add infrastructure the skill didn't already have (a new script, a new bundled file
with no prior equivalent). Defer those instead: list them in the Output and ask the
user, since skill-tighten trims an existing skill, it doesn't grow it with new scope.

This is a single audit-and-fix pass either way, not a loop to convergence —
skill-creator's guide is a quality bar, not something that oscillates round to
round the way duplication does.

## Step 5 — lossless review

Spawn the **`lossless-reviewer`** agent (defined in this plugin) against the current
skill directory and the Step 0 snapshot, using the Verification model (see Config).
It returns **LOSSLESS** or **FINDINGS** — every line any round removed, checked for
whether it's genuinely covered elsewhere or just gone.

If findings, restore or fix each one directly, then run the lossless-reviewer once
more against the updated skill and the same Step 0 snapshot. Two rounds is enough
here — this step catches "did tightening cut too far," not "is there still
duplication," so it doesn't need the main loop's clean-streak/cap machinery. If the
second round still finds something, report it as **lossless review incomplete**
rather than silently looping — a human should look.

## Step 6 — optional deeper verification via skill-creator

Once Steps 4-5 are done, decide whether the trim is *also* worth the extra confidence
of actually **running** the skill rather than just reading it. See "Verification" in
`references/skill-creator-guide.md` for which heavier skill-creator mechanism to
invoke, when it's worth the setup cost, and how this step differs from the mandatory
Steps 4-5.

## Output

Report, regardless of outcome:
- rounds run, and what each round fixed (one line per finding)
- starting vs. final line count of `SKILL.md` — the "skinnier" signal
- **converged** or **not converged** — never blur the two
- skill-creator validation (Step 4): what it found, what was fixed directly, and
  what was deferred to the user as scope-expanding (with the finding, so they
  can decide)
- lossless review (Step 5): **lossless**, or what was found + restored, or
  **incomplete** if the second round still found something
- whether Step 6's optional deeper verification ran, and what it found, if it did

## Guardrails

- **Rationale still applies at apply-time.** Same rule as checklist row 10 ("Why"
  survives trimming).
- **Local edits only.** This changes files in the skill's own directory and nothing
  else; it never commits, pushes, or touches files outside that directory. Committing
  is the user's call once they've looked at the diff.
