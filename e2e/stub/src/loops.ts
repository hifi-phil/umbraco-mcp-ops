// What each loop does in orchestrated mode, as scripted GitHub API calls.
// Each takes the hint from the issue or PR (`<!-- e2e: <hint> -->`), which
// the scenario set. Outcome labels are never touched: in orchestrated mode
// that's the orchestrator's job, and a stub that swapped them would hide
// exactly the bugs the suite is for.

import type { Outcome } from "../../../graph/outcomes";

export type Gh = (method: string, path: string, body?: unknown) => Promise<unknown>;

/** Posts a routine signal (graph/routines/from-routine.ts's RoutineSignal)
 * to the orchestrator's /routine-signal, returning its outcome. */
export type Signal = (signal: Record<string, unknown>) => Promise<string>;

/** issue-discuss-loop's own signature, which from-github.ts uses to ignore
 * the loop's comments (so only a human's reply starts the next round). */
export const DISCUSS_SIGNATURE = "<!-- issue-discuss-loop -->";

export type Fire = { route: string; owner: string; repo: string; number: number };

export type Action =
  | "build_blocked"
  | "build_succeeded"
  | "pushed"
  | "merged"
  | "waiting_for_ci"
  | "ci_red"
  | "release_published"
  | "release_blocked"
  | "discussed"
  | "heartbeat"
  | "completion"
  | "none";

/** plugins/agent-outcomes's comment format, which from-github.ts parses. */
export function outcomeComment(loop: string, outcome: Outcome): string {
  return (
    `e2e stub (${loop}): ${outcome.outcome}.\n\n` +
    `<!-- agent-outcome:${loop} -->\n\`\`\`json\n${JSON.stringify(outcome)}\n\`\`\``
  );
}

const base = (f: Pick<Fire, "owner" | "repo">) => `/repos/${f.owner}/${f.repo}`;

async function comment(gh: Gh, f: Fire, body: string): Promise<void> {
  await gh("POST", `${base(f)}/issues/${f.number}/comments`, { body });
}

/** One commit on `branch` writing `path`, via the contents API. */
async function putFile(gh: Gh, f: Fire, branch: string, path: string, content: string, message: string) {
  let sha: string | undefined;
  try {
    ({ sha } = (await gh("GET", `${base(f)}/contents/${path}?ref=${encodeURIComponent(branch)}`)) as { sha: string });
  } catch {
    sha = undefined; // a new file
  }
  await gh("PUT", `${base(f)}/contents/${path}`, {
    message,
    content: btoa(content),
    branch,
    ...(sha ? { sha } : {}),
  });
}

export async function act(gh: Gh, fire: Fire, hint: string | null, signal?: Signal): Promise<Action> {
  if (hint === "silent") return "none";
  // A routine that reports progress (or finishes) over the direct channel
  // but never posts an outcome: what the watchdog and its heartbeat handle.
  if ((hint === "heartbeat" || hint === "complete") && signal) {
    const base = { routine: fire.route, issue: fire.number };
    await signal(
      hint === "heartbeat"
        ? { ...base, kind: "process", step: "e2e-heartbeat" }
        : { ...base, kind: "completion", outcome: { outcome: "build_blocked", reason: "e2e stub: completion signal only" } },
    );
    return hint === "heartbeat" ? "heartbeat" : "completion";
  }
  switch (fire.route) {
    case "issue-discuss-loop":
      return discuss(gh, fire, hint);
    case "issue-build-loop":
      return build(gh, fire, hint);
    case "rework-loop":
      return rework(gh, fire, hint);
    case "merge-flow":
      return mergeIfGreen(gh, fire);
    case "auto-release-loop":
      return release(gh, fire, hint);
    default:
      return "none";
  }
}

/** One discussion round: a signed question, numbered by the rounds so far. */
async function discuss(gh: Gh, f: Fire, hint: string | null): Promise<Action> {
  if (hint !== "discuss") return "none";
  const comments = (await gh("GET", `${base(f)}/issues/${f.number}/comments?per_page=100`)) as { body: string }[];
  const round = comments.filter((c) => c.body.includes(DISCUSS_SIGNATURE)).length + 1;
  await comment(gh, f, `${DISCUSS_SIGNATURE}\ne2e stub (issue-discuss-loop): round ${round}. What should this do?`);
  return "discussed";
}

