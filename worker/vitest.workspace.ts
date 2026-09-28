// Two projects, one framework — see CLAUDE.md's Releases section and
// worker/README.md for why these run at different cadences:
//
// - "unit": the normal suite (coordinate.ts, issue-coordinator.ts,
//   index.ts, github-client.ts, webhook-parse.ts, routines-client.ts, +
//   graph/'s own). Fast, free, deterministic — `npm test`, CI-blocking
//   on every PR via worker-tests.yml.
// - "evals": real @anthropic-ai/claude-agent-sdk calls against the
//   verbatim skill text (agent-runner.mjs's OUTCOME_CONFIGS). Slow
//   (15-30s/scenario), costs real money (~$2.50-3/run measured),
//   non-deterministic — `npm run test:evals`, only via
//   worker-agent-evals.yml on a published release, never PR-blocking.
//   Tests within one file already run sequentially by default (nothing
//   here uses it.concurrent), so scenarios run one at a time without
//   needing extra config — no bursting concurrent paid API calls.

import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "unit",
      include: ["test/**/*.test.ts"],
      exclude: ["test/evals/**"],
    },
  },
  {
    test: {
      name: "evals",
      include: ["test/evals/**/*.test.mjs"],
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  },
]);
