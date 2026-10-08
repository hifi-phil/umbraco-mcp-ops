// Runs the scenarios against the sandbox, stub mode, several at a time (each
// uses its own issues and PRs), then audits every answer the orchestrator
// gave during the run. Needs the deployed Worker + stub (worker/terraform
// with e2e_repo set) and your `gh` login. E2E_ONLY=<text>[,<text>…] runs
// just the scenarios whose name contains one of them.

import { describe, expect, it } from "vitest";
import { deliveriesSince, deliveryDetail, redeliver, REPO, sleep, transitions, workerHook, type DeliveryDetail } from "./github";
import { inScenario, progress } from "./progress";
import { runItems, runLog, scenarios } from "./scenarios";

const only = process.env.E2E_ONLY?.toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
const runStart = new Date(Date.now() - 5_000).toISOString().replace(/\.\d+Z$/, "Z");

/**
 * Each scenario gets one retry: real GitHub has slow moments (05-10-2026:
 * Actions took 2 min on one PR, so the sandbox's 2-minute watchdog expired
 * as CI went green). A retry can't hide a real fault: every attempt's
 * issues and PRs stay in the audit (runItems), and a retry is announced.
 */
const RETRIES = 1;

describe.concurrent("scenarios", () => {
  for (const s of scenarios) {
    const run = !only || only.some((o) => s.name.toLowerCase().includes(o)) ? it : it.skip;
    let attempt = 0;
    run(
      s.name,
      () =>
        inScenario(s.name, async () => {
          // Each attempt keeps its own number. A timed-out attempt isn't
          // cancelled (its promise runs on), so once a newer one has started
          // it says nothing more, rather than logging under the retry's number.
          const mine = ++attempt;
          const current = () => mine === attempt;
          const start = Date.now();
          progress(mine === 1 ? "start" : `RETRY ${mine}/${RETRIES + 1}`);
          try {
            await s.run();
            if (current()) progress(`PASSED in ${Math.round((Date.now() - start) / 1000)}s${mine > 1 ? ` (on attempt ${mine})` : ""}`);
          } catch (e) {
            if (current()) progress(`FAILED after ${Math.round((Date.now() - start) / 1000)}s: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
            throw e;
          }
        }),
      { timeout: s.timeoutMs, retry: RETRIES },
    );
  }
});

/** Runs `fn` over `items`, `n` at a time. */
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

describe("audit: every answer the orchestrator gave during the run", () => {
  it(
    "no delivery errored, the table had a rule for everything, a shared-head check_suite fanned out, and a redelivery is deduped",
    async () => {
      await sleep(15_000); // the last scenarios' echoes
      const hook = await workerHook();
      const deliveries = await deliveriesSince(hook, runStart);
      progress(`audit: checking the orchestrator's answers to ${deliveries.length} deliveries`);
      // The App's hook delivers for every repo it's installed on: keep the
      // sandbox's. And only what's about this run: a delivery only about
      // items it didn't create (another run's leftovers being closed just
      // before this one, say) isn't its to judge. One about no item at all
      // (a check_suite with no PR) still is.
      const ours = (d: DeliveryDetail) => d.numbers.length === 0 || d.numbers.some((n) => runItems.has(n));
      const details: (DeliveryDetail & { id: string })[] = (
        await pool(deliveries, 6, async (d) => ({ id: d.id, ...(await deliveryDetail(hook, d.id)) }))
      ).filter((d) => d.repo.toLowerCase() === REPO.toLowerCase() && ours(d));
      const line = (d: DeliveryDetail) => `${d.event}.${d.action} #${d.numbers.join(",")} -> ${d.statusCode} ${d.response}`;

      // The sweep scenario's refused fire is scripted; any other failure isn't.
      const scripted = (d: DeliveryDetail) => d.numbers.includes(runLog.sweepIssue ?? -1) && d.response.includes("scripted fire failure");
      const failed = details.filter((d) => (d.statusCode >= 400 || d.response.includes('"outcome":"error"')) && !scripted(d));
      expect(failed.map(line), "deliveries the Worker failed").toEqual([]);
      // Answered 202 (the Worker's answer deadline, under GitHub's 10 s):
      // not a failure, the work finished in the background, but worth seeing.
      const late = details.filter((d) => d.statusCode === 202);
      if (late.length > 0) progress(`audit: ${late.length} delivery(s) answered late (202): ${late.map(line).join("; ")}`);
      const noRule = details.filter((d) => d.response.includes('"outcome":"dropped_no_rule"'));
      expect(noRule.map(line), "events the table had no rule for").toEqual([]);

      // The D1 log agrees, delivery by delivery: every issue/PR in the run
      // logged only enforced, applied rows (the sandbox Worker enforces, and
      // nothing was dropped); every delivery the Worker applied has exactly
      // one row, carrying its delivery id and event (bar two cases, two rows
      // ending in the event it answered: LABELS.AI_REVIEWING added applies its
      // label rule, then the CI gate's; and release_approved, then the
      // Worker's own merge, release_merged); and the only rows no delivery caused are
      // the watchdog's own expiries.
      const numbers = [...new Set(details.flatMap((d) => d.numbers))].filter((n) => runItems.has(n));
      progress(`audit: reading the D1 log for ${numbers.length} issues and PRs`);
      const logs = new Map(await pool(numbers, 6, async (n) => [n, await transitions(n)] as const));
      const badRows = [...logs].flatMap(([n, rows]) =>
        rows.filter((r) => r.mode !== "enforce" || r.dropped_reason !== null).map((r) => `#${n} ${r.event}: ${r.mode} ${r.dropped_reason ?? ""}`),
      );
      expect(badRows, "log rows not enforced-and-applied").toEqual([]);
      const unmatched = details
        .filter((d) => d.response.includes('"outcome":"applied"') && d.numbers.length === 1)
        .filter((d) => {
          const event = d.response.match(/"event":"([a-z_]+)"/)?.[1];
          const rows = logs.get(d.numbers[0]!)?.filter((r) => r.delivery_id === d.guid) ?? [];
          const labelThenGate = rows.length === 2 && rows[0]!.event === "labelled_ai_reviewing" && event !== "labelled_ai_reviewing";
          const approvedThenMerged = rows.length === 2 && rows[0]!.event === "release_approved" && event === "release_merged";
          if (labelThenGate || approvedThenMerged) return rows[1]!.event !== event;
          return rows.length !== 1 || rows[0]!.event !== event;
        });
      expect(unmatched.map(line), "applied deliveries without exactly one matching row").toEqual([]);
      // Nothing but the manual-override scenario's own edit may log one: the
      // Worker's label changes (its App bot), the stub's actions and the
      // driver's trigger labels must never be mistaken for a person's edit.
      const overrides = [...logs].flatMap(([n, rows]) =>
        rows.filter((r) => r.event === "manual_override" && n !== runLog.manualOverrideIssue).map((r) => `#${n} ${r.to_effect}`),
      );
      expect(overrides, "manual_override rows outside the override scenario").toEqual([]);
      // And only the sweep scenario's issue was left behind: the sweep
      // re-firing anything else would mean it misread a live run.
      const refires = [...logs].flatMap(([n, rows]) =>
        rows.filter((r) => r.event === "reconcile_refire" && n !== runLog.sweepIssue).map((r) => `#${n} ${r.from_state} ${r.run}`),
      );
      expect(refires, "reconcile_refire rows outside the sweep scenario").toEqual([]);
      const guids = new Set(details.map((d) => d.guid));
      // A hand-off between items (a merged PR to the issue it closes, a
      // release to the issues it ships) logs under the original delivery's
      // id plus ":#<item>".
      const original = (id: string) => id.replace(/:#\d+$/, "");
      const orphans = [...logs].flatMap(([n, rows]) =>
        rows
          .filter((r) =>
            r.delivery_id === null
              ? !["watchdog_expired", "watchdog_retried", "reconcile_refire"].includes(r.event)
              : !guids.has(original(r.delivery_id)),
          )
          .map((r) => `#${n} ${r.event} delivery=${r.delivery_id}`),
      );
      expect(orphans, "log rows no delivery in the run explains").toEqual([]);

      if (runLog.sharedHead) {
        const [a, b] = runLog.sharedHead;
        const fanned = details.find(
          (d) => d.event === "check_suite" && d.numbers.includes(a!) && d.numbers.includes(b!) && d.response.includes('"routed"'),
        );
        expect(fanned && line(fanned), `a check_suite routed to both #${a} and #${b}`).toBeTruthy();
      }

      if (runLog.redeliverIssue) {
        const original = details.find(
          (d) => d.event === "issues" && d.action === "labeled" && d.numbers.includes(runLog.redeliverIssue!) && d.response.includes('"applied"'),
        );
        expect(original, `#${runLog.redeliverIssue}'s applied label delivery`).toBeTruthy();
        await redeliver(hook, original!.id);
        let answer: string | undefined;
        for (let i = 0; i < 10 && !answer; i++) {
          await sleep(3000);
          const recent = await deliveriesSince(hook, new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, "Z"));
          const again = recent.find((d) => d.redelivery && d.event === "issues" && d.guid === original!.guid);
          if (again) answer = (await deliveryDetail(hook, again.id)).response;
        }
        expect(answer, "the redelivery's answer").toBe('{"outcome":"deduped"}');
      }
    },
    5 * 60_000,
  );
});
