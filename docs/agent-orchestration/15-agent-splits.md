# 15. Agent splits — build/review and release

[← Index](00-index.md)

---

**Status:** Design agreed, not built. **Date:** 04-10-2026

Phase 10's first two splits. Phase 10 says split only where data points,
or where the split gives "a validation gate or a state worth seeing on the
board". Neither split comes from failure data; both come from two problems
seen in real runs:

- **Long sessions lose context.** Release routines have forgotten what
  they were doing part-way through. One long session doing many steps is
  the cause; short nodes with one goal each, with the Worker holding the
  state, are the fix.
- **The build loop's review isn't independent.** `issue-build-loop` runs
  `mcp-review` "at the orchestrator level" to make it independent, but it's
  the same session that dispatched the build and read its report.

Cost, per [05-technical-elements.md](05-technical-elements.md): each node
is a cold session that reloads the repo, issue and PR, so more context and
wall-clock in total. Accepted for these two.

## Split 1: build and review (first)

```mermaid
flowchart LR
  ready[ready-for-ai] --> build[build]
  build -- PR opened --> ci{CI}
  ci -. red .-> rework[rework-loop]
  ci -- green --> review[ai-review]
  review -- pass --> done[generated-by-ai]
  review -. findings .-> rework
  rework -- pushed --> ci
  review -- block --> blocked[ai-blocked: waits for a person]
```

**Build** (`issue-build-loop`, one issue per fire, as cloud mode already is):
build, test locally, then an **in-context self-review subagent** (it has
the builder's context, and rereads the diff with a clear head), write the
decision log, open the PR, and stop. It no longer drives CI or runs
`mcp-review`.

**CI** is the Worker's. Red: fire `rework-loop` with the failing log, the
CI-fix path that exists for merge PRs today (`MAX_CI_FIX_ATTEMPTS`). Green:
add `ai-review` to the PR.

**Review** is a new routine on its own label, `ai-review`, on a **stronger
model than the builder**. Adversarial: it starts with nothing but the PR.

1. It forms its findings **without** reading the decision log.
2. It then checks each finding against the log. One that contradicts a
   logged decision is reported as a challenge to it ("challenges decision
   2: …"), not as a plain fix.
3. Outcome, as an agent-outcomes artifact, applied by the Worker:
   - **pass** → the issue gets `generated-by-ai`; the PR is ready for a
     person.
   - **findings** → `auto-rework`, with the findings in the comment.
   - **block** ("the approach is wrong") → `ai-blocked`, and it **waits for
     a person**. No automatic rebuild.

A person can add `ai-review` to any PR to (re-)run the review, e.g. after
editing it by hand. While it runs, the PR shows `ai-review`. This settles
[12-target-graph.md](12-target-graph.md)'s "labels as state" question for
this split: the sub-step is a label, visible on the board.

**Fixes are `rework-loop`'s**, the reviewer never fixes its own findings.
`rework-loop` reads the decision log, so it can weigh a challenge rather
than blindly undo a deliberate choice. Its push goes back through CI and
then `ai-review`.

**Caps.** Review rework rounds are counted separately for bots and people
(the transition's actor already says which), 3 each to start. Today's
`MAX_REVIEW_REWORKS` counts both together. A person re-adding
`auto-rework` from `ai-stuck` resets both counts, as now.

### The decision log

A `## Decisions` section in the PR description: each real choice and why
("used X rather than Y because …"). The build agent writes it when it opens
the PR; `rework-loop` appends when it makes a choice of its own. Every node
already reads the PR and people see it too, so it needs no new storage and
no vendor.

## Split 2: release

Most of `auto-release-loop` (229 lines, seven steps) is mechanical work
done by an agent, and its long tail is where it loses track.

- **Stays an agent:** prepare (cut `release/<version>`, bump, changelog,
  PR), fix CI, and the pre-publish review (`release-reviewer`, already a
  separate read-only agent; it can block).
- **Becomes deterministic code:** merge to `main`, tag and GitHub Release
  (`release-tag.yml` does this already), the Slack post, sync `main` back
  to `dev` (`sync-main-to-dev.yml` exists), comment and close the issue.

**Open: where the deterministic part runs.** The Worker (needs write on
`main` and tags, much more than it has today, but vendor-neutral) or
Actions in each target repo (every repo needs the workflows). Explore
before building split 2.

## Rollout

Sandbox first (`hifi-phil/mcp-ops-e2e-testing`): the e2e suite gains
scenarios for review pass, findings, block, a person re-running
`ai-review`, and the split counts, with stub agents as for the other
loops. Then umbraco-mcp-ops; the umbraco repos inherit it once onboarded.

## Still to decide while building

- The review routine's and skill's name (`mcp-review` is a skill today;
  content repos need a reviewer too).
- New outcome artifacts (`review_passed`, `review_findings`,
  `review_blocked`) and their graph rules; `ai-review` added to
  `LABELS`.
- Whether a CI-fix push on a PR already in `ai-review` restarts the
  review.
- Skill changes: `issue-build-loop` stops at PR open; `rework-loop` reads
  and appends to the decision log.

---

[← Index](00-index.md)
