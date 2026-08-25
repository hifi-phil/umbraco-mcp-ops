import { describe, expect, it } from "vitest";
import { close, label, labelOps, noop, reduce, unlabel } from "./graph";

describe("reduce — issue lifecycle", () => {
  it("none + labelled_ai_ready -> ai-ready, fires issue-build-loop", () => {
    const rule = reduce("none", "labelled_ai_ready");
    expect(rule?.to).toEqual(label("ai-ready"));
    expect(rule?.run).toBe("issue-build-loop");
  });

  it("ai-ready + build_succeeded -> ai-generated", () => {
    expect(reduce("ai-ready", "build_succeeded")?.to).toEqual(label("ai-generated"));
  });

  it("ai-ready + build_blocked -> ai-blocked", () => {
    expect(reduce("ai-ready", "build_blocked")?.to).toEqual(label("ai-blocked"));
  });

  it("auto-releasing + release_blocked -> label removed, not replaced", () => {
    expect(reduce("auto-releasing", "release_blocked")?.to).toEqual(unlabel);
  });

  it("auto-releasing + release_published -> native close, not a label", () => {
    expect(reduce("auto-releasing", "release_published")?.to).toEqual(close);
  });

  it("ai-discussing has no outbound rules — human-owned by design", () => {
    expect(reduce("ai-discussing", "labelled_ai_ready")).toBeNull();
    expect(reduce("ai-discussing", "build_succeeded")).toBeNull();
  });
});

describe("reduce — PR lifecycle", () => {
  it("none + labelled_auto_reworking -> auto-reworking, fires rework-loop", () => {
    const rule = reduce("none", "labelled_auto_reworking");
    expect(rule?.to).toEqual(label("auto-reworking"));
    expect(rule?.run).toBe("rework-loop");
  });

  it("auto-reworking + rework_pushed -> label cleared, no replacement", () => {
    expect(reduce("auto-reworking", "rework_pushed")?.to).toEqual(unlabel);
  });

  it("auto-merging + merge_gate_failed_soft -> no GitHub write at all, matches merge-flow's real behaviour", () => {
    expect(reduce("auto-merging", "merge_gate_failed_soft")?.to).toEqual(noop);
  });

  it("auto-merging + merge_gate_failed_hard -> label cleared, needs a human", () => {
    expect(reduce("auto-merging", "merge_gate_failed_hard")?.to).toEqual(unlabel);
  });

  it("auto-merging + merged -> native close", () => {
    expect(reduce("auto-merging", "merged")?.to).toEqual(close);
  });
});

describe("reduce — illegal moves are dropped, not errors", () => {
  it("an event with no matching rule for the current state returns null", () => {
    expect(reduce("ai-generated", "labelled_ai_ready")).toBeNull();
    expect(reduce("none", "merged")).toBeNull();
    expect(reduce("none", "merge_gate_failed_hard")).toBeNull();
  });
});

describe("labelOps — the concrete GitHub calls a rule requires", () => {
  it("build_succeeded explicitly removes ai-ready as well as adding ai-generated", () => {
    const rule = reduce("ai-ready", "build_succeeded")!;
    expect(labelOps(["ai-ready"], rule)).toEqual([
      { op: "remove", label: "ai-ready" },
      { op: "add", label: "ai-generated" },
    ]);
  });

  it("build_blocked removes ai-ready and adds ai-blocked", () => {
    const rule = reduce("ai-ready", "build_blocked")!;
    expect(labelOps(["ai-ready"], rule)).toEqual([
      { op: "remove", label: "ai-ready" },
      { op: "add", label: "ai-blocked" },
    ]);
  });

  it("labelled_ai_ready needs no write — the triggering webhook already added the label", () => {
    const rule = reduce("none", "labelled_ai_ready")!;
    expect(labelOps(["ai-ready"], rule)).toEqual([]);
  });

  it("release_blocked removes auto-releasing with nothing added", () => {
    const rule = reduce("auto-releasing", "release_blocked")!;
    expect(labelOps(["auto-releasing"], rule)).toEqual([{ op: "remove", label: "auto-releasing" }]);
  });

  it("rework_pushed removes auto-reworking with nothing added", () => {
    const rule = reduce("auto-reworking", "rework_pushed")!;
    expect(labelOps(["auto-reworking"], rule)).toEqual([
      { op: "remove", label: "auto-reworking" },
    ]);
  });

  it("merge_gate_failed_soft makes no GitHub call at all", () => {
    const rule = reduce("auto-merging", "merge_gate_failed_soft")!;
    expect(labelOps(["auto-merging"], rule)).toEqual([]);
  });

  it("release_published and merged just close — no label call", () => {
    expect(labelOps(["auto-releasing"], reduce("auto-releasing", "release_published")!)).toEqual([
      { op: "close" },
    ]);
    expect(labelOps(["auto-merging"], reduce("auto-merging", "merged")!)).toEqual([
      { op: "close" },
    ]);
  });

  it("a label already removed by a human isn't redundantly removed again", () => {
    const rule = reduce("auto-reworking", "rework_pushed")!;
    expect(labelOps([], rule)).toEqual([]);
  });
});
