// The outcome shape catalog — same content as plugins/agent-outcomes's
// SKILL.md catalog, kept in code so both transports that can carry an
// outcome (a GitHub comment, parsed in github/from-github.ts; a direct
// routine signal, parsed in routines/from-routine.ts) validate against one
// definition instead of two copies drifting apart. Transport-specific
// extraction (regex out of a comment body vs. a typed field on a direct
// payload) stays in each transport's own file; only the shape itself lives
// here.
//
// Not every event in constants/events.ts belongs here. Only ones actually
// sourced from a self-reported artifact do — rework_pushed and
// merge_gate_failed_* are deliberately absent because they're sourced
// differently (a native push webhook; a live gate re-check), not because
// they're unfinished. See 11-outcome-artifact.md.

export type Outcome =
  | { outcome: "build_succeeded"; pr: number }
  | { outcome: "build_blocked"; reason: string }
  | { outcome: "release_blocked"; reason: string }
  // `tag`: the release's tag, as the project names it (release-publish
  // reports it); absent from the agent that still publishes itself.
  | { outcome: "release_published"; version: string; tag?: string }
  // The release split (17-release-flow.md): the pre-publish review passed.
  // The Worker merges the PR the way the project says (merge_method), pinned
  // to the commit the review saw.
  | { outcome: "release_approved"; pr: number; sha: string; version: string; merge_method: MergeMethod }
  | { outcome: "review_passed" }
  | { outcome: "review_findings"; findings: number }
  | { outcome: "review_blocked"; reason: string };

export type MergeMethod = "merge" | "squash" | "rebase";
const MERGE_METHODS: readonly string[] = ["merge", "squash", "rebase"];

export function parseOutcomeShape(value: unknown): Outcome | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;

  if (v.outcome === "build_succeeded" && typeof v.pr === "number") {
    return { outcome: "build_succeeded", pr: v.pr };
  }
  if (v.outcome === "build_blocked" && typeof v.reason === "string") {
    return { outcome: "build_blocked", reason: v.reason };
  }
  if (v.outcome === "release_blocked" && typeof v.reason === "string") {
    return { outcome: "release_blocked", reason: v.reason };
  }
  if (v.outcome === "release_published" && typeof v.version === "string") {
    return typeof v.tag === "string"
      ? { outcome: "release_published", version: v.version, tag: v.tag }
      : { outcome: "release_published", version: v.version };
  }
  if (
    v.outcome === "release_approved" &&
    typeof v.pr === "number" &&
    typeof v.sha === "string" &&
    typeof v.version === "string" &&
    typeof v.merge_method === "string" &&
    MERGE_METHODS.includes(v.merge_method)
  ) {
    return { outcome: "release_approved", pr: v.pr, sha: v.sha, version: v.version, merge_method: v.merge_method as MergeMethod };
  }
  if (v.outcome === "review_passed") return { outcome: "review_passed" };
  if (v.outcome === "review_findings" && typeof v.findings === "number") {
    return { outcome: "review_findings", findings: v.findings };
  }
  if (v.outcome === "review_blocked" && typeof v.reason === "string") {
    return { outcome: "review_blocked", reason: v.reason };
  }
  return null;
}
