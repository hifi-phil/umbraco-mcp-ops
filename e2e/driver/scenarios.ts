// The scenarios, as data. Each one's setup is genuinely real, so a real
// agent given it should end where the hint scripts the stub to (real mode
// comes later; see 14-e2e-testing.md). Assertions are on labels, markers
// and end state, never on comment wording.

import { LABELS } from "../../graph/constants/labels";

export type Scenario = {
  name: string;
  issue: { title: string; body: string };
  /** What the stub does, as `<!-- e2e: <hint> -->` on the issue. */
  hint: string;
  /** The label the driver adds, as a maintainer would. */
  trigger: string;
  expect: {
    /** The labels once settled, exactly. */
    labels: string[];
    state: "open" | "closed";
    /** Outcome markers that must appear, e.g. `issue-build-loop` + `build_blocked`. */
    markers?: { loop: string; outcome: string }[];
  };
  timeoutMs: { stub: number };
};

export const scenarios: Scenario[] = [
  {
    name: "build blocked: ready-for-ai -> ai-blocked",
    issue: {
      title: "Add a flux capacitor to ci-state",
      body: "Needs a design decision nobody has made yet: what should a flux capacitor do here? Block until a human decides.",
    },
    hint: "blocked",
    trigger: LABELS.AI_READY,
    expect: {
      labels: [LABELS.AI_BLOCKED],
      state: "open",
      markers: [{ loop: "issue-build-loop", outcome: "build_blocked" }],
    },
    timeoutMs: { stub: 2 * 60_000 },
  },
];
