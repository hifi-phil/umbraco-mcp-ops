import { describe, expect, it } from "vitest";
import { EVENTS } from "./constants/events";
import { LABELS } from "./constants/labels";
import { ROUTINES } from "./constants/routines";
import { close, label, labelOps, noop, reduce, unlabel } from "./graph";

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

describe("labelOps — the concrete GitHub calls a rule requires", () => {
  it("build_succeeded explicitly removes ai-ready as well as adding ai-generated", () => {
    const rule = reduce(LABELS.AI_READY, EVENTS.BUILD_SUCCEEDED)!;
    expect(labelOps([LABELS.AI_READY], rule)).toEqual([
      { op: "remove", label: LABELS.AI_READY },
      { op: "add", label: LABELS.AI_GENERATED },
    ]);
  });

  it("build_blocked removes ai-ready and adds ai-blocked", () => {
    const rule = reduce(LABELS.AI_READY, EVENTS.BUILD_BLOCKED)!;
    expect(labelOps([LABELS.AI_READY], rule)).toEqual([
      { op: "remove", label: LABELS.AI_READY },
      { op: "add", label: LABELS.AI_BLOCKED },
    ]);
  });

  it("labelled_ai_ready needs no write — the triggering webhook already added the label", () => {
    const rule = reduce("none", EVENTS.LABELLED_AI_READY)!;
    expect(labelOps([LABELS.AI_READY], rule)).toEqual([]);
  });

  it("release_blocked removes auto-releasing with nothing added", () => {
    const rule = reduce(LABELS.AUTO_RELEASING, EVENTS.RELEASE_BLOCKED)!;
    expect(labelOps([LABELS.AUTO_RELEASING], rule)).toEqual([
      { op: "remove", label: LABELS.AUTO_RELEASING },
    ]);
  });

  it("rework_pushed removes auto-reworking with nothing added", () => {
    const rule = reduce(LABELS.AUTO_REWORKING, EVENTS.REWORK_PUSHED)!;
    expect(labelOps([LABELS.AUTO_REWORKING], rule)).toEqual([
      { op: "remove", label: LABELS.AUTO_REWORKING },
    ]);
  });

  it("merge_gate_failed_soft makes no GitHub call at all", () => {
    const rule = reduce(LABELS.AUTO_MERGING, EVENTS.MERGE_GATE_FAILED_SOFT)!;
    expect(labelOps([LABELS.AUTO_MERGING], rule)).toEqual([]);
  });

  it("release_published and merged just close — no label call", () => {
    expect(
      labelOps(
        [LABELS.AUTO_RELEASING],
        reduce(LABELS.AUTO_RELEASING, EVENTS.RELEASE_PUBLISHED)!,
      ),
    ).toEqual([{ op: "close" }]);
    expect(
      labelOps([LABELS.AUTO_MERGING], reduce(LABELS.AUTO_MERGING, EVENTS.MERGED)!),
    ).toEqual([{ op: "close" }]);
  });

  it("a label already removed by a human isn't redundantly removed again", () => {
    const rule = reduce(LABELS.AUTO_REWORKING, EVENTS.REWORK_PUSHED)!;
    expect(labelOps([], rule)).toEqual([]);
  });
});
