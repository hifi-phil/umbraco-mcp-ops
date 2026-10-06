# 15. Agent splits — build/review and release

[← Index](00-index.md)

---

**Status:** Design agreed, not built. **Date:** 04-10-2026

## Summary

- **Build and review become separate routines.** The build routine stops
  once the PR is open. A new `ai-reviewing` routine reviews the PR with fresh
  eyes. `rework-loop` makes the fixes.
- **Every routine records its decisions and what it verified** in two
  logs, kept in D1 next to the label history.
- **The release routine is reduced to the parts that need judgement.**
  The mechanical steps after the review become plain code.
- **Order:** build/review first, in the sandbox. Release second.

## Why split

Phase 10 says split a node only when data points at it, or when the split
gives "a validation gate or a state worth seeing on the board". These two
splits don't come from failure data. They come from two problems seen in
real runs.

1. **Long sessions lose context.** Release routines have forgotten what
   they were doing part-way through. Short routines with one goal each,
   with the Worker holding the state, avoid that.
2. **The build loop's review isn't independent.** `issue-build-loop` runs
   `mcp-review` itself. That's the same session that dispatched the build
   and read its report, so the review shares the builder's view.

**The cost:** each routine starts cold and reloads the repo, the issue and
the PR. That means more tokens and more wall-clock time overall
([05-technical-elements.md](05-technical-elements.md)). It's accepted for
these two.

## Split 1: build and review

```mermaid
flowchart LR
  ready[ai-ready] --> build[build]
  build -- PR opened --> ci{CI}
  ci -. red .-> rework[rework-loop]
  ci -- green --> review[ai-reviewing]
  review -- pass --> done[pr-open]
  review -. findings .-> rework
  rework -- pushed --> ci
  review -- block --> blocked[ai-blocked: waits for a person]
```

### Build

`issue-build-loop` handles one issue per fire, as its cloud mode already
does. It:

1. builds the change and tests it locally;
2. reviews it with `mcp-review` (Anthropic's review agents, as it always
   has), from its top-level session, and fixes what that finds;
3. writes its decisions and build entry to the logs (below);
4. adds `ai-reviewing` to the PR, and stops.

It no longer drives CI. That's the same whether or not the Worker
orchestrates the repo (decided 07-10-2026); only who swaps the issue's labels
differs, as for every loop.

### CI

The Worker watches CI, not the build routine. `ai-reviewing` goes on when the
PR opens, but the review only fires once CI has finished. The Worker reads
the PR's checks when the label is added and each time a check suite
finishes, the same live re-check `auto-merging` uses.

- **Still running, or not started:** wait for the next check suite.
- **Red:** `ai-reviewing` is swapped for `auto-reworking` and the Worker fires
  `rework-loop` with the failing checks. Its push brings `ai-reviewing` back.
  Capped at `MAX_CI_FIX_ATTEMPTS`, then `ai-stuck`.
- **Green:** the Worker fires `review-loop`.

### Review

A new routine, `review-loop`, on its own label, `ai-reviewing`, running on a
**stronger model than the builder**. It's adversarial: it starts with nothing but the PR.

1. It forms its findings **without** reading the decision log.
2. It then checks each finding against the log. A finding that contradicts
   a logged decision is reported as a challenge to that decision
   ("challenges decision 2: …"), not as a plain fix.
3. It reports one of three outcomes, which the Worker applies:

| Outcome | What happens |
|---|---|
| **pass** | `ai-reviewing` comes off. The PR is ready for a person. |
| **findings** | `auto-reworking`, with the findings in the comment. |
| **block** ("the approach is wrong") | `ai-blocked`. It **waits for a person**; nothing rebuilds automatically. |

**The review's state lives on the PR, not the issue.** The issue still gets
`pr-open` when the build opens the PR, as today. Changing the
issue's label from a verdict on the PR would be the first effect that
crosses from one issue to another, which the design doesn't cover yet
([12-target-graph.md](12-target-graph.md), edge type 1). So
`pr-open` means "the build opened a PR", and whether that PR passed
review is read from the PR.

The PR shows `ai-reviewing` while it waits for CI and while the review runs. A
person can add the label to any PR to run the review again, for example
after editing it by hand, or after a block.
This answers [12-target-graph.md](12-target-graph.md)'s "labels as state"
question for this split: the step is a label, visible on the board.

### Fixes

**`rework-loop` makes every fix.** The reviewer never fixes its own
findings. `rework-loop` reads the decision log, so it can weigh a challenge
instead of blindly undoing a deliberate choice. Its push goes back through
CI, then `ai-reviewing`.

### Caps

Review rework rounds are counted **separately for bots and for people**,
3 each to start. Each transition already records who made it, so the two
can be told apart. Today `MAX_REVIEW_REWORKS` counts both together. A
person re-adding `auto-reworking` from `ai-stuck` resets both counts, as now.

## The decision log and build log

### What they are

