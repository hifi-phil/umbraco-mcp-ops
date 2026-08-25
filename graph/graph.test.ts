import { describe, expect, it } from "vitest";
import { ALL_LABELS, LABELS, close, label, labelOps, noop, reduce, unlabel } from "./graph";

describe("LABELS — the absolute list", () => {
  it("has exactly the seven tracked labels, none blank or duplicated", () => {
    expect(ALL_LABELS).toHaveLength(7);
    expect(new Set(ALL_LABELS).size).toBe(7);
    expect(ALL_LABELS.every((l) => l.length > 0)).toBe(true);
  });
});

describe("reduce — issue lifecycle", () => {
  it("none + labelled_ai_ready -> ai-ready, fires issue-build-loop", () => {
    const rule = reduce("none", "labelled_ai_ready");
    expect(rule?.to).toEqual(label(LABELS.AI_READY));
    expect(rule?.run).toBe("issue-build-loop");
  });

  it("ai-ready + build_succeeded -> ai-generated", () => {
    expect(reduce(LABELS.AI_READY, "build_succeeded")?.to).toEqual(label(LABELS.AI_GENERATED));
  });

  it("ai-ready + build_blocked -> ai-blocked", () => {
    expect(reduce(LABELS.AI_READY, "build_blocked")?.to).toEqual(label(LABELS.AI_BLOCKED));
  });

  it("auto-releasing + release_blocked -> label removed, not replaced", () => {
    expect(reduce(LABELS.AUTO_RELEASING, "release_blocked")?.to).toEqual(unlabel);
  });

  it("auto-releasing + release_published -> native close, not a label", () => {
    expect(reduce(LABELS.AUTO_RELEASING, "release_published")?.to).toEqual(close);
  });

  it("ai-discussing has no outbound rules — human-owned by design", () => {
    expect(reduce(LABELS.AI_DISCUSSING, "labelled_ai_ready")).toBeNull();
    expect(reduce(LABELS.AI_DISCUSSING, "build_succeeded")).toBeNull();
  });
});

describe("reduce — PR lifecycle", () => {
  it("none + labelled_auto_reworking -> auto-reworking, fires rework-loop", () => {
    const rule = reduce("none", "labelled_auto_reworking");
    expect(rule?.to).toEqual(label(LABELS.AUTO_REWORKING));
    expect(rule?.run).toBe("rework-loop");
  });

  it("auto-reworking + rework_pushed -> label cleared, no replacement", () => {
    expect(reduce(LABELS.AUTO_REWORKING, "rework_pushed")?.to).toEqual(unlabel);
  });

  it("auto-merging + merge_gate_failed_soft -> no GitHub write at all, matches merge-flow's real behaviour", () => {
    expect(reduce(LABELS.AUTO_MERGING, "merge_gate_failed_soft")?.to).toEqual(noop);
  });

  it("auto-merging + merge_gate_failed_hard -> label cleared, needs a human", () => {
    expect(reduce(LABELS.AUTO_MERGING, "merge_gate_failed_hard")?.to).toEqual(unlabel);
  });

  it("auto-merging + merged -> native close", () => {
    expect(reduce(LABELS.AUTO_MERGING, "merged")?.to).toEqual(close);
  });
});

describe("reduce — illegal moves are dropped, not errors", () => {
  it("an event with no matching rule for the current state returns null", () => {
    expect(reduce(LABELS.AI_GENERATED, "labelled_ai_ready")).toBeNull();
    expect(reduce("none", "merged")).toBeNull();
    expect(reduce("none", "merge_gate_failed_hard")).toBeNull();
  });
});

describe("labelOps — the concrete GitHub calls a rule requires", () => {
  it("build_succeeded explicitly removes ai-ready as well as adding ai-generated", () => {
    const rule = reduce(LABELS.AI_READY, "build_succeeded")!;
    expect(labelOps([LABELS.AI_READY], rule)).toEqual([
      { op: "remove", label: LABELS.AI_READY },
      { op: "add", label: LABELS.AI_GENERATED },
    ]);
  });

  it("build_blocked removes ai-ready and adds ai-blocked", () => {
    const rule = reduce(LABELS.AI_READY, "build_blocked")!;
    expect(labelOps([LABELS.AI_READY], rule)).toEqual([
      { op: "remove", label: LABELS.AI_READY },
      { op: "add", label: LABELS.AI_BLOCKED },
    ]);
  });

  it("labelled_ai_ready needs no write — the triggering webhook already added the label", () => {
    const rule = reduce("none", "labelled_ai_ready")!;
    expect(labelOps([LABELS.AI_READY], rule)).toEqual([]);
  });

  it("release_blocked removes auto-releasing with nothing added", () => {
    const rule = reduce(LABELS.AUTO_RELEASING, "release_blocked")!;
    expect(labelOps([LABELS.AUTO_RELEASING], rule)).toEqual([
      { op: "remove", label: LABELS.AUTO_RELEASING },
    ]);
  });

  it("rework_pushed removes auto-reworking with nothing added", () => {
    const rule = reduce(LABELS.AUTO_REWORKING, "rework_pushed")!;
    expect(labelOps([LABELS.AUTO_REWORKING], rule)).toEqual([
      { op: "remove", label: LABELS.AUTO_REWORKING },
    ]);
  });

  it("merge_gate_failed_soft makes no GitHub call at all", () => {
    const rule = reduce(LABELS.AUTO_MERGING, "merge_gate_failed_soft")!;
    expect(labelOps([LABELS.AUTO_MERGING], rule)).toEqual([]);
  });

  it("release_published and merged just close — no label call", () => {
    expect(
      labelOps([LABELS.AUTO_RELEASING], reduce(LABELS.AUTO_RELEASING, "release_published")!),
    ).toEqual([{ op: "close" }]);
    expect(labelOps([LABELS.AUTO_MERGING], reduce(LABELS.AUTO_MERGING, "merged")!)).toEqual([
      { op: "close" },
    ]);
  });

  it("a label already removed by a human isn't redundantly removed again", () => {
    const rule = reduce(LABELS.AUTO_REWORKING, "rework_pushed")!;
    expect(labelOps([], rule)).toEqual([]);
  });
});
