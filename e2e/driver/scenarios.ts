// The scenarios from docs/agent-orchestration/14-e2e-testing.md, plus
// everything else the orchestrator does today. Each one's setup is
// genuinely real (CI really fails, the conflict is real), so a real agent
// given it should end where the hint scripts the stub to; the hint is only
// for the stub. Assertions are on labels, the path the labels took, markers
// and end state, never on comment wording (bar the orchestrator's own fixed
// phrases). Every scenario uses its own issues/PRs, so they run concurrently.

import { expect } from "vitest";
import { LABELS } from "../../graph/constants/labels";
import { outcomeComment } from "../stub/src/loops";
import { runHook } from "./hook";
import type { Outcome } from "../../graph/outcomes";
import {
  addLabel,
  cleanUp,
  comment,
  devSha,
  gh,
  hasMarker,
  labelHistory,
  labelledAt,
  merge,
  openIssue,
  openPr,
  putFile,
  REPO,
  setHint,
  sleep,
  snapshot,
  transitions,
  waitFor,
  waitForChecks,
  waitForMergeable,
  type LogRow,
  type Snapshot,
} from "./github";

export type Scenario = { name: string; timeoutMs: number; run: () => Promise<void> };

const MIN = 60_000;
/** The sandbox's watchdog (tofu's e2e_watchdog_minutes). */
const WATCHDOG_MINUTES = Number(process.env.E2E_WATCHDOG_MINUTES ?? 2);
const STUCK_WAIT = (WATCHDOG_MINUTES + 2) * MIN;

/** For the audit (run.e2e.test.ts): an issue whose label delivery to redeliver, and the two PRs sharing a head. */
export const runLog: { redeliverIssue?: number; sharedHead?: number[] } = {};

const labelsAre = (...want: string[]) => (s: Snapshot) => JSON.stringify(s.labels) === JSON.stringify([...want].sort());
const expectLabels = (s: Snapshot, n: number, ...want: string[]) => expect(s.labels, `#${n} labels`).toEqual([...want].sort());
const hasComment = (s: Snapshot, ...parts: string[]) => s.comments.some((c) => parts.every((p) => c.includes(p)));

type Track = { n: (x: number) => number; branch: (b: string) => string };

/** Runs `body`, then closes and deletes whatever it registered. */
async function scoped(body: (t: Track) => Promise<void>) {
  const numbers: number[] = [];
  const branches: string[] = [];
  try {
    await body({ n: (x) => (numbers.push(x), x), branch: (b) => (branches.push(b), b) });
  } finally {
    await cleanUp(numbers, branches);
  }
}

async function trackedPr(t: Track, opts: Parameters<typeof openPr>[0]) {
  const pr = await openPr(opts);
  t.n(pr.number);
  t.branch(pr.branch);
  return pr;
}

/** A loop that never reports: the trigger goes on, and the watchdog moves it to ai-stuck. */
async function expectStuck(n: number, trigger: string): Promise<Snapshot> {
  await addLabel(n, trigger);
  const s = await waitFor(n, labelsAre(LABELS.AI_STUCK), STUCK_WAIT);
  expectLabels(s, n, LABELS.AI_STUCK);
  expect(hasComment(s, "hasn't reported back within", `${WATCHDOG_MINUTES} minutes`), `#${n} watchdog comment`).toBe(true);
  await expectLogged(n, { event: "watchdog_expired", effect: LABELS.AI_STUCK });
  return s;
}

/**
 * The D1 log has these events for `n`, in this order (others may sit
 * between), each enforced and actually applied. `effect` optionally names
 * a label the row's effect must mention.
 */
async function expectLogged(n: number, ...want: (string | { event: string; effect?: string; run?: string })[]): Promise<LogRow[]> {
  const rows = await transitions(n);
  let i = 0;
  for (const w of want) {
    const spec = typeof w === "string" ? { event: w } : w;
    while (
      i < rows.length &&
      !(
        rows[i]!.event === spec.event &&
        (!spec.effect || (rows[i]!.to_effect ?? "").includes(spec.effect)) &&
        (!spec.run || rows[i]!.run === spec.run)
      )
    ) {
      i++;
    }
    expect(i < rows.length, `#${n} log has ${JSON.stringify(spec)} (in order) — rows: ${rows.map((r) => r.event).join(", ")}`).toBe(true);
    expect(rows[i]!.mode, `#${n} ${spec.event} row mode`).toBe("enforce");
    expect(rows[i]!.dropped_reason, `#${n} ${spec.event} row applied`).toBeNull();
    i++;
  }
  return rows;
}

