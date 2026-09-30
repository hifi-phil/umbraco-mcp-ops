# e2e/ — the end-to-end suite

Scenarios run against the sandbox repo
[`hifi-phil/mcp-ops-e2e-testing`](https://github.com/hifi-phil/mcp-ops-e2e-testing)
on real GitHub, through the deployed orchestrator Worker. Design:
[`docs/agent-orchestration/14-e2e-testing.md`](../docs/agent-orchestration/14-e2e-testing.md).

- `stub/` is the stub agent, a small Worker that is the sandbox's Fire URL.
  It does what each loop does in orchestrated mode, following the
  `<!-- e2e: <hint> -->` on the issue or PR.
- `driver/` holds the scenarios (`scenarios.ts`, as data) and the runner.

## Commands

```sh
npm install
npm test          # the stub's unit tests (no network)
npm run typecheck
npm run build     # bundles stub/ to stub/dist/index.js for tofu
npm run e2e       # runs the scenarios against the sandbox (stub mode)
```

`npm run e2e` uses your `gh` login (or `GITHUB_TOKEN`). The Worker and the
stub must be deployed with `e2e_repo` set in `worker/terraform/`.

## Scripted so far

| Route | Hint | Stub does |
|---|---|---|
| `issue-build-loop` | `blocked` | posts the `build_blocked` marker |
| any | `silent`, or anything not scripted | nothing |

Scenarios: build blocked. The rest in 14-e2e-testing.md are added one at a
time, each with the stub behaviour it needs.
