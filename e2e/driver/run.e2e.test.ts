// Runs the scenarios against the sandbox, stub mode, one at a time. Needs
// the deployed Worker + stub (worker/terraform with e2e_repo set) and your
// `gh` login. E2E_ONLY=<text>[,<text>…] runs just the scenarios whose name
// contains one of them.

import { it } from "vitest";
import { scenarios } from "./scenarios";

const only = process.env.E2E_ONLY?.toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);

for (const s of scenarios) {
  const run = !only || only.some((o) => s.name.toLowerCase().includes(o)) ? it : it.skip;
  run(s.name, s.run, s.timeoutMs);
}
