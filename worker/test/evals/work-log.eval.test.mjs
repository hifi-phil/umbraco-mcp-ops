// Tier-2 evals for the work log (docs/agent-orchestration/16-work-log.md):
// real @anthropic-ai/claude-agent-sdk sessions against the verbatim
// work-log skill and issue-build-loop's references/work-log.md
// (work-log-runner.mjs). They check agent BEHAVIOUR: that the journal,
// the decision list and the build entry actually get written, and
// written as the guide says. The e2e suite can't: its stub plays the
// agents. The plumbing (token, /log, D1, the export) is the unit and db
// projects' job, and the e2e full lane's.
//
// Like outcome-reporting.eval.test.mjs: `npm run test:evals` only, real
// billed API calls, on a published release (worker-agent-evals.yml).

import { describe, it, expect } from "vitest";
import { runWorkLogStep } from "../../mock-github/work-log-runner.mjs";

function expectAllChecksPassed(checks) {
  for (const [key, value] of Object.entries(checks)) {
    expect(value, `check "${key}"`).toBe(true);
  }
}

const STEPS = [
  ["journal", "the build subagent journals its choices, with the path, and not its routine steps"],
  ["decision-list", "a fresh subagent derives the decision list (refs), leaves out the trivial, flags the unjournalled"],
  ["build-entry", "the orchestrator's build entry: commit, tests, review, not verified"],
];

describe("work-log evals — real agent vs. verbatim skill text", () => {
  for (const [step, label] of STEPS) {
    it(`${step}: ${label}`, async () => {
      const result = await runWorkLogStep({ step });
      console.log(`work-log ${step}: cost=$${(result.costUsd ?? 0).toFixed(4)} duration=${result.durationMs ?? "?"}ms`);
      console.log(JSON.stringify(result.added, null, 2));
      expect(result.resultSubtype, "agent turn succeeded").toBe("success");
      expectAllChecksPassed(result.checks);
    });
  }
});
