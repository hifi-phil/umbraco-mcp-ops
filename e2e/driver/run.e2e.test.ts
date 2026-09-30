// Runs the scenarios against the sandbox, stub mode, several at a time (each
// uses its own issues and PRs), then audits every answer the orchestrator
// gave during the run. Needs the deployed Worker + stub (worker/terraform
// with e2e_repo set) and your `gh` login. E2E_ONLY=<text>[,<text>…] runs
// just the scenarios whose name contains one of them.

import { describe, expect, it } from "vitest";
import { deliveriesSince, deliveryDetail, redeliver, sleep, workerHookId, type DeliveryDetail } from "./github";
import { runLog, scenarios } from "./scenarios";

const only = process.env.E2E_ONLY?.toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
const runStart = new Date(Date.now() - 5_000).toISOString().replace(/\.\d+Z$/, "Z");

describe.concurrent("scenarios", () => {
  for (const s of scenarios) {
    const run = !only || only.some((o) => s.name.toLowerCase().includes(o)) ? it : it.skip;
    run(s.name, s.run, s.timeoutMs);
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
      const hook = await workerHookId();
      const deliveries = await deliveriesSince(hook, runStart);
      const details: (DeliveryDetail & { id: string })[] = await pool(deliveries, 6, async (d) => ({
        id: d.id,
        ...(await deliveryDetail(hook, d.id)),
      }));
      const line = (d: DeliveryDetail) => `${d.event}.${d.action} #${d.numbers.join(",")} -> ${d.statusCode} ${d.response}`;

      const failed = details.filter((d) => d.statusCode >= 400 || d.response.includes('"outcome":"error"'));
      expect(failed.map(line), "deliveries the Worker failed").toEqual([]);
      const noRule = details.filter((d) => d.response.includes('"outcome":"dropped_no_rule"'));
      expect(noRule.map(line), "events the table had no rule for").toEqual([]);

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
          const again = recent.find((d) => d.redelivery && d.event === "issues");
          if (again) answer = (await deliveryDetail(hook, again.id)).response;
        }
        expect(answer, "the redelivery's answer").toBe('{"outcome":"deduped"}');
      }
    },
    5 * 60_000,
  );
});
