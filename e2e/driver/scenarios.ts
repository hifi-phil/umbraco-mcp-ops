// The scenarios from docs/agent-orchestration/14-e2e-testing.md. Each one's
// setup is genuinely real (CI really fails, the conflict is real), so a real
// agent given it should end where the hint scripts the stub to; the hint is
// only for the stub. Assertions are on labels, the path the labels took,
// markers and end state, never on comment wording (bar the orchestrator's
// own fixed phrases).

import { expect } from "vitest";
import { LABELS } from "../../graph/constants/labels";
import {
  addLabel,
  cleanUp,
  devSha,
  gh,
  hasMarker,
  labelHistory,
  openIssue,
  openPr,
  putFile,
  REPO,
  sleep,
  snapshot,
  waitFor,
  waitForMergeable,
  type Snapshot,
} from "./github";

export type Scenario = { name: string; timeoutMs: number; run: () => Promise<void> };

const MIN = 60_000;
const labelsAre = (...want: string[]) => (s: Snapshot) => JSON.stringify(s.labels) === JSON.stringify([...want].sort());
const expectLabels = (s: Snapshot, n: number, ...want: string[]) =>
  expect(s.labels, `#${n} labels`).toEqual([...want].sort());

/** Runs `body`, then closes and deletes whatever it registered. */
async function scoped(body: (track: { n: (x: number) => number; branch: (b: string) => string }) => Promise<void>) {
  const numbers: number[] = [];
  const branches: string[] = [];
  try {
    await body({ n: (x) => (numbers.push(x), x), branch: (b) => (branches.push(b), b) });
  } finally {
    await cleanUp(numbers, branches);
  }
}

