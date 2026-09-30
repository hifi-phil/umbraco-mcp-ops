# e2e/ — the end-to-end suite

Scenarios run against the sandbox repo
[`hifi-phil/mcp-ops-e2e-testing`](https://github.com/hifi-phil/mcp-ops-e2e-testing)
on real GitHub, through the deployed orchestrator Worker. Design:
[`docs/agent-orchestration/14-e2e-testing.md`](../docs/agent-orchestration/14-e2e-testing.md).

- `stub/` is the stub agent, a small Worker that is the sandbox's Fire URL.
  It does what each loop does in orchestrated mode (`stub/src/loops.ts`),
  following the `<!-- e2e: <hint> -->` on the issue or PR. It never touches
  outcome labels; that's the orchestrator's job, and the thing under test.
- `driver/` holds the scenarios (`scenarios.ts`) and the runner.

## Commands

```sh
npm install
npm test          # the stub's unit tests (no network)
npm run typecheck
npm run build     # bundles stub/ to stub/dist/index.js for tofu
npm run e2e       # every scenario against the sandbox (stub mode), ~20 min
E2E_ONLY=conflict npm run e2e   # just the scenarios whose name contains "conflict"
```

`npm run e2e` uses your `gh` login (or `GITHUB_TOKEN`). The Worker and the
stub must be deployed with `e2e_repo` set in `worker/terraform/`. The
sandbox has to stay **public**: the merge gate reads check-runs, which a
fine-grained token can't read on a private repo (see `worker/README.md`'s
known gaps).

The first full run (30-09-2026): all eight pass in about 5 minutes.

## What the stub does

| Route | Hint | Stub does |
|---|---|---|
| `issue-build-loop` | `success` | branch off `dev`, one commit, a PR into `dev` (hint `merge`), then the `build_succeeded` marker |
| `issue-build-loop` | `blocked` | the `build_blocked` marker |
| `rework-loop` | `rework` | one push to the PR (a review rework) |
| `rework-loop` | `ci_fail` | pushes `ci-state` = `pass` (the fix) |
| `rework-loop` | `ci_never_fixed` | a push that leaves CI red |
| `merge-flow` | any | squash-merges if CI is green and there's no conflict; comments and stops if CI is red; otherwise waits |
| `auto-release-loop` | `published` | the `release_published` marker, then closes the issue |
| `auto-release-loop` | `blocked` | the `release_blocked` marker |
| any | `silent` | nothing |

A real merge-flow polls CI for minutes, which a Worker request can't. So
the stub also has its own `check_suite` webhook (`POST /webhook`) and runs
merge-flow's gate again when CI finishes on a PR carrying `auto-merge`.

## Scenarios

1. Full lane: build, PR, `auto-merge`, merged, then `auto-release`, published.
2. Build blocked: `ready-for-ai` → `ai-blocked`.
3. Release blocked: `auto-release` removed, issue stays open.
4. Review rework: `auto-rework` → push → cleared.
5. CI fixed: `auto-merge` → `auto-rework` → `auto-merge` → merged.
6. CI-fix limit: three pushes that don't fix CI → `merge-blocked`.
7. Merge conflict: `auto-merge` → `merge-blocked`, never merged.
8. Silent agent: nothing changes. The watchdog's expiry (60 min for a
   build) is asserted in Phase 6, once `WATCHDOG=enforce` makes it
   `ai-stuck`.
