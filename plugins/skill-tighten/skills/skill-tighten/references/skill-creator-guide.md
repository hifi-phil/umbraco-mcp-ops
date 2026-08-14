# Where to find skill-creator's guidance (pointers, not copies)

`skill-creator` is the authority on skill structure and has working machinery worth
invoking — this file only says **which part to read or run, and when**. It never
restates skill-creator's actual content (line-count thresholds, exact commands, etc.):
copying those here would just be a second place for them to go stale the moment
skill-creator's own numbers change — the same duplication problem this tool exists to
catch elsewhere.

## Structure best practices — read, don't guess

For anatomy of a skill (SKILL.md vs. `scripts/`/`references/`/`assets/`), progressive
disclosure (the metadata/description size guideline, SKILL.md's line-count ceiling,
when a reference file needs its own index so it isn't read cold), and writing style —
read skill-creator's own **"Skill Writing Guide"** section (in its `SKILL.md`)
directly, every time you need it. Don't rely on a remembered number; read it fresh so
you're always judging against skill-creator's current thresholds, not a stale copy of
them.

Use when checklist row 4 ("SKILL.md is a router, not a manual"), row 8 ("Every bundled
file is used"), or row 11 ("Description doesn't leak mechanism detail") needs a
concrete threshold to decide against.

## Verification — invoke these, don't just read about them

1. **Blind comparison.** skill-creator's "Advanced: Blind comparison" section
   (`agents/comparator.md` + `agents/analyzer.md`). Use after skill-tighten converges,
   for a substantial trim (rough trigger: SKILL.md's line count dropped by more than
   ~20%, or a whole section/step was cut or merged) — it confirms the tightened
   version still behaves the same as the pre-trim snapshot on real prompts, which the
   structural review can't do since it never runs the skill.
2. **Description-optimization loop.** skill-creator's "Description Optimization"
   section. Use after convergence, only if an applied fix reworded the frontmatter
   `description` — it re-validates that the new wording still triggers as well as the
   old one, rather than assuming shorter is equally good.

Both are optional add-ons gated by whether the trim justifies the setup cost — not a
condition of convergence.

## Not relevant here

skill-creator's intake interview / from-scratch drafting flow (for a skill that
doesn't exist yet) and its packaging script (for distributing a `.skill` file). Skip
both — skill-tighten only ever operates on a skill that already lives in its own repo.
