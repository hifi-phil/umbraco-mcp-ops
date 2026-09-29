import { describe, expect, it } from "vitest";
import { EVENTS } from "./constants/events";
import { LABELS } from "./constants/labels";
import { ROUTINES } from "./constants/routines";
import { close, label, noop, unlabel } from "./github/to-github";
import { isWatched, reduce, rules } from "./graph";

describe("reduce — issue lifecycle", () => {
  it("none + labelled_ai_ready -> ready-for-ai, fires issue-build-loop", () => {
    const rule = reduce("none", EVENTS.LABELLED_AI_READY);
    expect(rule?.to).toEqual(label(LABELS.AI_READY));
    expect(rule?.run).toBe(ROUTINES.ISSUE_BUILD_LOOP);
  });

  it("generated-by-ai + build_succeeded -> noop (the loop's own swap already applied it; keyed post-swap since AI_READY is gone by the time this fires)", () => {
    expect(reduce(LABELS.AI_GENERATED, EVENTS.BUILD_SUCCEEDED)?.to).toEqual(noop);
    expect(reduce(LABELS.AI_READY, EVENTS.BUILD_SUCCEEDED)).toBeNull();
  });

  it("ai-blocked + build_blocked -> noop (same reasoning, keyed post-swap)", () => {
    expect(reduce(LABELS.AI_BLOCKED, EVENTS.BUILD_BLOCKED)?.to).toEqual(noop);
    expect(reduce(LABELS.AI_READY, EVENTS.BUILD_BLOCKED)).toBeNull();
  });

  it("none + release_blocked -> noop (the loop's own removal already applied it; keyed post-swap since AUTO_RELEASING is gone by the time this fires)", () => {
    expect(reduce("none", EVENTS.RELEASE_BLOCKED)?.to).toEqual(noop);
    expect(reduce(LABELS.AUTO_RELEASING, EVENTS.RELEASE_BLOCKED)).toBeNull();
  });

  it("auto-release + release_published -> native close, not a label", () => {
    expect(reduce(LABELS.AUTO_RELEASING, EVENTS.RELEASE_PUBLISHED)?.to).toEqual(close);
  });

  it("ai-discuss has no outbound rules — human-owned by design", () => {
    expect(reduce(LABELS.AI_DISCUSSING, EVENTS.LABELLED_AI_READY)).toBeNull();
    expect(reduce(LABELS.AI_DISCUSSING, EVENTS.BUILD_SUCCEEDED)).toBeNull();
  });
});

describe("reduce — PR lifecycle", () => {
  it("none + labelled_auto_reworking -> auto-rework, fires rework-loop", () => {
    const rule = reduce("none", EVENTS.LABELLED_AUTO_REWORKING);
    expect(rule?.to).toEqual(label(LABELS.AUTO_REWORKING));
    expect(rule?.run).toBe(ROUTINES.REWORK_LOOP);
  });

  it("auto-rework + rework_pushed -> label cleared, no replacement", () => {
    expect(reduce(LABELS.AUTO_REWORKING, EVENTS.REWORK_PUSHED)?.to).toEqual(unlabel);
  });

  it("auto-merge + merge_gate_failed_soft -> no GitHub write at all, matches merge-flow's real behaviour", () => {
    expect(reduce(LABELS.AUTO_MERGING, EVENTS.MERGE_GATE_FAILED_SOFT)?.to).toEqual(noop);
  });

  it("auto-merge + merge_gate_failed_hard -> label cleared, needs a human", () => {
    expect(reduce(LABELS.AUTO_MERGING, EVENTS.MERGE_GATE_FAILED_HARD)?.to).toEqual(unlabel);
  });

  it("auto-merge + merged -> native close", () => {
    expect(reduce(LABELS.AUTO_MERGING, EVENTS.MERGED)?.to).toEqual(close);
  });
});

describe("reduce — illegal moves are dropped, not errors", () => {
  it("an event with no matching rule for the current state returns null", () => {
    expect(reduce(LABELS.AI_GENERATED, EVENTS.LABELLED_AI_READY)).toBeNull();
    expect(reduce("none", EVENTS.MERGED)).toBeNull();
    expect(reduce("none", EVENTS.MERGE_GATE_FAILED_HARD)).toBeNull();
  });
});

describe("reduce — the watchdog and ai-stuck", () => {
  it("every state a watched routine runs in, + watchdog_expired -> ai-stuck, deterministic, fires nothing", () => {
    for (const from of [
      LABELS.AI_READY,
      LABELS.AI_GENERATED,
      LABELS.AI_BLOCKED,
      LABELS.AUTO_RELEASING,
      LABELS.AUTO_REWORKING,
      LABELS.AUTO_MERGING,
    ]) {
      const rule = reduce(from, EVENTS.WATCHDOG_EXPIRED);
      expect(rule?.to, from).toEqual(label(LABELS.AI_STUCK));
      expect(rule?.run, from).toBeUndefined();
      expect(rule?.verifiedBy, from).toBe("deterministic");
    }
  });

  it("isWatched: ai-discuss (never reports an outcome), none, and ai-stuck itself are not watched", () => {
    expect(isWatched(LABELS.AI_READY)).toBe(true);
    expect(isWatched(LABELS.AI_DISCUSSING)).toBe(false);
    expect(isWatched("none")).toBe(false);
    expect(isWatched(LABELS.AI_STUCK)).toBe(false);
  });

  it("a late outcome still wins from ai-stuck", () => {
    expect(reduce(LABELS.AI_STUCK, EVENTS.BUILD_SUCCEEDED)?.to).toEqual(label(LABELS.AI_GENERATED));
    expect(reduce(LABELS.AI_STUCK, EVENTS.BUILD_BLOCKED)?.to).toEqual(label(LABELS.AI_BLOCKED));
    expect(reduce(LABELS.AI_STUCK, EVENTS.RELEASE_BLOCKED)?.to).toEqual(unlabel);
    expect(reduce(LABELS.AI_STUCK, EVENTS.RELEASE_PUBLISHED)?.to).toEqual(close);
    expect(reduce(LABELS.AI_STUCK, EVENTS.REWORK_PUSHED)?.to).toEqual(unlabel);
    expect(reduce(LABELS.AI_STUCK, EVENTS.MERGED)?.to).toEqual(close);
  });

  it("re-adding a trigger label on a stuck issue retries that loop", () => {
    const cases = [
      [EVENTS.LABELLED_AI_READY, LABELS.AI_READY, ROUTINES.ISSUE_BUILD_LOOP],
      [EVENTS.LABELLED_AUTO_RELEASING, LABELS.AUTO_RELEASING, ROUTINES.AUTO_RELEASE_LOOP],
      [EVENTS.LABELLED_AUTO_REWORKING, LABELS.AUTO_REWORKING, ROUTINES.REWORK_LOOP],
      [EVENTS.LABELLED_AUTO_MERGING, LABELS.AUTO_MERGING, ROUTINES.MERGE_FLOW],
    ] as const;
    for (const [event, to, run] of cases) {
      const rule = reduce(LABELS.AI_STUCK, event);
      expect(rule?.to, event).toEqual(label(to));
      expect(rule?.run, event).toBe(run);
    }
  });

  it("no (state, event) pair has two rules — reduce()'s first-match can't hide one", () => {
    const keys = rules.map((r) => `${r.from}|${r.on}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
