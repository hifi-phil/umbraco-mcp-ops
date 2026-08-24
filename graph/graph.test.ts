import { describe, expect, it } from "vitest";
import { close, label, reduce, unlabel } from "./graph";

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
    expect(reduce("releasing", "release_blocked")?.to).toEqual(unlabel("releasing"));
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
    expect(reduce("reworking", "rework_pushed")?.to).toEqual(unlabel("reworking"));
  });

  it("merge-pending + merge_gate_failed_soft -> stays merge-pending (sweep retries)", () => {
    expect(reduce("merge-pending", "merge_gate_failed_soft")?.to).toEqual(label("merge-pending"));
  });

  it("merge-pending + merge_gate_failed_hard -> label cleared, needs a human", () => {
    expect(reduce("merge-pending", "merge_gate_failed_hard")?.to).toEqual(unlabel("merge-pending"));
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
