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
  or "run skill-tighten on <path>".
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

## Step 0 — note any pre-existing changes

Run `git status` on the skill's directory before starting. If it's already dirty, say
so before making any edits of your own — the loop's edits land on top of whatever's
already there, and the user should be able to tell their own in-progress changes apart
from the loop's when they look at the final diff. This is disclosure, not a gate — it
doesn't block starting.

## Step 1 — review round

Spawn the **`skill-tightener-reviewer`** agent (defined in this plugin) against the
skill directory and this skill's own `references/` folder. It returns either
**CLEAN** or **FINDINGS**, per the agent's own output contract.

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

## Step 4 — optional verification via skill-creator

Once converged, decide whether the trim is worth the extra confidence of actually
*running* the skill rather than just reading it — the structural review never executes
anything. See "Verification" in `references/skill-creator-guide.md` for which
skill-creator mechanism to invoke and when it's worth the setup cost.

## Output

Report, regardless of outcome:
- rounds run, and what each round fixed (one line per finding)
- starting vs. final line count of `SKILL.md` — the "skinnier" signal
- **converged** or **not converged** — never blur the two
- whether Step 4 verification ran, and what it found, if it did

## Guardrails

- **Rationale still applies at apply-time.** Same rule as checklist row 10 ("Why"
  survives trimming).
- **Local edits only.** This changes files in the skill's own directory and nothing
  else; it never commits, pushes, or touches files outside that directory. Committing
  is the user's call once they've looked at the diff.