This follows Matt Brailsford's
[umbraco-claude-playbook](https://github.com/mattbrailsford/umbraco-claude-playbook)
(`DECISION-LOG.md`, `BUILD-LOG.md` and `decision-review`, in use on
`umbraco/Umbraco.AI`). The difference is that the entries live in D1, not
in files.

- **Decision log:** each choice the issue didn't settle. One short, dated
  entry: what was decided, why, and what was rejected. Each entry is tagged
  with one of his four categories: *assumption*, *deviation*, *workaround*
  or *judgment call*.
- **Build log:** what each routine did and checked: the commit, the tests
  run and their counts, the review round and verdict, and anything it
  didn't verify.

### Why D1

- **One timeline.** `transitions` already records every label change and
  fire for an issue, with who caused it. With decisions and checks next to
  it, the dashboard can show the whole story: labelled → decided X because
  Y → tests 42/42 → review round 1 FAIL → rework → PASS.
- **No overwrites.** Every entry is its own row, so two writers can't
  overwrite each other.
- **Queryable.** "Every workaround this month" is a single query. That's
  the data Phase 10 says future splits should follow.
- **The reviewer can write.** Writing to D1 doesn't push a commit, so it
  doesn't restart CI and the review.
- **No lock-in.** It's our own schema, not something tied to GitHub.

### Who writes what

| Routine | Decision log | Build log |
|---|---|---|
| build | Writes its decisions, including what its `mcp-review` changed | Writes its entry |
| `ai-reviewing` | Reads it, after forming its findings | Writes its verdict, round and findings |
| `rework-loop` | Reads it, and adds its own decisions | Writes its entry |
| Worker | — | — (`transitions` is its log) |

### How routines reach it

Through an **MCP endpoint on the Worker**, with tools to add an entry and
to read an issue's log.

- **Scoped tokens.** Each fire carries a short-lived token, issued by the
  Worker, for that one issue or PR and that one routine.
- **Add-only.** A token can add entries but not edit or delete them.
  Entries are capped at a few KB. A routine that has read hostile text in
  an issue or a PR comment can, at worst, add short entries to its own
  issue.
- **Best effort.** A routine never stops because the Worker can't be
  reached.

### What people see

- **Dashboard:** the merged timeline. It reads summaries, not the whole
  log, to stay within the D1 read budget.
- **PR description:** a short summary in the style of `decision-review`.
  It lists only the entries a person should look at, ranked, each with a
  recommended action.
- **Permanent copy:** when the PR merges, the Worker exports the issue's
  logs. D1 belongs to this deployment and `tofu destroy` removes it.
  Whether the export goes into the repo as a file or onto the PR is still
  open.

Repos that already use the playbook, with a `docs/plans/<feature>/` folder,
keep their files. The routines read those as well as D1.

### The free plan is enough for now

- **Volume is small.** A few log rows per routine run is far inside the
  free plan's daily caps.
- **Size isn't the issue.** A busy issue is about 50 KB of log entries. A
  database holds 500 MB on the free plan, 10 GB on paid.
- **Watch the read cap.** Since 01-09-2026 the free plan fails D1 queries
  outright once a daily cap is hit, which would stop the orchestrator, not
  just the logs. The dashboard already reads summaries to stay well clear.
- **When to go paid:** if daily usage starts getting close to a cap, for
  example once the umbraco repos bring real traffic. Workers Paid is an
  account plan: it covers the Worker, the Durable Objects and D1 together.

## Split 2: release

Built and shipped in 2.1.0: before (`auto-release-loop` prepares and
reviews), the merge (the Worker, as its App), after (`release-publish`). The
design, the diagrams and the labels along the way are in their own document:
[17-release-flow.md](17-release-flow.md).

## Rollout

1. **Sandbox** (`hifi-phil/mcp-ops-e2e-testing`). The e2e suite gains
   scenarios for:
   - review pass, findings and block;
   - a person re-running `ai-reviewing`;
   - the separate bot and human counts.

   Stub agents stand in for the routines, as for the other loops.
2. **umbraco-mcp-ops.**
3. **The umbraco repos**, once they're onboarded.

## Still to decide while building

**Review routine**
- **Settled (07-10-2026): the skill behind `review-loop`** is its own skill,
  `review-loop`, which runs `mcp-review` in report-only mode (it fits both
  repo shapes) with the reviewers on `opus`. A repo's `CLAUDE.md` can name a
  different reviewer skill.

Settled in the graph and Worker change: the routine is `review-loop`; its
outcomes are `review_passed`, `review_findings` (with a count) and
`review_blocked` (with a reason); and any push from a rework started under
`ai-reviewing`, a CI fix or the review's findings, goes back to `ai-reviewing`
and is reviewed again once its CI is green.

**Logs**
- The schema: one table or two.
- The MCP's tools, and how the fire token reaches the routine.
- Where the export goes when a PR merges.

**Skills** (part 3, built 07-10-2026, except the logs)
- `issue-build-loop` reviews its PR with `mcp-review`, adds `ai-reviewing`
  and stops, orchestrated or not. It no longer drives CI.
- Every routine reads and writes the logs through the MCP. *(Part 2, not
  built yet.)*
- **`review-loop` posts its findings as a real PR review**, with inline
  comments on the lines concerned. `rework-loop` only reads a PR's reviews
  and review comments (its Step 1), so findings left in an ordinary
  comment would look like "nothing actionable": it would clear the label
  without fixing anything, and three such rounds end in `ai-stuck`.
  - GitHub won't let a PR's author request changes on their own PR. If the
    routines act as the account that opened it, the review is a plain
    "comment" review. That still creates inline threads, which
    `rework-loop` reads.
  - The outcome marker for the Worker goes in a separate comment (the
    Worker reads comments), not the review's body.
- **`rework-loop` reads the decision log**, so it can weigh a finding that
  challenges a deliberate choice instead of undoing it. *(Part 2.)*
- **`rework-loop` rereads the issue**, so a fix doesn't drift from what the
  issue asked for. A finding it judges wrong gets a reply on its thread,
  not a change.
- The e2e stub's `review-loop` posts a real PR review for findings and a
  block, and its `rework-loop` pushes nothing when it finds no review to
  act on.

**Account**
- Whether the orchestrator moves to an Umbraco-owned Cloudflare account
  (not the shared production one), if and when it goes paid.

---

[← Index](00-index.md)
