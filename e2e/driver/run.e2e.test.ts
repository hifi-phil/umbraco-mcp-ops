// Runs the scenarios against the sandbox, stub mode, one at a time. Needs
// the deployed Worker + stub (worker/terraform with e2e_repo set) and your
// `gh` login. E2E_ONLY=<text> runs just the scenarios whose name contains it.

import { it } from "vitest";
import { scenarios } from "./scenarios";

const only = process.env.E2E_ONLY?.toLowerCase();

for (const s of scenarios) {
  const run = !only || s.name.toLowerCase().includes(only) ? it : it.skip;
  run(s.name, s.run, s.timeoutMs);
}
