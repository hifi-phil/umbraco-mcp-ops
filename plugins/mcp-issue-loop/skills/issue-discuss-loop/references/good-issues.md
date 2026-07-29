# What to actually say

The substance: what you're arguing for, the order you work in, and how to write it. Read this
before composing a comment or rewriting a body.

## The goal — consensus on the simplest change

The conversation is done when **you and the user agree on the smallest, most surgical change that
actually solves the problem.** Not the most thorough design, not the most future-proof one. The
one that touches the fewest files, adds the fewest new concepts, and leaves the repo easier to
understand than it found it.

Every round, argue for that:

- **Reuse before adding.** If something already does most of the job, extend it — an existing
  function, helper, test, script, or skill. A new file needs a reason.
- **Follow the pattern that's already there.** Read the nearest equivalent code and do it that
  way. Consistent beats clever.
- **Ask what can be deleted.** Sometimes the answer is "remove the thing that made this hard",
  not "add a thing beside it".
- **Fewest moving parts wins.** Given two plans that both work, recommend the smaller one and say
  plainly why the other is more than we need.
- **Cut speculative work.** "We'll want this later" is not a reason to build it now.
- **Name the surgical edit.** The plan should be able to say *these files, these lines*. If it
  can't, the problem isn't understood yet — ask, don't write a plan.

**Consensus, not compliance.** Agree because you got to the right answer, not because the user
said so. If they're proposing something more complicated than the problem needs, say so and show
the smaller version. If they push back with a good reason, take it. When you genuinely can't
agree, **name the question you're stuck on** rather than quietly picking a side.

## Problem, then requirements, then plan

For anything code-shaped, work in this order and don't skip ahead.

**1. The problem.** What's actually wrong or actually missing? Who hits it, and when? Often the
stated problem is a symptom and fixing the cause is smaller than fixing the symptom — say which
one you're doing.

**2. The requirements.** Short, concrete, **testable**, and explicit about what's **out of
scope**. If a requirement can't be checked by a test or by looking at the thing, it isn't a
requirement yet. Settle edge cases and failure behaviour here, not after the code is written.

**3. The plan.** Only now, and following good practice:

- Follow the existing pattern; **one concern per change** (no refactor riding along with a fix, no
  fix hidden inside a refactor).
- **Keep it local** — one place beats five; if it can't be local, say why.
- **No abstraction until it's earned.** Two cases don't need a framework.
- **No new dependency** without a reason worth writing down.
- **Don't hand-edit generated code**; fix the generator's input instead.
- **Say how it's tested** — which test proves it, and which existing test would have caught it.
- **Name the files.** The plan should read like something you can start on straight away.

**Read the code before writing any of it.** Open the file the issue is about, its neighbours, and
its tests. Read whatever conventions the repo writes down (`CLAUDE.md`, a skill, a contributing
guide). A plan written from the issue title alone is a guess, and guesses are what this loop
exists to remove.

If a plan contradicts a convention the repo has written down, **say so** — either the plan is
wrong or the convention needs an issue of its own.

## Writing style — this matters as much as the content

- **Simple, domain-specific language.** The words already used for these things: issue, label,
  loop, skill, PR, CI, test, tool, endpoint. No invented abstractions, no architecture-speak.
- **Short sentences. Plain English.** No hedging, no filler, no lists of options nobody asked for.
- **Explain properly.** Say *why*, not just *what*. A plan the user can't follow without a
  follow-up question is a failed plan.
- **Take your time.** A thin plan written fast is worse than no plan. Read the code and the thread
  first.
- **Don't over-complicate.** If the plan needs a diagram to be understood, it's probably wrong.
- **At most 5 questions per round**, ordered by which answer changes the plan most. A wall of
  twenty gets ignored.

## Questions are for intent, not facts

Ask about intent, priorities, and trade-offs — the things only the user can answer. Anything the
repo can answer (how something works today, what a script does, which labels exist) you look up
yourself. Be genuinely inquisitive: dig until both sides understand the problem, and never paper
over a gap with an assumption and build a plan on top of it.
