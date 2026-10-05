// The scenarios from docs/agent-orchestration/14-e2e-testing.md, plus
// everything else the orchestrator does today. Each one's setup is
// genuinely real (CI really fails, the conflict is real), so a real agent
// given it should end where the hint scripts the stub to; the hint is only
// for the stub. Assertions are on labels, the path the labels took, markers
// and end state, never on comment wording (bar the orchestrator's own fixed
// phrases). Every scenario uses its own issues/PRs, so they run concurrently.

import { expect } from "vitest";
import { LABELS } from "@orchestrator/graph/constants/labels";
import { outcomeComment } from "../stub/src/loops";
import { runHook } from "./hook";
import type { Outcome } from "@orchestrator/graph/outcomes";
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
  removeLabel,
  driverLogin,
  sweep,
  REPO,
  review,
  setHint,
  sleep,
  snapshot,
  statusOf,
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
/** The sandbox's CI-fix and review-round caps (tofu's e2e_rework_cap). */
const CAP = Number(process.env.E2E_REWORK_CAP ?? 1);

/** For the audit (run.e2e.test.ts): an issue whose label delivery to redeliver, and the two PRs sharing a head. */
export const runLog: { redeliverIssue?: number; sharedHead?: number[]; manualOverrideIssue?: number; sweepIssue?: number } = {};

/** Every issue and PR this run's scenarios created (each registers its own,
 * see scoped()), so the audit judges only the run's items, not whatever
 * else touched the sandbox in the same minutes. */
export const runItems = new Set<number>();

const labelsAre = (...want: string[]) => (s: Snapshot) => JSON.stringify(s.labels) === JSON.stringify([...want].sort());
const expectLabels = (s: Snapshot, n: number, ...want: string[]) => expect(s.labels, `#${n} labels`).toEqual([...want].sort());
const hasComment = (s: Snapshot, ...parts: string[]) => s.comments.some((c) => parts.every((p) => c.includes(p)));

type Track = { n: (x: number) => number; branch: (b: string) => string };

