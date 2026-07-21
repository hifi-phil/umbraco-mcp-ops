# MCP feature lenses — grill decision-tree, adversarial lenses, issue template

Reference for [`grill-to-issue`](../SKILL.md). Three parts:

1. **Grill decision-tree** — the branches you walk with the user, one question at a
   time (Phase 2).
2. **Adversarial lenses** — the single-lens attacks a subagent panel runs against the
   emerging spec (Phase 3, thorough mode).
3. **Issue body template** — the shape every emitted issue takes (Phase 5), aligned
   with what `mcp-issue-loop`'s build playbook needs.

---

## 1. Grill decision-tree

Walk these branches in order. **One question at a time**, each with your recommended
answer. **Resolve facts by reading the repo** (`CLAUDE.md`, the target collection under
`src/umbraco-api/tools/`, `config/mode-registry.ts`, `config/slice-registry.ts`, a
similar existing tool) — only put *decisions* to the user. Later branches depend on
earlier ones; don't jump ahead.

1. **Intent & editorial value.** What editor/agent problem does this solve, and what
   will the LLM *do* with the result? Push hard here: an editor MCP tool should **return
   data the LLM reasons about**, not just wrap a CRUD endpoint. If the answer is "it
   wraps `POST /x`", ask what decision the response enables — that shapes the output.
2. **Scope-boundary check.** Is this inside the editor MCP's remit? **Site-infrastructure
   config — hostnames, domains, routing, cultures/languages plumbing — is out of scope**
   (too dangerous for editors/agents). If the idea is infra config, stop and redirect
   rather than spec it.
3. **Read or write.** Read (report/inspect/list) or write (create/update/delete/publish/
   move)? Writes pull in confirmation, annotations, and readonly-mode behaviour (below).
4. **Collection & placement.** Which of the existing collections, or a new one? Which
   verb folder (`get/` `post/` `put/` `delete/`)? A new collection usually means a new
   **mode** — is that intended, or does it belong in an existing collection?
5. **Chaining.** Does it delegate to an existing `@umbraco-cms/mcp-dev` CMS tool via
   `chainCms(...)`? **Name the exact CMS tool and confirm it exists and returns
   `structuredContent`.** If no underlying CMS tool exists, that's a dependency/blocker —
   surface it (the dev MCP may need the tool, or an `outputSchema`, first).
6. **Write semantics** (writes only). `confirmAction` — title, message, default? Which
   `annotations` (`readOnlyHint` / `destructiveHint` / `idempotentHint`)? Confirm it
   respects `UMBRACO_READONLY` (writes blocked).
7. **Schema design.** Input shape (what the LLM sends) uses `z.string().uuid()` for ids;
   output/Umbraco-returned values (version ids especially) use `z.guid()` — getting this
   wrong passes tests but fails on the wire with `-32602`. What does the LLM send and get
   back? **Shape the response for the LLM** — trim/summarise, don't echo the raw API.
8. **Pagination.** List/tree tool → **cursor pagination at the LLM boundary** (never
   skip/take).
9. **Bulk.** Does it need a bulk variant (10-item cap, `bulk-handler`), or is single-item
   enough for now?
10. **Cross-source angle.** The highest-impact tools let the LLM combine Umbraco data
    with *other* sources (analytics, Search Console, etc.). Should the output be designed
    to join with something external, rather than stand alone?
11. **Testing & verification.** Integration test against real Umbraco (builders + helpers
    first, create its own data, clean up by id, `callTool` so `outputSchema` is
    validated). Evals (add the tool to every eval file's `allTools`). What is the
    **observable** success signal?
12. **Acceptance criteria.** Restate the agreed behaviour as concrete, observable checks —
    this becomes the issue's acceptance list.

Stop grilling when you and the user share a clear, complete picture across these
branches — not before. If a branch reveals the idea isn't ready (missing CMS tool, out
of scope, no clear editorial value), say so instead of forcing an issue.

---

## 2. Adversarial lenses (thorough mode)

