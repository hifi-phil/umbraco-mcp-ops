#!/usr/bin/env node
// The Tier-2 eval suite: runs the real Agent SDK against every cataloged
// outcome-reporting step (issue-build-loop's build_succeeded/build_blocked,
// auto-release-loop's release_blocked/release_published — see
// agent-runner.mjs's OUTCOME_CONFIGS) and fails loudly if any check
// doesn't pass. Deliberately self-contained: runLoopOutcome() only needs
// mock-state.mjs's in-memory issue tracking, not a running Worker/D1 —
// this is checking agent behavior against the verbatim skill text, not
// the reducer (that's worker-tests.yml's job, and it's already covered
// there with fakes). Makes real, billed Anthropic API calls — see
// worker/README.md and CLAUDE.md's "Releases" section for why this only
// runs on a published GitHub Release, not every PR.

import { runLoopOutcome } from "./agent-runner.mjs";
import { getIssue, resetState } from "./mock-state.mjs";

const SCENARIOS = [
  {
    routine: "issue-build-loop",
    issueNumber: 1,
    seedLabel: "ai-ready",
    scenario: { type: "build_succeeded", pr: 10 },
  },
  {
    routine: "issue-build-loop",
    issueNumber: 2,
    seedLabel: "ai-ready",
    scenario: { type: "build_blocked", reason: "flaky snapshot test, 3 retries failed identically" },
  },
  {
    routine: "auto-release-loop",
    issueNumber: 3,
    seedLabel: "auto-releasing",
    scenario: { type: "release_blocked", pr: 20, version: "1.0.0", findings: "changelog entry missing for the breaking change" },
  },
  {
    routine: "auto-release-loop",
    issueNumber: 4,
    seedLabel: "auto-releasing",
    scenario: { type: "release_published", pr: 21, version: "1.0.0" },
  },
];

let allPassed = true;
let totalCostUsd = 0;

for (const s of SCENARIOS) {
  resetState();
  getIssue("o", "r", s.issueNumber).labels.add(s.seedLabel);

  const label = `${s.routine}:${s.scenario.type}`;
  console.log(`\n=== ${label} ===`);

  let result;
  try {
    result = await runLoopOutcome({ routine: s.routine, owner: "o", repo: "r", issueNumber: s.issueNumber, scenario: s.scenario });
  } catch (err) {
    console.error(`  FAILED to run: ${err instanceof Error ? err.message : err}`);
    allPassed = false;
    continue;
  }

  totalCostUsd += result.costUsd ?? 0;
  const failedChecks = Object.entries(result.checks).filter(([, v]) => v !== true);
  if (failedChecks.length === 0) {
    console.log(`  PASS — cost=$${(result.costUsd ?? 0).toFixed(4)} duration=${result.durationMs ?? "?"}ms`);
  } else {
    allPassed = false;
    console.error(`  FAIL — checks that didn't hold: ${JSON.stringify(Object.fromEntries(failedChecks))}`);
    console.error(`  tool calls: ${JSON.stringify(result.toolCalls)}`);
  }
}

console.log(`\nTotal cost this run: ~$${totalCostUsd.toFixed(4)}`);

if (!allPassed) {
  console.error("\nOne or more outcome-reporting scenarios failed.");
  process.exit(1);
}
console.log("\nAll outcome-reporting scenarios passed.");
