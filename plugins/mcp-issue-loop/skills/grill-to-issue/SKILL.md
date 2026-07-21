---
name: grill-to-issue
description: >-
  Turn a rough feature idea for an Umbraco MCP repo into well-formed GitHub
  issue(s) by first grilling you about it. Relentlessly interrogates the idea one
  question at a time — walking an MCP-aware decision tree (collection, read/write,
  chaining, schema, modes/slices, tests) and recommending an answer for each —
  then (optionally) hardens the emerging spec with an adversarial subagent panel,
  splits a large feature into vertically-sliced task issues with a parent tracker,
  and files them via github-ops. Issues are created UNLABELLED — you review and
  apply `ready-for-ai` to hand them to mcp-issue-loop. Interactive/local only;
  github-ops required. Trigger on "grill me about this feature", "spec this MCP
  tool into an issue", "interrogate this idea and file issues", "turn this into
  ready issues".
---

# grill-to-issue

The **front of the issue pipeline.** It takes a half-formed feature idea and, through a
relentless interview, turns it into one or more GitHub issues precise enough for
[`mcp-issue-loop`](../mcp-issue-loop/SKILL.md) to build. It is the deliberate opposite of
jumping straight to code: no issue is written until the design is genuinely understood.

```
grill-to-issue  →  (you review + label ready-for-ai)  →  mcp-issue-loop  →  rework-loop  →  merge-flow
   design                    human gate                     build → PR        review        merge
```

It fuses two proven patterns:
- **Grill** (Matt Pocock's `grill-me` / relentless one-question-at-a-time interviewing) —
  resolve every branch of the decision tree with the user before acting.
- **Harden** (Matt Brailsford's `plan-interrogation` / adversarial single-lens panel +
  refutation) — attack the emerging spec from independent angles and keep only findings
  that survive a skeptic. Applied in *thorough* mode.

**Interactive and local only.** It asks *you* questions, so it can't run as an unattended
routine. It writes GitHub issues but no code.

## Config (resolve once)

- **Repo** — identify the current repo (github-ops → *Detect base branch / repo*).
- **MCP repo assumed** — confirm it's an `@umbraco-cms/mcp-*` repo (`src/umbraco-api/tools/`,
  a `CLAUDE.md`). If not, stop and say so — the whole grill is MCP-shaped.
- **github-ops required** — issue creation goes through the **`github-ops`** skill (name the
  *operation*, never a raw `gh` command). It must be installed.
- **Label policy** — issues are filed **without** `ready-for-ai` (see [Phase 5](#phase-5--file-the-issues)).

## Phase 1 — Ground yourself (look up, don't ask)

Before asking anything, read so you grill about *decisions*, not *facts*:
`CLAUDE.md`, the target collection under `src/umbraco-api/tools/`, `config/mode-registry.ts`,
`config/slice-registry.ts`, and the closest existing tool to what's proposed. Anything you
can learn from the repo, learn — never make the user tell you what the code already says.

## Phase 2 — Grill (relentless, one question at a time)

Interview the user about the feature until you share a complete, concrete picture. Rules
(from `grilling`):

- **One question at a time.** Wait for the answer before the next. Multiple questions at
  once is bewildering.
- **Recommend an answer to every question** — your best call given the repo and
  conventions — so the user can accept or correct, not compose from scratch.
- **Walk the decision tree, resolving dependencies in order.** Later branches depend on
  earlier ones.
- **Look up facts; put only decisions to the user.**
- **Don't emit anything until shared understanding is reached.** If grilling reveals the
  idea isn't ready — no clear editorial value, out of scope, or a missing upstream CMS
  tool — say so and stop, rather than forcing an issue.

Walk the **MCP feature decision-tree** in
[`references/mcp-feature-lenses.md`](references/mcp-feature-lenses.md) §1: intent &
editorial value → scope-boundary check → read/write → collection & placement → chaining →
write semantics → schema (uuid vs guid) → pagination → bulk → cross-source angle → testing
→ acceptance criteria.

## Phase 3 — Harden (thorough mode; optional)

For a large, risky, or cross-cutting feature — or when the user asks to "poke holes" /
"be thorough" — stress-test the spec **before** writing issues. Dispatch a parallel panel
of single-lens subagents, then a refute pass, per
[`references/mcp-feature-lenses.md`](references/mcp-feature-lenses.md) §2. Fold surviving
findings back into the spec (usually another short grill round on the gaps they expose).
Skip this for a small, obvious one-tool feature — don't make the user sit through a panel
for a description tweak.

**Never use `fable`** for any subagent (any lens, any refuter). `opus` / `sonnet` /
`haiku` only.

## Phase 4 — Split into vertical slices

Decide whether this is **one issue or several**. Split when the feature is more than one
shippable unit of value.

- **Slice vertically, not horizontally.** Each slice is an independently buildable *and*
  testable increment — a single tool (with its schema, tests, evals) or one coherent
  behaviour — not "all the schemas" then "all the tests". Think tracer-bullet: the
  thinnest end-to-end thing that works.
- **Order by dependency.** A slice that another depends on comes first; note the
  dependency on the later slice.
- **One tool ≈ one slice** is the usual granularity for these repos. A whole new
  collection is naturally several slices (often: first tool end-to-end, then each
  additional tool).
- If it's genuinely one unit, keep it as **one issue** — don't manufacture slices.

When you split, plan a **parent tracking issue** (summary + a dependency-ordered checklist
of the child slices) plus one issue per slice.

## Phase 5 — File the issues

Create each issue via **github-ops** (→ *Create an issue*), using the body template in
[`references/mcp-feature-lenses.md`](references/mcp-feature-lenses.md) §3. Title is a
concise imperative ("Add `report-…` tool to the `content-health` collection").

- **Do NOT apply the `ready-for-ai` label.** Issues are filed unlabelled — the human
  reviews the spec and applies `ready-for-ai` themselves to release it to the loop. (This
  is the deliberate quality gate; the whole point is that a human signs off the spec
  before an agent builds it.)
- **Split features:** file the **parent tracker first**, then each child slice with
  `Part of #<parent>` in its Dependencies section and any cross-slice `needs #<n>` links;
  update the parent's checklist with the child numbers.
- **Cross-link**, don't duplicate — child issues carry the detail; the parent links them.

Then **report** to the user: every issue created (number + URL), the split rationale if
any, and the explicit next step — *review these and apply `ready-for-ai` to the ones you
want `mcp-issue-loop` to build.* Do not label, and do not kick off the loop yourself.

## Rules

- **Grill before you write.** No issue is filed until Phase 2 reaches shared
  understanding. If it doesn't, stop with what's unresolved — an under-specified issue
  poisons the loop downstream.
- **One question at a time, always with a recommendation.** Never dump a question list.
- **Facts from the repo, decisions from the user.** Read `CLAUDE.md` and the collection;
  don't ask what the code answers.
- **Issues carry build-ready detail.** Fill the template so the loop's build subagent
  needn't re-derive the design (chained CMS tool, schema with uuid/guid, edge cases,
  confirmation, mode/slice, acceptance criteria, tests/evals).
- **Never label `ready-for-ai`.** That's the human's gate. This skill only proposes.
- **Never use `fable`** for any subagent.
- **Respect scope boundaries.** Site-infrastructure config (hostnames/domains/routing/
  cultures) is out of scope for the editor MCP — redirect rather than spec it.
- **Interactive only.** Don't attempt this as a routine; it depends on the user answering.
