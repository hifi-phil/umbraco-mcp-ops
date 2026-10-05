// Live progress lines while scenarios run, e.g.
//   20:53:49 [CI red before <merge label>] PR #95 +<LABELS.AUTO_MERGING>
//   20:53:52 [CI red before <merge label>] PR #95 labels [<LABELS.AUTO_MERGING>] -> [<LABELS.AUTO_REWORKING>]
// Each line is tagged with the scenario it belongs to (they run
// concurrently). E2E_QUIET=1 turns it off.

import { AsyncLocalStorage } from "node:async_hooks";

const scenario = new AsyncLocalStorage<string>();

/** Runs `fn` with its progress lines tagged `name`, up to its first " -> "
 * (so "watchdog: stuck release; late …" still says which watchdog case). */
export function inScenario<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return scenario.run(name.split(" -> ")[0]!.trim(), fn);
}

export function progress(message: string): void {
  if (process.env.E2E_QUIET) return;
  const time = new Date().toISOString().slice(11, 19);
  const tag = scenario.getStore();
  console.log(`${time} ${tag ? `[${tag}] ` : ""}${message}`);
}
