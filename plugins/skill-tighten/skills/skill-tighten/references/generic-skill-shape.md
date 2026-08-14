# Generic skill shape — what pushes content out of SKILL.md

Not tied to any repo or task domain — the same shape applies to a docs skill, an ops
loop, or a data-transform skill. It's a litmus test for what belongs in `SKILL.md`
versus what belongs in a reference file or a script, applied per paragraph rather than
as a fixed template to fill in.

## The router test

`SKILL.md`'s body is a **router**, not a manual: just enough to recognize the
situation and decide what applies to it. It is not the place to walk through every
branch in full.

For any paragraph, ask: **is this needed to decide what to do, or only needed once
you've already decided and are now doing it?**
- Needed to decide → stays in `SKILL.md`.
- Only needed once already on that path → belongs in a reference file for that
  specific path, with `SKILL.md` holding just the pointer ("if X situation, read
  `references/x.md`").

A skill that branches by domain, variant, or situation (frameworks, environments,
severities, item types) should have one reference file per branch. `SKILL.md` holds
only the router — which file to read for which situation — never the branch content
itself. Applying this per paragraph, rather than by an overall size threshold, means it
still catches a skill that's short overall but mixes router logic with path-specific
detail in the same section.

## The determinism test

A step described as a fixed sequence with zero judgment calls in between — the same
tool calls, in the same order, every single run — belongs in `scripts/` as executable
code, not as prose the model re-derives and re-executes from instructions each time.
This is the biggest efficiency lever available: it removes both the token cost of
describing the procedure in full every run and the risk of the model interpreting the
same mechanical steps slightly differently from one run to the next. If a reviewer
finds a passage that reads like a script with no branching, that's the signal.

## The output-material test

Fixed material that ends up *in* the output — a template, an icon, boilerplate
config — belongs in `assets/`, not typed inline as an example the model has to
reproduce verbatim each time.