export const scenarios: Scenario[] = [
  {
    name: "full lane: build -> PR -> auto-merge -> merged, then release -> published",
    timeoutMs: 8 * MIN,
    run: () =>
      scoped(async (t) => {
        const issue = t.n(await openIssue("Add a build note", "Add a file under builds/ for this issue.", "success"));
        await addLabel(issue, LABELS.AI_READY);
        const built = await waitFor(issue, labelsAre(LABELS.AI_GENERATED), 2 * MIN);
        expectLabels(built, issue, LABELS.AI_GENERATED);
        expect(hasMarker(built, "issue-build-loop", "build_succeeded"), `#${issue} build_succeeded marker`).toBe(true);
        const pr = Number(built.comments.join("\n").match(/"outcome":"build_succeeded","pr":(\d+)/)?.[1]);
        t.n(pr);

        await addLabel(pr, LABELS.AUTO_MERGING);
        const merged = await waitFor(pr, (s) => s.merged, 4 * MIN);
        expect(merged.merged, `PR #${pr} merged`).toBe(true);

        const release = t.n(await openIssue(`release 0.0.${issue}`, "Release what's on dev.", "published"));
        await addLabel(release, LABELS.AUTO_RELEASING);
        const published = await waitFor(release, (s) => s.state === "closed", 2 * MIN);
        expect(published.state, `#${release}`).toBe("closed");
        expect(hasMarker(published, "auto-release-loop", "release_published"), `#${release} marker`).toBe(true);
      }),
  },
  {
    name: "build blocked: ready-for-ai -> ai-blocked",
    timeoutMs: 3 * MIN,
    run: () =>
      scoped(async (t) => {
        const issue = t.n(
          await openIssue(
            "Add a flux capacitor to ci-state",
            "Needs a design decision nobody has made yet: what should a flux capacitor do here? Block until a human decides.",
            "blocked",
          ),
        );
        await addLabel(issue, LABELS.AI_READY);
        const s = await waitFor(issue, labelsAre(LABELS.AI_BLOCKED), 2 * MIN);
        expectLabels(s, issue, LABELS.AI_BLOCKED);
        expect(s.state).toBe("open");
        expect(hasMarker(s, "issue-build-loop", "build_blocked"), `#${issue} marker`).toBe(true);
      }),
  },
  {
    name: "release blocked: auto-release removed, issue stays open",
    timeoutMs: 3 * MIN,
    run: () =>
      scoped(async (t) => {
        const issue = t.n(await openIssue("release 9.9.9", "Release with a failing pre-publish review.", "blocked"));
        await addLabel(issue, LABELS.AUTO_RELEASING);
        const s = await waitFor(issue, (x) => x.labels.length === 0, 2 * MIN);
        expectLabels(s, issue);
        expect(s.state).toBe("open");
        expect(hasMarker(s, "auto-release-loop", "release_blocked"), `#${issue} marker`).toBe(true);
      }),
  },
  {
    name: "review rework: auto-rework -> push -> label cleared",
    timeoutMs: 3 * MIN,
    run: () =>
      scoped(async (t) => {
        const pr = await openPr({ title: "review rework", hint: "rework", files: { [`notes/${Date.now()}.txt`]: "draft\n" } });
        t.n(pr.number);
        t.branch(pr.branch);
        await addLabel(pr.number, LABELS.AUTO_REWORKING);
        const s = await waitFor(pr.number, (x) => x.labels.length === 0, 2 * MIN);
        expectLabels(s, pr.number);
        const commits = await gh<unknown[]>("GET", `/repos/${REPO}/pulls/${pr.number}/commits`);
        expect(commits.length, "the stub's rework push").toBe(2);
      }),
  },
  {
    name: "CI fixed: auto-merge -> auto-rework -> auto-merge -> merged",
    timeoutMs: 8 * MIN,
    run: () =>
      scoped(async (t) => {
        const pr = await openPr({ title: "ci fixed", hint: "ci_fail", files: { "ci-state": "fail\n" } });
        t.n(pr.number);
        t.branch(pr.branch);
        await addLabel(pr.number, LABELS.AUTO_MERGING);
        const s = await waitFor(pr.number, (x) => x.merged, 7 * MIN);
        expect(s.merged, `PR #${pr.number} merged`).toBe(true);
        const history = await labelHistory(pr.number);
        expect(history, `PR #${pr.number} label path`).toEqual(
          expect.arrayContaining([`+${LABELS.AUTO_REWORKING}`, `-${LABELS.AUTO_REWORKING}`]),
        );
        expect(s.comments.some((c) => c.includes("🔧 CI failing") && c.includes("attempt 1 of 3"))).toBe(true);
      }),
  },
  {
    name: "CI-fix limit: three fixes that don't fix it -> merge-blocked",
    timeoutMs: 14 * MIN,
    run: () =>
      scoped(async (t) => {
        const pr = await openPr({ title: "ci never fixed", hint: "ci_never_fixed", files: { "ci-state": "fail\n" } });
        t.n(pr.number);
        t.branch(pr.branch);
        await addLabel(pr.number, LABELS.AUTO_MERGING);
        const s = await waitFor(pr.number, labelsAre(LABELS.MERGE_BLOCKED), 13 * MIN);
        expectLabels(s, pr.number, LABELS.MERGE_BLOCKED);
        expect(s.merged).toBe(false);
        const reworks = (await labelHistory(pr.number)).filter((h) => h === `+${LABELS.AUTO_REWORKING}`);
        expect(reworks.length, "rework rounds").toBe(3);
        expect(s.comments.some((c) => c.includes("after 3 fix attempts"))).toBe(true);
      }),
  },
  {
    name: "merge conflict: auto-merge -> merge-blocked, never merged",
    timeoutMs: 4 * MIN,
    run: () =>
      scoped(async (t) => {
        const path = `conflicts/${Date.now()}.txt`;
        const base = await devSha();
        // dev's side lands before the PR opens: GitHub computes mergeable at
        // open and doesn't recompute it promptly for a later push to the base.
        const pr = await openPr({
          title: "conflict",
          hint: "merge",
          files: { [path]: "from the PR\n" },
          fromSha: base,
          beforePr: () => putFile("dev", path, "from dev\n", "e2e: the other side of a conflict"),
        });
        t.n(pr.number);
        t.branch(pr.branch);
        expect(await waitForMergeable(pr.number), `PR #${pr.number} mergeable`).toBe(false);

        await addLabel(pr.number, LABELS.AUTO_MERGING);
        const s = await waitFor(pr.number, labelsAre(LABELS.MERGE_BLOCKED), 2 * MIN);
        expectLabels(s, pr.number, LABELS.MERGE_BLOCKED);
        expect(s.comments.some((c) => c.includes("merge conflict"))).toBe(true);
        await sleep(20_000); // CI finishing mustn't merge it either
        expect((await snapshot(pr.number)).merged).toBe(false);
      }),
  },
  {
    // What the stub can show in shadow watchdog mode: a loop that never
    // reports leaves the issue where it was, and nothing invents an outcome.
    // The expiry itself (60 min for a build) is Phase 6's to assert, once
    // WATCHDOG=enforce makes it visible as ai-stuck.
    name: "silent agent: nothing reported -> nothing changes",
    timeoutMs: 2 * MIN,
    run: () =>
      scoped(async (t) => {
        const issue = t.n(await openIssue("Say nothing", "The agent for this one never reports back.", "silent"));
        await addLabel(issue, LABELS.AI_READY);
        await sleep(45_000);
        const s = await snapshot(issue);
        expectLabels(s, issue, LABELS.AI_READY);
        expect(s.comments, `#${issue} comments`).toEqual([]);
      }),
  },
];
