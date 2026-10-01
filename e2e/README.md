# e2e/ — the end-to-end suite

Scenarios run against the sandbox repo
[`hifi-phil/mcp-ops-e2e-testing`](https://github.com/hifi-phil/mcp-ops-e2e-testing)
on real GitHub, through the deployed orchestrator Worker. Design:
[`docs/agent-orchestration/14-e2e-testing.md`](../docs/agent-orchestration/14-e2e-testing.md).

- `stub/` is the stub agent, a small Worker that is the sandbox's Fire URL.
  It does what each loop does in orchestrated mode (`stub/src/loops.ts`),
  following the `<!-- e2e: <hint> -->` on the issue or PR. It never touches
  outcome labels; that's the orchestrator's job, and the thing under test.
- `driver/` holds the scenarios (`scenarios.ts`) and the runner, which
  ends every run with an audit of the orchestrator's answers.

## Commands

```sh
npm install
npm test          # the stub's unit tests (no network)
npm run typecheck
npm run build     # bundles stub/ to stub/dist/index.js for tofu
npm run e2e       # every scenario against the sandbox (stub mode), ~8 min
E2E_ONLY=conflict,watchdog npm run e2e   # just the scenarios whose name contains one of these
```

`npm run e2e` uses your `gh` login (or `GITHUB_TOKEN`). It prints progress
as it goes, one tagged line per step and per label change
(`06:18:23 [CI-fix limit] #122 open [auto-merge] -> open [auto-rework]`);
`E2E_QUIET=1` turns that off. Scenarios run five at a time.

The Worker and the stub must be deployed with `e2e_repo` set in
`worker/terraform/`. That also makes the sandbox's watchdog real, with a
2-minute timeout (`e2e_watchdog_minutes`), while every other repo's stays
as configured. The sandbox has to stay **public**: the merge gate reads
check-runs, which a fine-grained token can't read on a private repo (see
`worker/README.md`'s known gaps).

Latest full run (01-10-2026): all 21 scenarios and the audit pass in about
8 minutes.

## What the stub does

| Route | Hint | Stub does |
|---|---|---|
| `issue-build-loop` | `success` | branch off `dev`, one commit, a PR into `dev` (hint `merge`), then the `build_succeeded` marker |
| `issue-build-loop` | `blocked` | the `build_blocked` marker |
| `rework-loop` | `rework` | one push to the PR (a review rework) |
| `rework-loop` | `ci_fail` | pushes `ci-state` = `pass` (the fix) |
| `rework-loop` | `ci_never_fixed` | a push that leaves CI red |
| `merge-flow` | any but `silent` | squash-merges if CI is green and there's no conflict; comments and stops if CI is red; otherwise waits |
| `auto-release-loop` | `published` | the `release_published` marker, then closes the issue |
| `auto-release-loop` | `blocked` | the `release_blocked` marker |
| `issue-discuss-loop` | `discuss` | one signed question per round |
| any | `heartbeat` | one `process` signal to the orchestrator's `/routine-signal`, then nothing |
| any | `complete` | one `completion` signal, then nothing |
| any | `silent` | nothing |

A real merge-flow polls CI for minutes, which a Worker request can't. So
the stub also has its own `check_suite` webhook (`POST /webhook`) and runs
merge-flow's gate again when CI finishes on a PR carrying `auto-merge`. It
finds the PRs by commit when GitHub's payload leaves them out, and
re-checks a gate that still reads "CI running".

## Coverage

**Scenarios** (`driver/scenarios.ts`):

- The lane:
  1. Full lane: build, PR, `auto-merge`, merged, then `auto-release`, published.
  2. Build blocked.
  3. Release blocked.
  4. Review rework.
  5. Discussion rounds (and `//` comments ignored).
- The merge gate:
  1. CI red before `auto-merge` (the label-time path).
  2. CI red after `auto-merge` (the `check_suite` path).
  3. The CI-fix limit → `merge-blocked`.
  4. A merge conflict → `merge-blocked`, fixed and retried → merged.
  5. A `check_suite` two PRs share, fanned out to both.
- The watchdog and `ai-stuck`, one scenario each:
  1. Silent build, then a late `build_succeeded`.
  2. A heartbeat quoted by the expiry, then a late `build_blocked`.
  3. A completion signal cancels the watchdog.
  4. A stuck build retried.
  5. A stuck release, then a late publish.
  6. A stuck release, then a late block.
  7. A stuck release retried.
  8. A stuck rework, then a late push.
  9. A stuck rework retried.
  10. A stuck merge-flow retried.
  11. A stuck merge-flow merged by hand.

**The audit**, after every run, over every delivery the orchestrator answered:
- none errored
- none was an event the table had no rule for
- the shared-head `check_suite` fanned out
- a redelivered label is deduped
- the D1 log agrees: every row for the run's issues and PRs is enforced
  and applied, and every delivery the Worker applied has its row

**The D1 log.** The driver reads it through the Worker's `GET /transitions`
route, which tofu turns on for the sandbox alone, with its own secret. The
driver gets that secret from `tofu output -raw e2e_log_read_secret` unless
`E2E_LOG_SECRET` is set. Scenarios check their own rows as well:
- the build, release, rework, discussion and merge events, each with its
  effect
- three soft fails and three CI-fix pushes before the hard block
- a `watchdog_expired` row for every expiry, and none when a completion
  signal cancels it

**Not covered, and why:**
- **Requested changes as a hard block:** it needs a second GitHub
  identity, since an account can't review its own PR. That waits for the
  GitHub App.
- **Shadow mode:** `MODE` is per Worker, and the sandbox runs on the
  enforcing one. A shadow scenario needs a second sandbox on a shadow
  Worker. It's unit-tested, and was validated live in Phase 3.
- **`delivery_id` in the log:** it's still written as null (a known gap in
  `worker/README.md`), so rows are matched to deliveries by issue and event.
- **`mergeable` still null after the Worker's re-reads:** that's GitHub's
  timing, which can't be set up on demand. It's unit-tested.
