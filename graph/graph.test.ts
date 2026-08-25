import { describe, expect, it } from "vitest";
import { EVENTS } from "./constants/events";
import { LABELS } from "./constants/labels";
import { ROUTINES } from "./constants/routines";
import { close, label, noop, unlabel } from "./github/to-github";
import { reduce } from "./graph";

describe("reduce — issue lifecycle", () => {
  it("none + labelled_ai_ready -> ai-ready, fires issue-build-loop", () => {
    const rule = reduce("none", EVENTS.LABELLED_AI_READY);
    expect(rule?.to).toEqual(label(LABELS.AI_READY));
    expect(rule?.run).toBe(ROUTINES.ISSUE_BUILD_LOOP);
  });

  it("ai-ready + build_succeeded -> ai-generated", () => {
    expect(reduce(LABELS.AI_READY, EVENTS.BUILD_SUCCEEDED)?.to).toEqual(label(LABELS.AI_GENERATED));
  });

  it("ai-ready + build_blocked -> ai-blocked", () => {
    expect(reduce(LABELS.AI_READY, EVENTS.BUILD_BLOCKED)?.to).toEqual(label(LABELS.AI_BLOCKED));
  });

  it("auto-releasing + release_blocked -> label removed, not replaced", () => {
    expect(reduce(LABELS.AUTO_RELEASING, EVENTS.RELEASE_BLOCKED)?.to).toEqual(unlabel);
  });

  it("auto-releasing + release_published -> native close, not a label", () => {
    expect(reduce(LABELS.AUTO_RELEASING, EVENTS.RELEASE_PUBLISHED)?.to).toEqual(close);
  });

  it("ai-discussing has no outbound rules — human-owned by design", () => {
    expect(reduce(LABELS.AI_DISCUSSING, EVENTS.LABELLED_AI_READY)).toBeNull();
    expect(reduce(LABELS.AI_DISCUSSING, EVENTS.BUILD_SUCCEEDED)).toBeNull();
  });
});

describe("reduce — PR lifecycle", () => {
  it("none + labelled_auto_reworking -> auto-reworking, fires rework-loop", () => {
    const rule = reduce("none", EVENTS.LABELLED_AUTO_REWORKING);
    expect(rule?.to).toEqual(label(LABELS.AUTO_REWORKING));
    expect(rule?.run).toBe(ROUTINES.REWORK_LOOP);
  });

  it("auto-reworking + rework_pushed -> label cleared, no replacement", () => {
    expect(reduce(LABELS.AUTO_REWORKING, EVENTS.REWORK_PUSHED)?.to).toEqual(unlabel);
  });

  it("auto-merging + merge_gate_failed_soft -> no GitHub write at all, matches merge-flow's real behaviour", () => {
    expect(reduce(LABELS.AUTO_MERGING, EVENTS.MERGE_GATE_FAILED_SOFT)?.to).toEqual(noop);
  });

  it("auto-merging + merge_gate_failed_hard -> label cleared, needs a human", () => {
    expect(reduce(LABELS.AUTO_MERGING, EVENTS.MERGE_GATE_FAILED_HARD)?.to).toEqual(unlabel);
  });

  it("auto-merging + merged -> native close", () => {
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
