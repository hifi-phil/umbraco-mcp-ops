// The Tier-2 eval suite: real @anthropic-ai/claude-agent-sdk calls against
// every cataloged outcome-reporting step (agent-runner.mjs's
// OUTCOME_CONFIGS) — issue-build-loop's build_succeeded/build_blocked,
// auto-release-loop's release_blocked/release_published. Checks agent
// BEHAVIOR against verbatim skill text, not the reducer (that's the "unit"
// project's job, with fakes — see ../coordinate.test.ts). Deliberately not
// a `.ts` file: it imports mock-github's plain-JS ecosystem
// (agent-runner.mjs/mock-state.mjs) directly, matching that ecosystem's
// own untyped convention rather than adding TS/allowJs friction at the
// boundary.
//
// Only ever runs via `npm run test:evals` (vitest.workspace.ts's "evals"
// project) — real, billed Anthropic API calls, ~$2.50-3 for this whole
// file, ~15-30s/scenario. Never part of `npm test`. See
// .github/workflows/worker-agent-evals.yml (fires on a published GitHub
// Release only) and CLAUDE.md's Releases section for why.

import { describe, it, expect } from "vitest";
import { runLoopOutcome } from "../../mock-github/agent-runner.mjs";
import { getIssue, resetState } from "../../mock-github/mock-state.mjs";

/** Every OUTCOME_CONFIGS check is expected to be true — assert each one
 * individually (not just the aggregate) so a failure names exactly which
 * check didn't hold, not just "something was false". */
function expectAllChecksPassed(checks) {
  for (const [key, value] of Object.entries(checks)) {
    expect(value, `check "${key}"`).toBe(true);
  }
}

const SCENARIOS = [
  {
    label: "issue-build-loop: build_succeeded",
    routine: "issue-build-loop",
    issueNumber: 1,
    seedLabel: "ai-ready",
    scenario: { type: "build_succeeded", pr: 10 },
  },
  {
    label: "issue-build-loop: build_blocked",
    routine: "issue-build-loop",
    issueNumber: 2,
    seedLabel: "ai-ready",
    scenario: { type: "build_blocked", reason: "flaky snapshot test, 3 retries failed identically" },
  },
  {
    label: "auto-release-loop: release_blocked",
    routine: "auto-release-loop",
    issueNumber: 3,
    seedLabel: "auto-releasing",
    scenario: { type: "release_blocked", pr: 20, version: "1.0.0", findings: "changelog entry missing for the breaking change" },
  },
  {
    label: "auto-release-loop: release_published",
    routine: "auto-release-loop",
    issueNumber: 4,
    seedLabel: "auto-releasing",
    scenario: { type: "release_published", pr: 21, version: "1.0.0" },
  },
];

describe("outcome-reporting evals — real agent vs. verbatim skill text", () => {
  for (const s of SCENARIOS) {
    it(s.label, async () => {
      resetState();
      getIssue("o", "r", s.issueNumber).labels.add(s.seedLabel);

      const result = await runLoopOutcome({
        routine: s.routine,
        owner: "o",
        repo: "r",
        issueNumber: s.issueNumber,
        scenario: s.scenario,
      });

      console.log(
        `${s.label}: cost=$${(result.costUsd ?? 0).toFixed(4)} duration=${result.durationMs ?? "?"}ms`,
      );

      expect(result.resultSubtype, "agent turn succeeded").toBe("success");
      expectAllChecksPassed(result.checks);
    });
  }
});
