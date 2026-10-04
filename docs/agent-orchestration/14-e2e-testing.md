# 14. End-to-end testing

[← Index](00-index.md)

---

**Status:** design, not built (30-09-2026).

Until now, each orchestration change was checked by hand. Someone opened an
issue or PR, added a label, watched the labels change and read the D1 log.
That process found real bugs (#123, #142) and proved #159's CI-fix cycle
(#163). This doc makes it repeatable: one suite, run against real GitHub,
that works with stub agents or with real ones.

## The shape: one suite, two modes

The Worker can't tell what answers a fire. It POSTs the fire text to
whatever Fire URL `REPO_ROUTINES_JSON` holds for the repo, and waits for
GitHub to change. So the driver (create, label, watch) is the same in both
modes, and only the thing behind the Fire URL differs.

| Mode | Behind the Fire URL | Speed and cost | Use it for |
|---|---|---|---|
| **stub** | the stub agent: scripted GitHub API calls, no LLM | about a minute per scenario, free | every change to `graph/` or `worker/`, and the release gate |
| **real** | the real `loop-dispatch` routine and real agents | minutes per step, LLM cost | the occasional real run-through (what we've been doing by hand) |

Comparing the two modes locates a fault. If stub passes and real fails,
the fault is the agent or the skill. If both fail, it's the orchestration.

## The pieces

**The sandbox repo, [`hifi-phil/mcp-ops-e2e-testing`](https://github.com/hifi-phil/mcp-ops-e2e-testing).**
It's disposable. It holds only what scenarios need:
- `dev` and `main`, gitflow like this repo, and a `CLAUDE.md` so real
  loops know its conventions.
- The loop labels.
- A CI workflow whose required check passes or fails on the contents of
  one file (`ci-state`). That gives the CI-fix cycle something real to
  fail and fix.
- A webhook to the Worker.

No code that matters lives there.

**The stub agent.** A small Worker, deployed with tofu next to the
orchestrator, and the sandbox's Fire URL. It reads
`route=… repo=… number=…` from the fire text and does what that loop does
in orchestrated mode, via the GitHub API:

| Route | Stub behaviour (by hint) |
|---|---|
| `issue-build-loop` | `success`: branch, commit, open a PR, post the `build_succeeded` marker. `blocked`: post the `build_blocked` marker |
| `rework-loop` | push a commit (for `ci_fail`, flip `ci-state` to pass); leave the labels alone |
| `merge-flow` | wait for CI; on green, merge and post the `merged` marker; on red, comment and stop |
| `auto-release-loop` | `published`: close the issue and post the marker. `blocked`: post the `release_blocked` marker |
| `issue-discuss-loop` | post a reply |
| any, with hint `silent` | do nothing (the watchdog's case) |

Merge-flow waits minutes for CI, which is longer than a Worker request
lives. So the stub keeps its pending steps in a Durable Object alarm and
returns 200 straight away, as a real routine does.

The stub is an executable copy of each loop's GitHub contract, so it can
drift from the skills. It's kept honest from both sides: its markers come
from `graph/`'s outcome constants, and the existing agent evals check the
skills against the same contract.

**The switch lives in the stub, not in tofu.** The stub is always the
sandbox's Fire URL. A `real` hint makes it forward the fire text, unchanged,
to the real routine's Fire URL. Switching modes then needs no `tofu apply`,
and one run can mix modes. The cost is that the stub holds the real
routine's token too.

**The driver.** A vitest suite under `e2e/` in this repo:
`npm run e2e -- --mode stub|real`. Each scenario:
1. creates a fresh issue or PR in the sandbox, with its hint;
2. adds the trigger label;
3. polls until the labels settle or the mode's timeout passes;
4. asserts on the sequence of labels, the markers, and the end state
   (merged, closed, or a named label).

It never asserts on comment wording, because real agents phrase things
their own way.

**Scenarios.** They also live under `e2e/`, next to `graph/`, so a PR that
changes a rule changes its scenario too. Each one is data:

```ts
{
  name: "CI fails under auto-merging, rework fixes it, merge-flow merges",
  setup: { pr: { files: { "ci-state": "fail" } } }, // genuinely red for real agents too
  hint: "ci_fail",
  trigger: "auto-merging",
  expect: ["auto-reworking", "auto-merging", "merged"],
  timeout: { stub: "3m", real: "30m" },
}
```

The setup is genuinely real, and the hint is only for the stub. Given
that setup, a real agent should end in the same place the hint scripts:
- `ci_fail` is a real red check.
- `blocked` is an issue a real agent would actually refuse.

The hint is an HTML comment (`<!-- e2e: ci_fail -->`), so it doesn't steer
real agents.

## The first scenarios

1. **The full lane:** `ai-ready` → PR → `auto-merging` → merged, then
   `auto-releasing` → published and closed.
2. **Build blocked:** `ai-ready` → `ai-blocked`.
3. **Release blocked:** `auto-releasing` removed, and the issue stays open.
4. **Review rework:** `auto-reworking` → push → label cleared.
5. **CI fixed:** `auto-merging` → `auto-reworking` → `auto-merging` → merged.
6. **The CI-fix limit:** the stub's rework never fixes CI, so after three
   attempts the PR ends in `merge-blocked`.
7. **Merge conflict:** `auto-merging` → `merge-blocked`, and merge-flow is
   never fired.
8. **Silent agent:** no outcome. Phase 6 uses this: in shadow it asserts a
   logged expiry, and in enforce it asserts `ai-stuck`.

## Where it sits

| Layer | Checks | Doesn't check |
|---|---|---|
| unit (`graph/`, `worker/`) | the reducer, the coordinator, each rule | anything real |
| black-box harness (`worker/README.md`) | real Worker + D1 against a mock GitHub | real GitHub's timing and payloads |
| agent evals (`worker-agent-evals.yml`) | real agents follow the skill text | the orchestration around them |
| **e2e, stub** | the orchestration against real GitHub: webhooks, echoes, CI, merges | agent behaviour |
| **e2e, real** | the whole system | nothing it can't, but it's slow and costs money |

## How we use it

- A change to `graph/` or `worker/` comes with a scenario for the path it
  touches, in the same PR, the same way it comes with unit tests.
- Stub mode runs on demand (locally, or via `workflow_dispatch`) and as a
  release gate against the deployed Worker, as `worker-agent-evals` does
  for agents.
- Real mode runs occasionally: before a phase is called done, or after a
  skill change.
- The first change this should gate is Phase 7's self-trigger guard. It
  changes whether the Worker's own label writes start loops, and the
  CI-fix cycle depends on exactly that.

## Setup it needs (done by hand)

- Sandbox:
  - `dev` and `main` branches
  - the labels
  - the webhook to the Worker, with the shared secret
- Tokens:
  - the Worker's GitHub token extended to the sandbox
  - a stub token scoped to the sandbox only
  - a driver token scoped to the sandbox only
- Config:
  - the sandbox's `REPO_ROUTINES_JSON` entry pointing at the stub
  - the stub's own tofu resources, on the personal account
- Real mode only: the routine environment needs access to the sandbox.

## Open

- **Staging comes with CI-driven deploys (decided 30-09-2026).** For now
  the sandbox is one more entry on the same Worker, so e2e checks code just
  after it's deployed instead of gating it. A staging Worker (a second tofu
  workspace, with the sandbox's webhook pointed at it) arrives when tofu
  moves from manual `apply` to CI. Then CI can deploy to staging, run
  stub-mode e2e, and promote to prod. Deploying twice by hand is too much
  overhead before that.
- **Real loops need the sandbox to work as a project.** rework-loop and
  issue-build-loop boot and test per `worker-env`, which assumes an MCP
  repo. The sandbox's `CLAUDE.md` has to give them something to build and
  test, or real mode runs against `umbraco-mcp-ops` instead.
- **Clean-up.** Merged scenario PRs pile up on the sandbox's `dev`. That's
  harmless, but a periodic reset (recreate the branches) keeps it readable.
