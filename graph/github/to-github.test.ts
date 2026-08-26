import { describe, expect, it } from "vitest";
import { EVENTS } from "../constants/events";
import { LABELS } from "../constants/labels";
import { reduce } from "../graph";
import { labelOps } from "./to-github";

describe("labelOps — the concrete GitHub calls a rule requires", () => {
  it("build_succeeded is a noop — issue-build-loop's own Step 3 already did the ai-ready -> ai-generated swap before this event reaches the reducer", () => {
    const rule = reduce(LABELS.AI_GENERATED, EVENTS.BUILD_SUCCEEDED)!;
    expect(labelOps([LABELS.AI_GENERATED], rule)).toEqual([]);
  });

  it("build_blocked is a noop — same reasoning, keyed on the post-swap ai-blocked state", () => {
    const rule = reduce(LABELS.AI_BLOCKED, EVENTS.BUILD_BLOCKED)!;
    expect(labelOps([LABELS.AI_BLOCKED], rule)).toEqual([]);
  });

  it("labelled_ai_ready needs no write — the triggering webhook already added the label", () => {
    const rule = reduce("none", EVENTS.LABELLED_AI_READY)!;
    expect(labelOps([LABELS.AI_READY], rule)).toEqual([]);
  });

  it("release_blocked is a noop — auto-release-loop's own Step 2.5 already removed auto-releasing before this event reaches the reducer", () => {
    const rule = reduce("none", EVENTS.RELEASE_BLOCKED)!;
    expect(labelOps([], rule)).toEqual([]);
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
