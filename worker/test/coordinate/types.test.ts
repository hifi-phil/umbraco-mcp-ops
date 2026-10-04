import { describe, expect, it } from "vitest";
import { LABELS } from "@orchestrator/graph/constants/labels";
import { EVENTS } from "@orchestrator/graph/constants/events";
import {
  DEFAULT_CAPS,
  LABEL_JUST_ADDED_BY,
  capsFor,
  coordinateWebhook,
  deriveState,
  resolveEnforced,
  resolveMode,
  shadowDeps,
} from "../../src/coordinate";
import { fakeDeps, input } from "./helpers";

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

describe("capsFor — per-repo caps (CAP_OVERRIDES_JSON)", () => {
  const raw = JSON.stringify({ "Hifi-Phil/MCP-Ops-E2E-Testing": { ciFixAttempts: 1, botReviewReworks: 1 } });

  it("the overridden repo (any case) gets its caps; the ones it doesn't set keep the default", () => {
    expect(capsFor(raw, "hifi-phil", "mcp-ops-e2e-testing")).toEqual({ ...DEFAULT_CAPS, ciFixAttempts: 1, botReviewReworks: 1 });
  });

  it("every other repo, and no JSON at all, keeps the defaults", () => {
    expect(capsFor(raw, "hifi-phil", "umbraco-mcp-ops")).toEqual(DEFAULT_CAPS);
    expect(capsFor(undefined, "hifi-phil", "umbraco-mcp-ops")).toEqual(DEFAULT_CAPS);
    expect(capsFor("{}", "hifi-phil", "umbraco-mcp-ops")).toEqual(DEFAULT_CAPS);
  });

  it("only a whole number of 1 or more counts: 0, negatives, fractions and strings keep the default", () => {
    for (const bad of [0, -1, 1.5, "1"]) {
      const caps = capsFor(JSON.stringify({ "a/b": { ciFixAttempts: bad } }), "a", "b");
      expect(caps.ciFixAttempts, String(bad)).toBe(DEFAULT_CAPS.ciFixAttempts);
    }
  });

  it("invalid JSON throws, naming the setting", () => {
    expect(() => capsFor("{", "a", "b")).toThrow(/CAP_OVERRIDES_JSON/);
  });
});
