# Skill-tightening checklist (skill-tighten)

The checklist `skill-tightener-reviewer` judges a skill against, each round. Every
check must be decidable from the skill's own files — no guessing intent, no "this
could probably be shorter" without pointing at what to cut.

Distilled from the Anthropic `skill-creator` plugin's own "Skill Writing Guide" (anatomy,
progressive disclosure, writing style), narrowed to the checks a reviewer can grade
mechanically round after round. `skill-creator` itself is the broader tool — drafting a
new skill, running evals, optimizing trigger descriptions — and stays the better choice
for those. If a round hits a case this list doesn't cover, read
[`skill-creator-guide.md`](./skill-creator-guide.md) — it points at exactly which
section of `skill-creator` to read for a structural judgment call, rather than
duplicating skill-creator's own content here.

| # | Check | How to judge |
|---|-------|--------------|
| 1 | **Description carries the trigger** | The frontmatter `description` states what the skill does *and* when to use it, on its own. The body doesn't need a separate section restating the same trigger conditions — if it has one, that's duplication. |
| 2 | **No restated flow summary** | A section like "Guardrails," "Overview," or a `/goal` block should not simply re-narrate steps already given in full elsewhere in the body with no new information. Keep only the part of such a section that states an invariant, dependency, or consequence the steps don't already spell out. |
| 3 | **A concept is defined once** | If a term, severity, or output contract (e.g. "PASS/BLOCK", a status enum) is defined in one file — a reference doc, or a called agent's own definition — the calling skill should point at it, not redefine it in its own words. |
| 4 | **SKILL.md is a router, not a manual** | See [`generic-skill-shape.md`](./generic-skill-shape.md)'s "router test" for the full litmus test. |
| 5 | **Fixed, zero-judgment procedures are scripts, not prose** | See [`generic-skill-shape.md`](./generic-skill-shape.md)'s "determinism test" for the full test. |
| 6 | **Fixed output material belongs in assets/, not inline** | See [`generic-skill-shape.md`](./generic-skill-shape.md)'s "output-material test" for the full test. |
| 7 | **Dependencies stated once** | A required skill, tool, or piece of config is named prominently in one place (frontmatter, or a dedicated line) — not re-declared three different ways across the file. |
| 8 | **Every bundled file is used** | Every other file in the skill's directory — wherever it lives, not just under the conventional `references/`, `scripts/`, `assets/` names — is actually pointed to from `SKILL.md`. An orphaned file nothing reads is dead weight — remove it or wire it in. |
| 9 | **Every remaining sentence is load-bearing** | For each sentence or paragraph: does removing it change correctness, remove a "why" that helps handle an edge case, or lose something the trigger needs? If none of those, cut it. |
| 10 | **"Why" survives trimming** | A rule that currently has its reasoning explained should keep that reasoning — don't collapse an explained rule into a bare imperative just to save lines. Cutting duplication and cutting rationale are different operations; only do the first. |
| 11 | **Description doesn't leak mechanism detail** | The frontmatter `description` should only carry what the skill does, when to use it, when *not* to (disambiguation from a similar tool), and trigger phrases. A clause explaining how the mechanism works internally (an enumeration of internal categories/checks, implementation detail) belongs in the body, not here — it doesn't help decide whether to invoke the skill. This matters more than ordinary body bloat: the description is loaded on every turn the skill catalog is shown, not just when the skill triggers, so its length is a constant tax. If it looks long, check `skill-creator-guide.md` for skill-creator's own metadata-size guidance rather than judging by a number here. |

## Adding checks

Append a row (same shape as the others) when a new kind of bloat shows up in a real
skill that this list didn't catch. Keep each check objective and file-observable.