/** Runs `body`, then closes and deletes whatever it registered. */
async function scoped(body: (t: Track) => Promise<void>) {
  const numbers: number[] = [];
  const branches: string[] = [];
  try {
    await body({ n: (x) => (numbers.push(x), runItems.add(x), x), branch: (b) => (branches.push(b), b) });
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

/** A loop that never reports: the trigger goes on, and the watchdog moves it to {@link LABELS.AI_STUCK}. */
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
  // GitHub can show the outcome a moment before the webhook that logs it has
  // run (found on #251: merged on GitHub, its row a second behind), so give
  // the log a few seconds to catch up before checking it.
  const last = typeof want.at(-1) === "string" ? (want.at(-1) as string) : (want.at(-1) as { event: string }).event;
  let rows = await transitions(n);
  for (let tries = 0; tries < 6 && !rows.some((r) => r.event === last); tries++) {
    await sleep(5000);
    rows = await transitions(n);
  }
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
    name: `full lane: build -> PR -> ${LABELS.AUTO_MERGING} -> merged, then release -> published`,
    timeoutMs: 8 * MIN,
    run: () =>
      scoped(async (t) => {
        const issue = t.n(await openIssue("Add a build note", "Add a file under builds/ for this issue.", "success"));
        await addLabel(issue, LABELS.AI_READY);
        const built = await waitFor(issue, labelsAre(LABELS.PR_OPEN), 2 * MIN);
        expectLabels(built, issue, LABELS.PR_OPEN);
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
          { event: "build_succeeded", effect: LABELS.PR_OPEN },
        );
        await expectLogged(pr, { event: "labelled_auto_merging", run: "merge-flow" }, { event: "merged", effect: "close" });
        await expectLogged(release, { event: "labelled_auto_releasing", run: "auto-release-loop" }, { event: "release_published", effect: "close" });

        // The live-status view: the built issue shows its last run; a closed
        // PR or release has no row.
        expect(await statusOf(issue), `#${issue} status`).toMatchObject({
          state: LABELS.PR_OPEN,
          routine: "issue-build-loop",
          attempt: 1,
          running: 0,
        });
        // After the close's own webhooks have all landed (issues.closed comes
        // after the Worker's own close, and must not put the row back).
        await sleep(20_000);
        expect(await statusOf(pr), `PR #${pr} status, closed`).toBeUndefined();
        expect(await statusOf(release), `#${release} status, closed`).toBeUndefined();
      }),
  },
  {
    name: `build blocked: ${LABELS.AI_READY} -> ${LABELS.AI_BLOCKED}`,
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
    name: `live status: a release closed by hand with ${LABELS.AUTO_RELEASING} still on -> its row goes`,
    timeoutMs: 2 * MIN,
    run: () =>
      scoped(async (t) => {
        // issue_closed from LABELS.AUTO_RELEASING is a noop rule that applies; the
        // row must still go, whatever order the close's webhooks land in.
        const issue = t.n(await openIssue("Close me mid-release", "A person closes this while it's releasing.", "silent"));
        await addLabel(issue, LABELS.AUTO_RELEASING);
        let row = await statusOf(issue);
        for (let tries = 0; tries < 10 && !row; tries++) {
          await sleep(3000);
          row = await statusOf(issue);
        }
        expect(row, `#${issue} status, releasing`).toMatchObject({ state: LABELS.AUTO_RELEASING, routine: "auto-release-loop", running: 1 });

        await gh("PATCH", `/repos/${REPO}/issues/${issue}`, { state: "closed" });
        await expectLogged(issue, { event: "labelled_auto_releasing", run: "auto-release-loop" }, { event: "issue_closed", effect: "noop" });
        await sleep(10_000);
        expect(await statusOf(issue), `#${issue} status, closed`).toBeUndefined();
      }),
  },
  {
    name: `manual override: a human clears ${LABELS.AI_BLOCKED} -> logged as manual_override, nothing else done`,
    timeoutMs: 3 * MIN,
    run: () =>
      scoped(async (t) => {
        const issue = t.n(await openIssue("Clear a block by hand", "Blocks, then a maintainer clears it.", "blocked"));
        runLog.manualOverrideIssue = issue;
        await addLabel(issue, LABELS.AI_READY);
        expectLabels(await waitFor(issue, labelsAre(LABELS.AI_BLOCKED), 2 * MIN), issue, LABELS.AI_BLOCKED);

        await removeLabel(issue, LABELS.AI_BLOCKED);
        const rows = await expectLogged(issue, "build_blocked", "manual_override");
        const override = rows.find((r) => r.event === "manual_override")!;
        expect(override.from_state).toBe(LABELS.AI_BLOCKED);
        expect(JSON.parse(override.to_effect!)).toEqual({ kind: "manual", change: `-${LABELS.AI_BLOCKED}`, by: await driverLogin(), now: "none" });
        await sleep(10_000); // and the Worker did nothing about it
        expectLabels(await snapshot(issue), issue);
      }),
  },
  {
    name: `release blocked: ${LABELS.AUTO_RELEASING} removed, issue stays open`,
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
    name: `review rework: ${LABELS.AUTO_REWORKING} -> push -> label cleared`,
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
    name: `discussion: ${LABELS.AI_DISCUSSING} -> a round, a human reply -> the next round; '//' replies are ignored`,
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
    name: `CI red before ${LABELS.AUTO_MERGING}: ${LABELS.AUTO_REWORKING} at label time -> fix -> ${LABELS.AUTO_MERGING} -> merged`,
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
        expect(hasComment(s, "🔧 CI failing", `attempt 1 of ${CAP}`)).toBe(true);
      }),
  },
  {
    name: `CI red after ${LABELS.AUTO_MERGING}: the check_suite path -> ${LABELS.AUTO_REWORKING} -> fix -> merged`,
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
        expect(hasComment(s, "🔧 CI failing", `attempt 1 of ${CAP}`)).toBe(true);
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
    name: `CI-fix limit: fixes that don't fix it, up to the cap -> ${LABELS.MERGE_BLOCKED}`,
    timeoutMs: (4 + 3 * CAP) * MIN,
    run: () =>
      scoped(async (t) => {
        const pr = await trackedPr(t, { title: "ci never fixed", hint: "ci_never_fixed", files: { "ci-state": "fail\n" } });
        await addLabel(pr.number, LABELS.AUTO_MERGING);
        const s = await waitFor(pr.number, labelsAre(LABELS.MERGE_BLOCKED), (3 + 3 * CAP) * MIN);
        expectLabels(s, pr.number, LABELS.MERGE_BLOCKED);
        expect(s.merged).toBe(false);
        const reworks = (await labelHistory(pr.number)).filter((h) => h === `+${LABELS.AUTO_REWORKING}`);
        expect(reworks.length, "rework rounds").toBe(CAP);
        expect(hasComment(s, `after ${CAP} fix attempts`)).toBe(true);
        const rows = await expectLogged(pr.number, { event: "merge_gate_failed_hard", effect: LABELS.MERGE_BLOCKED });
        expect(rows.filter((r) => r.event === "merge_gate_failed_soft"), "a soft fail per fix").toHaveLength(CAP);
        expect(rows.filter((r) => r.event === "ci_fix_pushed"), "a CI-fix push per fix").toHaveLength(CAP);
      }),
  },
  {
    name: `merge conflict -> ${LABELS.MERGE_BLOCKED}; fixed and ${LABELS.AUTO_MERGING} re-added -> merged`,
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
    name: `requested changes -> ${LABELS.MERGE_BLOCKED}; approved and ${LABELS.AUTO_MERGING} re-added -> merged`,
    timeoutMs: 6 * MIN,
    run: () =>
      scoped(async (t) => {
        const pr = await trackedPr(t, { title: "changes requested", hint: "merge", files: { [`notes/${Date.now()}.txt`]: "draft\n" } });
        const asked = await review(pr.number, "REQUEST_CHANGES");
        expect(asked.by, "reviewed as the App's bot, not the PR's author").toMatch(/\[bot\]$/);

        await addLabel(pr.number, LABELS.AUTO_MERGING);
        const blocked = await waitFor(pr.number, labelsAre(LABELS.MERGE_BLOCKED), 2 * MIN);
        expectLabels(blocked, pr.number, LABELS.MERGE_BLOCKED);
        expect(hasComment(blocked, "changes requested"), `#${pr.number} block reason`).toBe(true);

        await review(pr.number, "APPROVE");
        await addLabel(pr.number, LABELS.AUTO_MERGING);
        const merged = await waitFor(pr.number, (x) => x.merged, 4 * MIN);
        expect(merged.merged, `PR #${pr.number} merged after approval`).toBe(true);
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

  // --- The watchdog and LABELS.AI_STUCK (the sandbox's watchdog is real, short) --------
  {
    name: `watchdog: silent build -> ${LABELS.AI_STUCK}; late build_succeeded -> ${LABELS.PR_OPEN}`,
    timeoutMs: STUCK_WAIT + 2 * MIN,
    run: () =>
      scoped(async (t) => {
        const issue = t.n(await openIssue("Say nothing (late success)", "The agent reports long after the watchdog.", "silent"));
        const stuck = await expectStuck(issue, LABELS.AI_READY);
        expect(hasComment(stuck, "No progress step was ever reported")).toBe(true);
        await lateOutcome(issue, "issue-build-loop", { outcome: "build_succeeded", pr: 1 });
        expectLabels(await waitFor(issue, labelsAre(LABELS.PR_OPEN), MIN), issue, LABELS.PR_OPEN);
      }),
  },
  {
    name: `watchdog: a heartbeat is quoted by the expiry; late build_blocked -> ${LABELS.AI_BLOCKED}`,
    timeoutMs: STUCK_WAIT + 2 * MIN,
    run: () =>
      scoped(async (t) => {
        const issue = t.n(await openIssue("Say little (heartbeat)", "The agent reports one step, then dies.", "heartbeat"));
        const stuck = await expectStuck(issue, LABELS.AI_READY);
        expect(hasComment(stuck, "Last reported step: `e2e-heartbeat`")).toBe(true);
        // The live-status view keeps where the dead run got to.
        expect(await statusOf(issue), `#${issue} status, stuck`).toMatchObject({
          state: LABELS.AI_STUCK,
          routine: "issue-build-loop",
          running: 0,
          last_step: "e2e-heartbeat",
        });
        await lateOutcome(issue, "issue-build-loop", { outcome: "build_blocked", reason: "late" });
        expectLabels(await waitFor(issue, labelsAre(LABELS.AI_BLOCKED), MIN), issue, LABELS.AI_BLOCKED);
        expect(await statusOf(issue), `#${issue} status, blocked`).toMatchObject({ state: LABELS.AI_BLOCKED });
      }),
  },
  {
    name: `watchdog: a completion signal cancels the watchdog (no ${LABELS.AI_STUCK})`,
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
    name: "sweep: a fire that never got out -> re-fired once idle twice its timeout",
    timeoutMs: (2 * WATCHDOG_MINUTES + 4) * MIN,
    run: () =>
      scoped(async (t) => {
        // The stub refuses the fire: no watchdog, no log row, the label left
        // on. Nothing but the sweep will ever look at it again.
        const issue = t.n(await openIssue("Left behind", "Its fire never gets out; the sweep finds it.", "fail_fire"));
        runLog.sweepIssue = issue;
        const key = `${REPO}#${issue}`.toLowerCase();
        await addLabel(issue, LABELS.AI_READY);
        await sleep(15_000); // the Worker's fire, and its retries, refused
        await setHint(issue, "blocked"); // what the re-fire will find (and its last activity)

        await sleep(45_000);
        expect((await sweep()).refired.map((r) => r.toLowerCase()), "too recent to re-fire").not.toContain(key);

        await sleep(2 * WATCHDOG_MINUTES * MIN - 45_000 + 30_000); // past twice the timeout since that edit
        // The deployed alarm sweep may get there first; either way the log
        // below must show exactly that re-fire.
        await sweep();
        expectLabels(await waitFor(issue, labelsAre(LABELS.AI_BLOCKED), MIN), issue, LABELS.AI_BLOCKED);
        await expectLogged(
          issue,
          { event: "reconcile_refire", run: "issue-build-loop" },
          { event: "build_blocked", effect: LABELS.AI_BLOCKED },
        );
      }),
  },
  {
    name: `watchdog: stuck build, ${LABELS.AI_READY} re-added -> retried -> ${LABELS.AI_BLOCKED}`,
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
    name: `watchdog: stuck release; late release_blocked -> ${LABELS.AI_STUCK} cleared`,
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
    name: `watchdog: stuck release, ${LABELS.AUTO_RELEASING} re-added -> retried -> published`,
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
    name: `watchdog: stuck rework; a late push -> ${LABELS.AI_STUCK} cleared`,
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
    name: `watchdog: stuck rework, ${LABELS.AUTO_REWORKING} re-added -> retried -> pushed and cleared`,
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
    name: `watchdog: stuck merge-flow, ${LABELS.AUTO_MERGING} re-added -> retried -> merged`,
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
  // --- The review (15-agent-splits.md) ---------------------------------------
  {
    name: `review: ${LABELS.AI_REVIEWING} on a green PR -> review-loop -> passed -> unlabelled; re-added -> reviewed again`,
    timeoutMs: 6 * MIN,
    run: () =>
      scoped(async (t) => {
        const pr = await trackedPr(t, { title: "review pass", hint: "review_pass", files: { [`notes/${Date.now()}.txt`]: "draft\n" } });
        await waitForChecks(pr.number);
        await addLabel(pr.number, LABELS.AI_REVIEWING);
        const passed = await waitFor(pr.number, (s) => s.labels.length === 0 && hasMarker(s, "review-loop", "review_passed"), 2 * MIN);
        expectLabels(passed, pr.number);
        await expectLogged(
          pr.number,
          "labelled_ai_reviewing",
          { event: "review_ci_passed", run: "review-loop" },
          { event: "review_passed", effect: "unlabel" },
        );

        // A person re-running it (say after editing the PR by hand).
        await addLabel(pr.number, LABELS.AI_REVIEWING);
        const twice = (s: Snapshot) =>
          s.labels.length === 0 && s.comments.filter((c) => c.includes('"outcome":"review_passed"')).length === 2;
        expectLabels(await waitFor(pr.number, twice, 2 * MIN), pr.number);
        const rows = await transitions(pr.number);
        expect(rows.filter((r) => r.event === "review_ci_passed"), "two reviews fired").toHaveLength(2);
      }),
  },
  {
    name: "review: findings -> rework-loop -> push -> CI -> reviewed again -> passed",
    timeoutMs: 9 * MIN,
    run: () =>
      scoped(async (t) => {
        const pr = await trackedPr(t, { title: "review findings", hint: "review_findings_once", files: { [`notes/${Date.now()}.txt`]: "draft\n" } });
        // Labelled at once, before CI has finished: the check_suite path fires the review.
        await addLabel(pr.number, LABELS.AI_REVIEWING);
        const s = await waitFor(pr.number, (x) => x.labels.length === 0 && hasMarker(x, "review-loop", "review_passed"), 8 * MIN);
        expectLabels(s, pr.number);
        expect(hasComment(s, `Review round 1 of ${CAP}`)).toBe(true);
        const commits = await gh<unknown[]>("GET", `/repos/${REPO}/pulls/${pr.number}/commits`);
        expect(commits.length, "the stub's rework push").toBe(2);
        await expectLogged(
          pr.number,
          { event: "review_ci_passed", run: "review-loop" },
          { event: "review_findings", effect: LABELS.AUTO_REWORKING, run: "rework-loop" },
          { event: "review_fix_pushed", effect: LABELS.AI_REVIEWING },
          { event: "review_ci_passed", run: "review-loop" },
          { event: "review_passed", effect: "unlabel" },
        );
      }),
  },
  {
    name: `review: blocked -> ${LABELS.AI_BLOCKED}, waits; a person re-adds ${LABELS.AI_REVIEWING} -> reviewed again -> passed`,
    timeoutMs: 6 * MIN,
    run: () =>
      scoped(async (t) => {
        const pr = await trackedPr(t, { title: "review block", hint: "review_block", files: { [`notes/${Date.now()}.txt`]: "draft\n" } });
        await waitForChecks(pr.number);
        await addLabel(pr.number, LABELS.AI_REVIEWING);
        const blocked = await waitFor(pr.number, labelsAre(LABELS.AI_BLOCKED), 2 * MIN);
        expectLabels(blocked, pr.number, LABELS.AI_BLOCKED);
        await expectLogged(pr.number, { event: "review_ci_passed", run: "review-loop" }, { event: "review_blocked", effect: LABELS.AI_BLOCKED });

        await setHint(pr.number, "review_pass");
        await addLabel(pr.number, LABELS.AI_REVIEWING);
        const passed = await waitFor(pr.number, (s) => s.labels.length === 0 && hasMarker(s, "review-loop", "review_passed"), 2 * MIN);
        expectLabels(passed, pr.number);
      }),
  },
  {
    name: `review: CI red under ${LABELS.AI_REVIEWING} -> CI fix -> back to ${LABELS.AI_REVIEWING} -> passed`,
    timeoutMs: 9 * MIN,
    run: () =>
      scoped(async (t) => {
        const pr = await trackedPr(t, { title: "review ci red", hint: "review_ci_fail", files: { "ci-state": "fail\n" } });
        await addLabel(pr.number, LABELS.AI_REVIEWING);
        const s = await waitFor(pr.number, (x) => x.labels.length === 0 && hasMarker(x, "review-loop", "review_passed"), 8 * MIN);
        expectLabels(s, pr.number);
        expect(hasComment(s, "🔧 CI failing", `attempt 1 of ${CAP}`)).toBe(true);
        await expectLogged(
          pr.number,
          { event: "review_ci_failed", effect: LABELS.AUTO_REWORKING, run: "rework-loop" },
          { event: "review_fix_pushed", effect: LABELS.AI_REVIEWING },
          { event: "review_ci_passed", run: "review-loop" },
          { event: "review_passed", effect: "unlabel" },
        );
      }),
  },
  {
    name: `review: findings every round -> ${LABELS.AI_STUCK} once past the cap`,
    timeoutMs: (5 + 3 * CAP) * MIN,
    run: () =>
      scoped(async (t) => {
        const pr = await trackedPr(t, { title: "review never passes", hint: "review_findings_always", files: { [`notes/${Date.now()}.txt`]: "draft\n" } });
        await addLabel(pr.number, LABELS.AI_REVIEWING);
        const s = await waitFor(pr.number, labelsAre(LABELS.AI_STUCK), (4 + 3 * CAP) * MIN);
        expectLabels(s, pr.number, LABELS.AI_STUCK);
        expect(hasComment(s, `asked for changes ${CAP} times`)).toBe(true);
        const rows = await expectLogged(pr.number, { event: "rework_cap_reached", effect: LABELS.AI_STUCK });
        expect(rows.filter((r) => r.event === "review_findings"), "a counted round per finding, up to the cap").toHaveLength(CAP);
        expect(rows.filter((r) => r.event === "review_fix_pushed"), `a push back to ${LABELS.AI_REVIEWING} per round`).toHaveLength(CAP);
      }),
  },
];
