// Runs each scenario against the sandbox, stub mode. Needs the deployed
// Worker + stub (worker/terraform with e2e_repo set) and your `gh` login.

import { describe, expect, it } from "vitest";
import { gh, REPO, waitFor, type Snapshot } from "./github";
import { scenarios, type Scenario } from "./scenarios";

const settled = (s: Scenario) => (snap: Snapshot) =>
  snap.state === s.expect.state && JSON.stringify(snap.labels) === JSON.stringify([...s.expect.labels].sort());

const hasMarker = (snap: Snapshot, loop: string, outcome: string) =>
  snap.comments.some((c) => c.includes(`<!-- agent-outcome:${loop} -->`) && c.includes(`"outcome":"${outcome}"`));

describe.each(scenarios)("$name", (s) => {
  it("ends where the table says", async () => {
    const { number } = await gh<{ number: number }>("POST", `/repos/${REPO}/issues`, {
      title: `e2e: ${s.issue.title}`,
      body: `${s.issue.body}\n\n<!-- e2e: ${s.hint} -->`,
    });
    try {
      await gh("POST", `/repos/${REPO}/issues/${number}/labels`, { labels: [s.trigger] });
      const snap = await waitFor(number, settled(s), s.timeoutMs.stub);

      expect({ state: snap.state, labels: snap.labels }, `#${number}`).toEqual({
        state: s.expect.state,
        labels: [...s.expect.labels].sort(),
      });
      for (const m of s.expect.markers ?? []) {
        expect(hasMarker(snap, m.loop, m.outcome), `#${number}: ${m.loop} ${m.outcome} marker`).toBe(true);
      }
    } finally {
      // Keep the sandbox's open issues to the ones still running.
      if (s.expect.state === "open") await gh("PATCH", `/repos/${REPO}/issues/${number}`, { state: "closed" });
    }
  });
});
