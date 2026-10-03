import { describe,expect,it } from "vitest";
import { LABELS } from "@orchestrator/graph/constants/labels";
import { EVENTS } from "@orchestrator/graph/constants/events";
import {
LABEL_JUST_ADDED_BY,
coordinateWebhook,deriveState,resolveEnforced,
resolveMode,
shadowDeps
} from "../../src/coordinate";
import { fakeDeps,input } from "./helpers";

describe("LABEL_JUST_ADDED_BY — completeness", () => {
  it("has an entry for every labelled_* event in EVENTS", () => {
    const labelledEvents = Object.values(EVENTS).filter((e) => e.startsWith("labelled_"));
    for (const e of labelledEvents) {
      expect(LABEL_JUST_ADDED_BY, `missing an entry for ${e}`).toHaveProperty(e);
    }
  });
});

describe("deriveState", () => {
  it("no tracked label -> none", () => {
    expect(deriveState(["dependencies"])).toBe("none");
  });

  it("exactly one tracked label -> that label", () => {
    expect(deriveState([LABELS.AI_READY, "dependencies"])).toBe(LABELS.AI_READY);
  });

  it("more than one tracked label -> ambiguous", () => {
    expect(deriveState([LABELS.AI_READY, LABELS.AI_DISCUSSING])).toBe("ambiguous");
  });
});

describe("resolveMode — fails safe to shadow", () => {
  it('only the exact string "enforce" enforces', () => {
    expect(resolveMode("enforce")).toBe("enforce");
    for (const raw of [undefined, "", "shadow", "enforced", "ENFORCE", " enforce"]) {
      expect(resolveMode(raw), `MODE=${JSON.stringify(raw)}`).toBe("shadow");
    }
  });
});

describe("shadowDeps", () => {
  it("runs the same decision path but reaches none of the write deps", async () => {
    const deps = fakeDeps();
    const result = await coordinateWebhook(
      shadowDeps(deps),
      input({
        payload: { action: "issues.labeled", label: { name: LABELS.AI_READY }, sender: { login: "phil", type: "User" } },
      }),
    );

    expect(result.outcome).toBe("applied");
    for (const write of ["addLabel", "removeLabel", "closeIssue", "commentOnIssue", "fireRoutine"] as const) {
      expect(deps[write], write).not.toHaveBeenCalled();
    }
    expect(deps.logTransition).toHaveBeenCalledTimes(1);
    expect(deps.setPendingFire).toHaveBeenCalledTimes(1);
  });
});

describe("resolveEnforced — MODE plus the watchdog's own switch (Phase 4)", () => {
  it("MODE=enforce enforces every event except the watchdog", () => {
    const enforced = resolveEnforced("enforce", undefined);
    expect(enforced(EVENTS.LABELLED_AI_READY)).toBe(true);
    expect(enforced(EVENTS.MERGED)).toBe(true);
    expect(enforced(EVENTS.WATCHDOG_EXPIRED)).toBe(false);
  });

  it("WATCHDOG=enforce adds the watchdog, but only under MODE=enforce", () => {
    expect(resolveEnforced("enforce", "enforce")(EVENTS.WATCHDOG_EXPIRED)).toBe(true);
    expect(resolveEnforced(undefined, "enforce")(EVENTS.WATCHDOG_EXPIRED)).toBe(false);
  });

  it("anything but exactly \"enforce\" is shadow (fails towards shadow)", () => {
    for (const raw of [undefined, "", "shadow", "enforced", "ENFORCE"]) {
      expect(resolveEnforced(raw, "enforce")(EVENTS.LABELLED_AUTO_MERGING), String(raw)).toBe(false);
    }
  });
});