Dispatch **one subagent per lens, in parallel**, each attacking the emerging spec
through ONE lens only. Each returns a JSON array of findings
(`{claim, location, severity: blocking|significant|minor, why}`) or `[]`; the final
message must **be** the JSON and nothing else. Then run a **refute** pass — one skeptic
per finding, prompted to refute it, default-refuted-if-unconvinced — and keep only
survivors. (This is the compressed `plan-interrogation` method; use read-capable agents
so they can confirm claims against the repo.)

**Core lenses:**
1. **Hidden assumptions** — especially: an assumed `chainCms` CMS tool exists / returns a
   given field; assumed data shape, variant/culture presence, prior state.
2. **Missing edge cases / failure modes** — empty/null, not-found, unpublished content,
   variant vs invariant, permissions, partial failure.
3. **Sequencing & dependency** — does a slice need another slice's tool first? Does it
   need a dev-MCP change (new CMS tool / `outputSchema`) before it can be built at all?
4. **Over-engineering / YAGNI** — a CRUD wrapper that doesn't earn its weight, duplicates
   an existing tool, or specs more than the editorial goal needs.
5. **Testability** — can success be observed deterministically via `callTool` + a
   self-created fixture, or is it un-verifiable / reliant on pre-existing data?

**MCP wire-safety lens (always include for tool work):** `uuid()` vs `guid()` on outputs
(the `-32602` trap), `outputSchema` present and validated, cursor pagination at the
boundary, `confirmAction` on writes, readonly-mode respected.

---

## 3. Issue body template

Every emitted issue uses this shape. It carries what the loop's build subagent needs to
inspect the collection, implement to convention, test, review, and PR — without
re-deriving the design. Omit a section only if it genuinely doesn't apply.

```markdown
## Summary
<one or two sentences: the editorial problem and what the LLM does with the result>

## Actor & operation
<editor / agent> · <read | write>  ·  collection: `<name>`  ·  verb folder: `<get|post|put|delete>`
New collection? <no | yes → new mode `<mode>`>

## Chained CMS tool
Delegates to `chainCms("<cms-tool-name>", …)` — exists: <yes | NO, dependency>.
<note if the dev MCP needs a new tool or an outputSchema first>

## Schema sketch
- **Input** (LLM → tool): <fields; ids use `uuid()`>
- **Output** (tool → LLM): <shaped fields; Umbraco-returned/version ids use `guid()`>
- Response shaping: <what's trimmed/summarised vs raw API>

## Behaviour & edge cases
<the agreed behaviour, plus the edge cases that must be handled: empty/null/not-found/
variant/unpublished/permissions>

## Writes: confirmation & annotations
confirmAction — title "…", message "…", default <…>.
annotations: readOnlyHint <…>, destructiveHint <…>, idempotentHint <…>. Respects UMBRACO_READONLY.
<omit this section for read-only tools>

## Mode & slices
mode: `<mode>` · slices: `<read|create|update|delete|list|tree|search|publish|version|move>`

## Pagination
<cursor-based at the LLM boundary | n/a — not a list>

## Acceptance criteria
- [ ] <observable check>
- [ ] <observable check>

## Tests & evals
- Integration test(s): <what they create & assert; builders/helpers first; cleanup by id; use `callTool`>
- Evals: <scenario; add tool to every eval file's `allTools`>

## Out of scope / non-goals
<what this issue deliberately does NOT do>

## Dependencies
<none | "Part of #<parent>"; "needs #<slice> first"; "blocked on dev-MCP tool X">

## Skills to use
`/mcp-patterns`, then `/add-tool` (+ `test-builder-helper-creator`, `/add-test`,
`integration-test-validator`, `/add-eval`), `mcp-tool-reviewer`. Follow `CLAUDE.md`.

---
_Not yet `ready-for-ai`. Review this spec, then apply the `ready-for-ai` label to hand it to `mcp-issue-loop`._
```

**Parent tracking issue (only when the feature is split):** a short summary plus a
checklist of the child slices in dependency order, each linked; every child carries
`Part of #<parent>` in its **Dependencies** section.
