import { describe, expect, it } from "vitest";
import { EVENTS } from "./constants/events";
import { LABELS } from "./constants/labels";
import { ROUTINES } from "./constants/routines";
import { close, label, noop, unlabel } from "./github/to-github";
import { CONTEXTUAL_EVENTS, isWatched, reduce, rules } from "./graph";

describe("reduce — issue lifecycle", () => {
  it("none + labelled_ai_ready -> ready-for-ai, fires issue-build-loop", () => {
    const rule = reduce("none", EVENTS.LABELLED_AI_READY);
    expect(rule?.to).toEqual(label(LABELS.AI_READY));
    expect(rule?.run).toBe(ROUTINES.ISSUE_BUILD_LOOP);
  });

  it("generated-by-ai + build_succeeded -> noop (a loop that swaps itself already applied it)", () => {
    expect(reduce(LABELS.AI_GENERATED, EVENTS.BUILD_SUCCEEDED)?.to).toEqual(noop);
  });

  it("ai-blocked + build_blocked -> noop (same, for a loop that swaps itself)", () => {
    expect(reduce(LABELS.AI_BLOCKED, EVENTS.BUILD_BLOCKED)?.to).toEqual(noop);
  });

  it("none + release_blocked -> noop (a loop that removed auto-release itself)", () => {
    expect(reduce("none", EVENTS.RELEASE_BLOCKED)?.to).toEqual(noop);
  });

  it("Phase 5, orchestrated: the outcome arrives pre-swap and the Worker does the swap, firing nothing", () => {
    const cases = [
      [LABELS.AI_READY, EVENTS.BUILD_SUCCEEDED, label(LABELS.AI_GENERATED)],
      [LABELS.AI_READY, EVENTS.BUILD_BLOCKED, label(LABELS.AI_BLOCKED)],
      [LABELS.AUTO_RELEASING, EVENTS.RELEASE_BLOCKED, unlabel],
      [LABELS.AUTO_RELEASING, EVENTS.RELEASE_PUBLISHED, close],
    ] as const;
    for (const [from, event, to] of cases) {
      const rule = reduce(from, event);
      expect(rule?.to, `${from} ${event}`).toEqual(to);
      expect(rule?.run, `${from} ${event}`).toBeUndefined();
    }
  });

  it("auto-release + release_published -> native close, not a label", () => {
    expect(reduce(LABELS.AUTO_RELEASING, EVENTS.RELEASE_PUBLISHED)?.to).toEqual(close);
  });

  it("ai-discuss has no outbound rules — human-owned by design", () => {
    expect(reduce(LABELS.AI_DISCUSSING, EVENTS.LABELLED_AI_READY)).toBeNull();
    expect(reduce(LABELS.AI_DISCUSSING, EVENTS.BUILD_SUCCEEDED)).toBeNull();
  });

  it("ai-discuss + discussion_reply -> stays put, fires the next round", () => {
    const rule = reduce(LABELS.AI_DISCUSSING, EVENTS.DISCUSSION_REPLY);
    expect(rule?.to).toEqual(noop);
    expect(rule?.run).toBe(ROUTINES.ISSUE_DISCUSS_LOOP);
    expect(reduce("none", EVENTS.DISCUSSION_REPLY)).toBeNull();
  });

  it("auto-release + issue_closed -> noop (Step 4's native close ends the run, comment or not)", () => {
    expect(reduce(LABELS.AUTO_RELEASING, EVENTS.ISSUE_CLOSED)?.to).toEqual(noop);
  });

  it("a loop removing its trigger label -> noop from every state it can leave behind, fires nothing", () => {
    const cases = [
      [EVENTS.UNLABELLED_AI_READY, ["none", LABELS.AI_GENERATED, LABELS.AI_BLOCKED, LABELS.AI_STUCK]],
      [EVENTS.UNLABELLED_AUTO_RELEASING, ["none", LABELS.AI_STUCK]],
      [EVENTS.UNLABELLED_AUTO_REWORKING, ["none", LABELS.AI_STUCK]],
      [EVENTS.UNLABELLED_AUTO_MERGING, ["none", LABELS.AI_STUCK]],
    ] as const;
    for (const [event, froms] of cases) {
      for (const from of froms) {
        const rule = reduce(from, event);
        expect(rule?.to, `${from} ${event}`).toEqual(noop);
        expect(rule?.run, `${from} ${event}`).toBeUndefined();
      }
    }
  });
});

describe("CONTEXTUAL_EVENTS", () => {
  it("never includes a trigger-label add or an outcome: those without a rule are real gaps", () => {
    for (const e of [
      EVENTS.LABELLED_AI_READY,
      EVENTS.LABELLED_AUTO_RELEASING,
      EVENTS.LABELLED_AUTO_MERGING,
      EVENTS.BUILD_SUCCEEDED,
      EVENTS.RELEASE_PUBLISHED,
      EVENTS.WATCHDOG_EXPIRED,
    ]) {
      expect(CONTEXTUAL_EVENTS.has(e), e).toBe(false);
    }
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

  it("auto-merge + merge_gate_failed_soft (CI failed) -> auto-rework, and fires rework-loop itself (no echo)", () => {
    const rule = reduce(LABELS.AUTO_MERGING, EVENTS.MERGE_GATE_FAILED_SOFT);
    expect(rule?.to).toEqual(label(LABELS.AUTO_REWORKING));
    expect(rule?.run).toBe(ROUTINES.REWORK_LOOP);
  });

  it("auto-rework + ci_fix_pushed -> back to auto-merge, and fires merge-flow itself (no echo)", () => {
    const rule = reduce(LABELS.AUTO_REWORKING, EVENTS.CI_FIX_PUSHED);
    expect(rule?.to).toEqual(label(LABELS.AUTO_MERGING));
    expect(rule?.run).toBe(ROUTINES.MERGE_FLOW);
  });

  it("auto-merge + merge_gate_failed_hard -> merge-blocked, needs a human", () => {
    expect(reduce(LABELS.AUTO_MERGING, EVENTS.MERGE_GATE_FAILED_HARD)?.to).toEqual(label(LABELS.MERGE_BLOCKED));
  });

  it("merge-blocked + auto-merge re-added -> auto-merge again, fires merge-flow", () => {
    const rule = reduce(LABELS.MERGE_BLOCKED, EVENTS.LABELLED_AUTO_MERGING);
    expect(rule?.to).toEqual(label(LABELS.AUTO_MERGING));
    expect(rule?.run).toBe(ROUTINES.MERGE_FLOW);
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
    for (const from of [LABELS.AI_READY, LABELS.AUTO_RELEASING, LABELS.AUTO_REWORKING, LABELS.AUTO_MERGING]) {
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

  it("a build's outcome labels are finished states, never watched (shadow run 1: finished #116 would have gone ai-stuck)", () => {
    expect(isWatched(LABELS.AI_GENERATED)).toBe(false);
    expect(isWatched(LABELS.AI_BLOCKED)).toBe(false);
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
