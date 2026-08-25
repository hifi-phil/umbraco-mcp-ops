import { describe, expect, it } from "vitest";
import { EVENTS } from "./constants/events";
import { LABELS } from "./constants/labels";
import { labelOps } from "./effects";
import { reduce } from "./graph";

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
      labelOps([LABELS.AUTO_RELEASING], reduce(LABELS.AUTO_RELEASING, EVENTS.RELEASE_PUBLISHED)!),
    ).toEqual([{ op: "close" }]);
    expect(labelOps([LABELS.AUTO_MERGING], reduce(LABELS.AUTO_MERGING, EVENTS.MERGED)!)).toEqual([
      { op: "close" },
    ]);
  });

  it("a label already removed by a human isn't redundantly removed again", () => {
    const rule = reduce(LABELS.AUTO_REWORKING, EVENTS.REWORK_PUSHED)!;
    expect(labelOps([], rule)).toEqual([]);
  });
});
