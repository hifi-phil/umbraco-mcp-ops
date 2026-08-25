import { describe, expect, it } from "vitest";
import { close, label, labelOps, noop, reduce, unlabel } from "./graph";

describe("reduce — issue lifecycle", () => {
  it("backlog + labelled_ready_for_ai -> building, fires issue-build-loop", () => {
    const rule = reduce("backlog", "labelled_ready_for_ai");
    expect(rule?.to).toEqual(label("building"));
    expect(rule?.run).toBe("issue-build-loop");
  });

  it("building + build_succeeded -> generated-by-ai", () => {
    expect(reduce("building", "build_succeeded")?.to).toEqual(label("generated-by-ai"));
  });

  it("building + build_blocked -> ai-blocked", () => {
    expect(reduce("building", "build_blocked")?.to).toEqual(label("ai-blocked"));
  });

  it("releasing + release_blocked -> auto-release label removed, not replaced", () => {
    expect(reduce("releasing", "release_blocked")?.to).toEqual(unlabel);
  });

  it("releasing + release_published -> native close, not a label", () => {
    expect(reduce("releasing", "release_published")?.to).toEqual(close);
  });

  it("discussing has no outbound rules — human-owned by design", () => {
    expect(reduce("discussing", "labelled_ready_for_ai")).toBeNull();
    expect(reduce("discussing", "build_succeeded")).toBeNull();
  });
});

describe("reduce — PR lifecycle", () => {
  it("pr-none + labelled_auto_rework -> reworking, fires rework-loop", () => {
    const rule = reduce("pr-none", "labelled_auto_rework");
    expect(rule?.to).toEqual(label("reworking"));
    expect(rule?.run).toBe("rework-loop");
  });

  it("reworking + rework_pushed -> label cleared, no replacement", () => {
    expect(reduce("reworking", "rework_pushed")?.to).toEqual(unlabel);
  });

  it("merge-pending + merge_gate_failed_soft -> no GitHub write at all, matches merge-flow's real behaviour", () => {
    expect(reduce("merge-pending", "merge_gate_failed_soft")?.to).toEqual(noop);
  });

  it("merge-pending + merge_gate_failed_hard -> label cleared, needs a human", () => {
    expect(reduce("merge-pending", "merge_gate_failed_hard")?.to).toEqual(unlabel);
  });

  it("merge-pending + merged -> native close", () => {
    expect(reduce("merge-pending", "merged")?.to).toEqual(close);
  });
});

describe("reduce — illegal moves are dropped, not errors", () => {
  it("an event with no matching rule for the current state returns null", () => {
    expect(reduce("generated-by-ai", "labelled_ready_for_ai")).toBeNull();
    expect(reduce("pr-none", "merged")).toBeNull();
    expect(reduce("backlog", "merge_gate_failed_hard")).toBeNull();
  });
});

describe("labelOps — the concrete GitHub calls a rule requires", () => {
  it("build_succeeded explicitly removes ready-for-ai as well as adding generated-by-ai", () => {
    const rule = reduce("building", "build_succeeded")!;
    expect(labelOps(["ready-for-ai"], rule)).toEqual([
      { op: "remove", label: "ready-for-ai" },
      { op: "add", label: "generated-by-ai" },
    ]);
  });

  it("build_blocked removes ready-for-ai and adds ai-blocked", () => {
    const rule = reduce("building", "build_blocked")!;
    expect(labelOps(["ready-for-ai"], rule)).toEqual([
      { op: "remove", label: "ready-for-ai" },
      { op: "add", label: "ai-blocked" },
    ]);
  });

  it("labelled_ready_for_ai needs no write — the triggering webhook already added the label", () => {
    const rule = reduce("backlog", "labelled_ready_for_ai")!;
    expect(labelOps(["ready-for-ai"], rule)).toEqual([]);
  });

  it("release_blocked removes auto-release with nothing added", () => {
    const rule = reduce("releasing", "release_blocked")!;
    expect(labelOps(["auto-release"], rule)).toEqual([{ op: "remove", label: "auto-release" }]);
  });

  it("rework_pushed removes auto-rework with nothing added", () => {
    const rule = reduce("reworking", "rework_pushed")!;
    expect(labelOps(["auto-rework"], rule)).toEqual([{ op: "remove", label: "auto-rework" }]);
  });

  it("merge_gate_failed_soft makes no GitHub call at all", () => {
    const rule = reduce("merge-pending", "merge_gate_failed_soft")!;
    expect(labelOps(["auto-merge"], rule)).toEqual([]);
  });

  it("release_published and merged just close — no label call", () => {
    expect(labelOps(["auto-release"], reduce("releasing", "release_published")!)).toEqual([
      { op: "close" },
    ]);
    expect(labelOps(["auto-merge"], reduce("merge-pending", "merged")!)).toEqual([
      { op: "close" },
    ]);
  });

  it("a label already removed by a human isn't redundantly removed again", () => {
    const rule = reduce("reworking", "rework_pushed")!;
    expect(labelOps([], rule)).toEqual([]);
  });
});