/** A late loop's outcome, posted as the loop would (the marker isn't identity-guarded). */
const lateOutcome = (n: number, loop: string, outcome: Outcome) => comment(n, outcomeComment(loop, outcome));

export const scenarios: Scenario[] = [
  // --- The lane --------------------------------------------------------------
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
        const pr = t.n(Number(built.comments.join("\n").match(/"outcome":"build_succeeded","pr":(\d+)/)?.[1]));

        await addLabel(pr, LABELS.AUTO_MERGING);
        const merged = await waitFor(pr, (s) => s.merged, 4 * MIN);
        expect(merged.merged, `PR #${pr} merged`).toBe(true);

        const release = t.n(await openIssue(`release 0.0.${issue}`, "Release what's on dev.", "published"));
        await addLabel(release, LABELS.AUTO_RELEASING);
        const published = await waitFor(release, (s) => s.state === "closed", 2 * MIN);
        expect(published.state, `#${release}`).toBe("closed");
        expect(hasMarker(published, "auto-release-loop", "release_published"), `#${release} marker`).toBe(true);

        await expectLogged(
          issue,
          { event: "labelled_ai_ready", run: "issue-build-loop" },
          { event: "build_succeeded", effect: LABELS.AI_GENERATED },
        );
        await expectLogged(pr, { event: "labelled_auto_merging", run: "merge-flow" }, { event: "merged", effect: "close" });
        await expectLogged(release, { event: "labelled_auto_releasing", run: "auto-release-loop" }, { event: "release_published", effect: "close" });
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
        runLog.redeliverIssue = issue;
        await addLabel(issue, LABELS.AI_READY);
        const s = await waitFor(issue, labelsAre(LABELS.AI_BLOCKED), 2 * MIN);
        expectLabels(s, issue, LABELS.AI_BLOCKED);
        expect(s.state).toBe("open");
        expect(hasMarker(s, "issue-build-loop", "build_blocked"), `#${issue} marker`).toBe(true);
        await expectLogged(issue, { event: "labelled_ai_ready", run: "issue-build-loop" }, { event: "build_blocked", effect: LABELS.AI_BLOCKED });
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
        await expectLogged(issue, "labelled_auto_releasing", { event: "release_blocked", effect: "unlabel" });
      }),
  },
  {
    name: "review rework: auto-rework -> push -> label cleared",
    timeoutMs: 3 * MIN,
    run: () =>
      scoped(async (t) => {
        const pr = await trackedPr(t, { title: "review rework", hint: "rework", files: { [`notes/${Date.now()}.txt`]: "draft\n" } });
        await addLabel(pr.number, LABELS.AUTO_REWORKING);
        const s = await waitFor(pr.number, (x) => x.labels.length === 0, 2 * MIN);
        expectLabels(s, pr.number);
        const commits = await gh<unknown[]>("GET", `/repos/${REPO}/pulls/${pr.number}/commits`);
        expect(commits.length, "the stub's rework push").toBe(2);
        await expectLogged(pr.number, { event: "labelled_auto_reworking", run: "rework-loop" }, { event: "rework_pushed", effect: "unlabel" });
      }),
  },
  {
    name: "discussion: ai-discuss -> a round, a human reply -> the next round; '//' replies are ignored",
    timeoutMs: 3 * MIN,
    run: () =>
      scoped(async (t) => {
        const issue = t.n(await openIssue("What colour should the button be?", "Talk it through first.", "discuss"));
        const rounds = (s: Snapshot) => s.comments.filter((c) => c.startsWith("<!-- issue-discuss-loop -->")).length;
        await addLabel(issue, LABELS.AI_DISCUSSING);
        expect(rounds(await waitFor(issue, (s) => rounds(s) === 1, MIN)), "round 1").toBe(1);

        await comment(issue, "Blue, please.");
        expect(rounds(await waitFor(issue, (s) => rounds(s) === 2, MIN)), "round 2").toBe(2);

        await comment(issue, "// a note to self, not a reply");
        await sleep(20_000);
        const s = await snapshot(issue);
        expect(rounds(s), "no round for a '//' comment").toBe(2);
        expectLabels(s, issue, LABELS.AI_DISCUSSING);
        const rows = await expectLogged(
          issue,
          { event: "labelled_ai_discussing", run: "issue-discuss-loop" },
          { event: "discussion_reply", run: "issue-discuss-loop" },
        );
        expect(rows.filter((r) => r.event === "discussion_reply"), "one logged reply, not two").toHaveLength(1);
      }),
  },

  // --- The merge gate ------------------------------------------------------------
  {
    name: "CI red before auto-merge: auto-rework at label time -> fix -> auto-merge -> merged",
    timeoutMs: 8 * MIN,
    run: () =>
      scoped(async (t) => {
        const pr = await trackedPr(t, { title: "ci red first", hint: "ci_fail", files: { "ci-state": "fail\n" } });
        const runs = await waitForChecks(pr.number);
        expect(runs.map((r) => r.conclusion), "CI red before the label").toContain("failure");
        await addLabel(pr.number, LABELS.AUTO_MERGING);
        const s = await waitFor(pr.number, (x) => x.merged, 7 * MIN);
        expect(s.merged, `PR #${pr.number} merged`).toBe(true);
        expect(await labelHistory(pr.number)).toEqual(expect.arrayContaining([`+${LABELS.AUTO_REWORKING}`, `-${LABELS.AUTO_REWORKING}`]));
        expect(hasComment(s, "🔧 CI failing", "attempt 1 of 3")).toBe(true);
      }),
  },
  {
    name: "CI red after auto-merge: the check_suite path -> auto-rework -> fix -> merged",
    timeoutMs: 8 * MIN,
    run: () =>
      scoped(async (t) => {
        const pr = await trackedPr(t, { title: "ci red later", hint: "ci_fail", files: { "ci-state": "fail\n" } });
        await addLabel(pr.number, LABELS.AUTO_MERGING);
        const labelled = await labelledAt(pr.number, LABELS.AUTO_MERGING);
        const { head } = await gh<{ head: { sha: string } }>("GET", `/repos/${REPO}/pulls/${pr.number}`);
        const s = await waitFor(pr.number, (x) => x.merged, 7 * MIN);
        expect(s.merged, `PR #${pr.number} merged`).toBe(true);
        // The path under test: the first red CI finished after the label went on.
        const { check_runs } = await gh<{ check_runs: { completed_at: string }[] }>(
          "GET",
          `/repos/${REPO}/commits/${head.sha}/check-runs`,
        );
        expect(labelled! < check_runs[0]!.completed_at, "label added before CI finished (else the setup raced)").toBe(true);
        expect(hasComment(s, "🔧 CI failing", "attempt 1 of 3")).toBe(true);
        await expectLogged(
          pr.number,
          { event: "labelled_auto_merging", run: "merge-flow" },
          { event: "merge_gate_failed_soft", effect: LABELS.AUTO_REWORKING },
          { event: "ci_fix_pushed", effect: LABELS.AUTO_MERGING },
          "merged",
        );
      }),
  },
  {
    name: "CI-fix limit: three fixes that don't fix it -> merge-blocked",
    timeoutMs: 14 * MIN,
    run: () =>
      scoped(async (t) => {
        const pr = await trackedPr(t, { title: "ci never fixed", hint: "ci_never_fixed", files: { "ci-state": "fail\n" } });
        await addLabel(pr.number, LABELS.AUTO_MERGING);
        const s = await waitFor(pr.number, labelsAre(LABELS.MERGE_BLOCKED), 13 * MIN);
        expectLabels(s, pr.number, LABELS.MERGE_BLOCKED);
        expect(s.merged).toBe(false);
        const reworks = (await labelHistory(pr.number)).filter((h) => h === `+${LABELS.AUTO_REWORKING}`);
        expect(reworks.length, "rework rounds").toBe(3);
        expect(hasComment(s, "after 3 fix attempts")).toBe(true);
        const rows = await expectLogged(pr.number, { event: "merge_gate_failed_hard", effect: LABELS.MERGE_BLOCKED });
        expect(rows.filter((r) => r.event === "merge_gate_failed_soft"), "three soft fails logged").toHaveLength(3);
        expect(rows.filter((r) => r.event === "ci_fix_pushed"), "three CI-fix pushes logged").toHaveLength(3);
      }),
  },
  {
    name: "merge conflict -> merge-blocked; fixed and auto-merge re-added -> merged",
    timeoutMs: 8 * MIN,
    run: () =>
      scoped(async (t) => {
        const path = `conflicts/${Date.now()}.txt`;
        const base = await devSha();
        // dev's side lands before the PR opens: GitHub computes mergeable at
        // open and doesn't recompute it promptly for a later push to the base.
        const pr = await trackedPr(t, {
          title: "conflict",
          hint: "merge",
          files: { [path]: "from the PR\n" },
          fromSha: base,
          beforePr: () => putFile("dev", path, "from dev\n", "e2e: the other side of a conflict"),
        });
        expect(await waitForMergeable(pr.number, false), `PR #${pr.number} mergeable`).toBe(false);

        await addLabel(pr.number, LABELS.AUTO_MERGING);
        const blocked = await waitFor(pr.number, labelsAre(LABELS.MERGE_BLOCKED), 2 * MIN);
        expectLabels(blocked, pr.number, LABELS.MERGE_BLOCKED);
        expect(hasComment(blocked, "merge conflict")).toBe(true);
        await sleep(20_000); // CI finishing mustn't merge it either
        expect((await snapshot(pr.number)).merged).toBe(false);

        // A human resolves it (same content both sides) and retries.
        await putFile(pr.branch, path, "from dev\n", "e2e: resolve the conflict");
        expect(await waitForMergeable(pr.number, true), `PR #${pr.number} mergeable after the fix`).toBe(true);
        await addLabel(pr.number, LABELS.AUTO_MERGING);
        const merged = await waitFor(pr.number, (x) => x.merged, 4 * MIN);
        expect(merged.merged, `PR #${pr.number} merged after the retry`).toBe(true);
        expect(await labelHistory(pr.number)).toContain(`-${LABELS.MERGE_BLOCKED}`);
        await expectLogged(
          pr.number,
          { event: "merge_gate_failed_hard", effect: LABELS.MERGE_BLOCKED },
          { event: "labelled_auto_merging", run: "merge-flow" },
          "merged",
        );
      }),
  },
  {
    name: "check_suite on a commit two PRs share -> each PR's DO gets it",
    timeoutMs: 4 * MIN,
    run: () =>
      scoped(async (t) => {
        const a = await trackedPr(t, { title: "shared head", hint: "merge", files: { [`shared/${Date.now()}.txt`]: "x\n" } });
        const b = await trackedPr(t, { title: "shared head into main", hint: "merge", files: {}, branch: a.branch, base: "main" });
        await waitForChecks(a.number);
        await waitForChecks(b.number);
        // Asserted from the Worker's own answer in the audit's delivery pass.
        runLog.sharedHead = [a.number, b.number];
      }),
  },

  // --- The watchdog and ai-stuck (the sandbox's watchdog is real, short) --------
  {
    name: "watchdog: silent build -> ai-stuck; late build_succeeded -> generated-by-ai",
    timeoutMs: STUCK_WAIT + 2 * MIN,
    run: () =>
      scoped(async (t) => {
        const issue = t.n(await openIssue("Say nothing (late success)", "The agent reports long after the watchdog.", "silent"));
        const stuck = await expectStuck(issue, LABELS.AI_READY);
        expect(hasComment(stuck, "No progress step was ever reported")).toBe(true);
        await lateOutcome(issue, "issue-build-loop", { outcome: "build_succeeded", pr: 1 });
        expectLabels(await waitFor(issue, labelsAre(LABELS.AI_GENERATED), MIN), issue, LABELS.AI_GENERATED);
      }),
  },
  {
    name: "watchdog: a heartbeat is quoted by the expiry; late build_blocked -> ai-blocked",
    timeoutMs: STUCK_WAIT + 2 * MIN,
    run: () =>
      scoped(async (t) => {
        const issue = t.n(await openIssue("Say little (heartbeat)", "The agent reports one step, then dies.", "heartbeat"));
        const stuck = await expectStuck(issue, LABELS.AI_READY);
        expect(hasComment(stuck, "Last reported step: `e2e-heartbeat`")).toBe(true);
        await lateOutcome(issue, "issue-build-loop", { outcome: "build_blocked", reason: "late" });
        expectLabels(await waitFor(issue, labelsAre(LABELS.AI_BLOCKED), MIN), issue, LABELS.AI_BLOCKED);
      }),
  },
  {
    name: "watchdog: a completion signal cancels the watchdog (no ai-stuck)",
    timeoutMs: STUCK_WAIT + MIN,
    run: () =>
      scoped(async (t) => {
        const issue = t.n(await openIssue("Finish quietly", "The agent signals completion but posts nothing.", "complete"));
        await addLabel(issue, LABELS.AI_READY);
        await sleep((WATCHDOG_MINUTES + 1) * MIN);
        const s = await snapshot(issue);
        expectLabels(s, issue, LABELS.AI_READY);
        expect(hasComment(s, "hasn't reported back"), "no watchdog comment").toBe(false);
        const rows = await expectLogged(issue, { event: "labelled_ai_ready", run: "issue-build-loop" });
        expect(rows.map((r) => r.event), "no watchdog_expired logged").not.toContain("watchdog_expired");
      }),
  },
  {
    name: "real hook: a heartbeat from the agent-outcomes hook is quoted by the expiry",
    timeoutMs: STUCK_WAIT + 2 * MIN,
    run: () =>
      scoped(async (t) => {
        const issue = t.n(await openIssue("Hook heartbeat", "The real hook reports a step, then the run goes quiet.", "silent"));
        await addLabel(issue, LABELS.AI_READY);
        await sleep(10_000); // the fire, and its pending watchdog
        const log = await runHook("issue-build-loop", issue, {
          tool_name: "Bash",
          tool_input: { command: "npm test", description: "e2e hook step" },
        });
        expect(log, "the hook sent its heartbeat").toContain("sent heartbeat");
        const s = await waitFor(issue, labelsAre(LABELS.AI_STUCK), STUCK_WAIT);
        expectLabels(s, issue, LABELS.AI_STUCK);
        expect(hasComment(s, "Last reported step: `Bash: e2e hook step`"), `#${issue} expiry quotes the hook's step`).toBe(true);
      }),
  },
  {
    name: "real hook: an outcome comment's completion signal cancels the watchdog",
    timeoutMs: STUCK_WAIT + MIN,
    run: () =>
      scoped(async (t) => {
        const issue = t.n(await openIssue("Hook completion", "The real hook signals completion; nothing else reports.", "silent"));
        await addLabel(issue, LABELS.AI_READY);
        await sleep(10_000);
        const log = await runHook("issue-build-loop", issue, {
          tool_name: "mcp__github__add_issue_comment",
          tool_input: { body: outcomeComment("issue-build-loop", { outcome: "build_blocked", reason: "e2e: hook completion" }) },
        });
        expect(log, "the hook sent its completion").toContain("sent completion");
        await sleep((WATCHDOG_MINUTES + 1) * MIN);
        const s = await snapshot(issue);
        expectLabels(s, issue, LABELS.AI_READY);
        expect(hasComment(s, "hasn't reported back"), "no watchdog comment").toBe(false);
      }),
  },
  {
    name: "watchdog: stuck build, ready-for-ai re-added -> retried -> ai-blocked",
    timeoutMs: STUCK_WAIT + 2 * MIN,
    run: () =>
      scoped(async (t) => {
        const issue = t.n(await openIssue("Say nothing (retry)", "Dies once, then blocks on the retry.", "silent"));
        await expectStuck(issue, LABELS.AI_READY);
        await setHint(issue, "blocked");
        await addLabel(issue, LABELS.AI_READY);
        expectLabels(await waitFor(issue, labelsAre(LABELS.AI_BLOCKED), MIN), issue, LABELS.AI_BLOCKED);
      }),
  },
  {
    name: "watchdog: stuck release; late release_published -> closed",
    timeoutMs: STUCK_WAIT + 2 * MIN,
    run: () =>
      scoped(async (t) => {
        const issue = t.n(await openIssue("release 0.9.1", "Dies mid-release, publishes late.", "silent"));
        await expectStuck(issue, LABELS.AUTO_RELEASING);
        await lateOutcome(issue, "auto-release-loop", { outcome: "release_published", version: "0.9.1" });
        expect((await waitFor(issue, (s) => s.state === "closed", MIN)).state).toBe("closed");
      }),
  },
  {
    name: "watchdog: stuck release; late release_blocked -> ai-stuck cleared",
    timeoutMs: STUCK_WAIT + 2 * MIN,
    run: () =>
      scoped(async (t) => {
        const issue = t.n(await openIssue("release 0.9.2", "Dies mid-release, blocks late.", "silent"));
        await expectStuck(issue, LABELS.AUTO_RELEASING);
        await lateOutcome(issue, "auto-release-loop", { outcome: "release_blocked", reason: "late" });
        const s = await waitFor(issue, (x) => x.labels.length === 0, MIN);
        expectLabels(s, issue);
        expect(s.state).toBe("open");
      }),
  },
  {
    name: "watchdog: stuck release, auto-release re-added -> retried -> published",
    timeoutMs: STUCK_WAIT + 2 * MIN,
    run: () =>
      scoped(async (t) => {
        const issue = t.n(await openIssue("release 0.9.3", "Dies once, publishes on the retry.", "silent"));
        await expectStuck(issue, LABELS.AUTO_RELEASING);
        await setHint(issue, "published");
        await addLabel(issue, LABELS.AUTO_RELEASING);
        expect((await waitFor(issue, (s) => s.state === "closed", MIN)).state).toBe("closed");
      }),
  },
  {
    name: "watchdog: stuck rework; a late push -> ai-stuck cleared",
    timeoutMs: STUCK_WAIT + 2 * MIN,
    run: () =>
      scoped(async (t) => {
        const pr = await trackedPr(t, { title: "stuck rework late", hint: "silent", files: { [`notes/${Date.now()}.txt`]: "draft\n" } });
        await expectStuck(pr.number, LABELS.AUTO_REWORKING);
        await putFile(pr.branch, `rework/${pr.number}.txt`, "late\n", "e2e: a late rework push");
        expectLabels(await waitFor(pr.number, (x) => x.labels.length === 0, MIN), pr.number);
      }),
  },
  {
    name: "watchdog: stuck rework, auto-rework re-added -> retried -> pushed and cleared",
    timeoutMs: STUCK_WAIT + 2 * MIN,
    run: () =>
      scoped(async (t) => {
        const pr = await trackedPr(t, { title: "stuck rework retry", hint: "silent", files: { [`notes/${Date.now()}.txt`]: "draft\n" } });
        await expectStuck(pr.number, LABELS.AUTO_REWORKING);
        await setHint(pr.number, "rework");
        await addLabel(pr.number, LABELS.AUTO_REWORKING);
        expectLabels(await waitFor(pr.number, (x) => x.labels.length === 0, MIN), pr.number);
      }),
  },
  {
    name: "watchdog: stuck merge-flow, auto-merge re-added -> retried -> merged",
    timeoutMs: STUCK_WAIT + 3 * MIN,
    run: () =>
      scoped(async (t) => {
        const pr = await trackedPr(t, { title: "stuck merge retry", hint: "silent", files: { [`notes/${Date.now()}.txt`]: "ok\n" } });
        await expectStuck(pr.number, LABELS.AUTO_MERGING);
        await setHint(pr.number, "merge");
        await addLabel(pr.number, LABELS.AUTO_MERGING);
        expect((await waitFor(pr.number, (x) => x.merged, 2 * MIN)).merged).toBe(true);
      }),
  },
  {
    name: "watchdog: stuck merge-flow; a human merges it -> closed",
    timeoutMs: STUCK_WAIT + 2 * MIN,
    run: () =>
      scoped(async (t) => {
        const pr = await trackedPr(t, { title: "stuck merge manual", hint: "silent", files: { [`notes/${Date.now()}.txt`]: "ok\n" } });
        await expectStuck(pr.number, LABELS.AUTO_MERGING);
        await waitForChecks(pr.number);
        await merge(pr.number);
        const s = await waitFor(pr.number, (x) => x.state === "closed", MIN);
        expect(s.merged).toBe(true);
      }),
  },
];
