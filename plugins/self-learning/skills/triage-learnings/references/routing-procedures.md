# Routing procedures (per home)

Exact steps once a cluster's home is already decided (see `SKILL.md`'s routing
table for how to decide). All GitHub actions below use `github-ops` for the
concrete command/tool. Issue/PR title and body follow
[`assets/routed-item-template.md`](../assets/routed-item-template.md).

## `mcp-repo` (domain-specific → issue on that MCP repo)

1. **Create an issue** on that repo using the routed-item template; also
   include the row's `Notes` placement hint (see `proto-learning-schema.md`'s
   `Guessed Home` heuristic) — favor a project-local skill over `CLAUDE.md`
   when unsure, to keep `CLAUDE.md` lean. Let that repo's process decide the
   final placement.
2. **Do not** add `ready-for-ai` — a human decides whether to feed it to the loop.
3. Mark the source row: `Status` → `Actioned`, `Notes` → the new issue link.

## `shared-mcp-skills` (generalizable → PR to Umbraco-MCP-Base)

1. Use the base branch resolved in `SKILL.md`'s Config.
2. **Create a branch** (`chore/proto-learning-<slug>`) and **push** the **smallest**
   edit to the `umbraco-mcp-skills` skill that *should have* surfaced the lesson
   (often `add-tool` / `mcp-patterns` / an integration-test skill).
3. **Open the PR** against the detected base, using the routed-item template.
4. Mark each source row: `Status` → `Actioned`, `Notes` → the PR link. Canvas
   rows have no open/closed state, so this doubles as "leave it discoverable
   until the PR merges" — don't treat `Actioned` as final if the PR is later
   rejected; re-open by setting `Status` back to `New` with a note.

## `loop-self` (→ `loop-improvement` issue on the ops repo)

1. **Create an issue** on `hifi-phil/umbraco-mcp-ops` with label
   `loop-improvement`, using the routed-item template.
2. Do **not** draft a PR editing whichever loop's skill this is about — a human
   frames the change.
3. Mark the source row: `Status` → `Actioned`, `Notes` → the new issue link.

## discard (not actionable → mark `Discarded`)

1. No GitHub action — nothing is created.
2. Mark the source row: `Status` → `Discarded`, `Notes` → a one-line reason.