async function build(gh: Gh, f: Fire, hint: string | null): Promise<Action> {
  if (hint === "blocked") {
    await comment(gh, f, outcomeComment("issue-build-loop", { outcome: "build_blocked", reason: "e2e stub: scripted block" }));
    return "build_blocked";
  }
  if (hint !== "success") return "none";

  const { object } = (await gh("GET", `${base(f)}/git/ref/heads/dev`)) as { object: { sha: string } };
  const branch = `e2e/build-${f.number}-${Date.now()}`;
  await gh("POST", `${base(f)}/git/refs`, { ref: `refs/heads/${branch}`, sha: object.sha });
  await putFile(gh, f, branch, `builds/${f.number}.txt`, `built for #${f.number}\n`, `e2e stub: build #${f.number}`);
  const pr = (await gh("POST", `${base(f)}/pulls`, {
    title: `e2e: build #${f.number}`,
    head: branch,
    base: "dev",
    body: `Built by the e2e stub for #${f.number}.\n\n<!-- e2e: merge -->`,
  })) as { number: number };
  await comment(gh, f, outcomeComment("issue-build-loop", { outcome: "build_succeeded", pr: pr.number }));
  return "build_succeeded";
}

async function rework(gh: Gh, f: Fire, hint: string | null): Promise<Action> {
  const { head } = (await gh("GET", `${base(f)}/pulls/${f.number}`)) as { head: { ref: string } };
  switch (hint) {
    case "rework": // a review rework: any push
      await putFile(gh, f, head.ref, `rework/${f.number}.txt`, `reworked ${Date.now()}\n`, "e2e stub: address review");
      return "pushed";
    case "ci_fail": // the fix CI needs
      await putFile(gh, f, head.ref, "ci-state", "pass\n", "e2e stub: fix CI");
      return "pushed";
    case "ci_never_fixed": // a push that doesn't fix it
      await putFile(gh, f, head.ref, `rework/${f.number}.txt`, `tried ${Date.now()}\n`, "e2e stub: try to fix CI");
      return "pushed";
    default:
      return "none";
  }
}

const GREEN = new Set(["success", "neutral", "skipped"]);

/**
 * merge-flow's gate and merge. Real merge-flow polls CI for minutes; the
 * stub can't wait inside a request, so it acts on what's there now and the
 * stub's own check_suite webhook calls this again when CI finishes.
 * A conflict or requested changes are the orchestrator's to block.
 */
export async function mergeIfGreen(gh: Gh, f: Fire): Promise<Action> {
  const pr = (await gh("GET", `${base(f)}/pulls/${f.number}`)) as {
    state: string;
    mergeable: boolean | null;
    head: { sha: string };
    labels: { name: string }[];
  };
  if (pr.state !== "open" || !pr.labels.some((l) => l.name === "auto-merge")) return "none";

  const { check_runs: runs } = (await gh("GET", `${base(f)}/commits/${pr.head.sha}/check-runs`)) as {
    check_runs: { name: string; status: string; conclusion: string | null }[];
  };
  if (runs.length === 0 || runs.some((r) => r.status !== "completed")) return "waiting_for_ci";
  const red = runs.filter((r) => !GREEN.has(r.conclusion ?? ""));
  if (red.length > 0) {
    // Orchestrated mode: say so and leave the labels to the orchestrator.
    await comment(gh, f, `e2e stub (merge-flow): not merging, CI failing (${red.map((r) => r.name).join(", ")}).`);
    return "ci_red";
  }
  if (pr.mergeable === false) return "none";

  try {
    await gh("PUT", `${base(f)}/pulls/${f.number}/merge`, { merge_method: "squash" });
  } catch (e) {
    // The fire and the check_suite webhook can both get here; the loser's
    // merge is refused (405/409), which is fine.
    if (e instanceof Error && / (405|409) /.test(e.message)) return "none";
    throw e;
  }
  await comment(gh, f, "e2e stub (merge-flow): merged (squash).");
  return "merged";
}

async function release(gh: Gh, f: Fire, hint: string | null): Promise<Action> {
  if (hint === "blocked") {
    await comment(gh, f, outcomeComment("auto-release-loop", { outcome: "release_blocked", reason: "e2e stub: scripted block" }));
    return "release_blocked";
  }
  if (hint !== "published") return "none";
  const version = `0.0.${f.number}`;
  await comment(gh, f, outcomeComment("auto-release-loop", { outcome: "release_published", version }));
  // The real loop closes the issue itself on publish (a native close).
  await gh("PATCH", `${base(f)}/issues/${f.number}`, { state: "closed" });
  return "release_published";
}
