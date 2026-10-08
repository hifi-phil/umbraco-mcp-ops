// What each loop does in orchestrated mode, as scripted GitHub API calls.
// Each takes the hint from the issue or PR (`<!-- e2e: <hint> -->`), which
// the scenario set. Outcome labels are never touched: in orchestrated mode
// that's the orchestrator's job, and a stub that swapped them would hide
// exactly the bugs the suite is for.

import type { Outcome } from "@orchestrator/graph/outcomes";
import { LABELS } from "@orchestrator/graph/constants/labels";

export type Gh = (method: string, path: string, body?: unknown) => Promise<unknown>;

/** Posts a routine signal (graph/routines/from-routine.ts's RoutineSignal)
 * to the orchestrator's /routine-signal, returning its outcome. */
export type Signal = (signal: Record<string, unknown>) => Promise<string>;

/** issue-discuss-loop's own signature, which from-github.ts uses to ignore
 * the loop's comments (so only a human's reply starts the next round). */
export const DISCUSS_SIGNATURE = "<!-- issue-discuss-loop -->";

export type Fire = { route: string; owner: string; repo: string; number: number; logToken?: string };

/** Adds one work-log entry with the fire's log_token, as log-entry.sh would. */
export type LogEntry = { kind: "journal" | "decision" | "build"; category?: string; refs?: number[]; body: string };
/** Adds one work-log entry with the fire's log_token, as log-entry.sh would; its id. */
export type LogWriter = (entry: LogEntry) => Promise<number>;

export type Action =
  | "build_blocked"
  | "build_succeeded"
  | "pushed"
  | "merged"
  | "waiting_for_ci"
  | "ci_red"
  | "release_published"
  | "release_approved"
  | "release_blocked"
  | "discussed"
  | "review_passed"
  | "review_findings"
  | "review_blocked"
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

export async function act(gh: Gh, fire: Fire, hint: string | null, signal?: Signal, log?: LogWriter): Promise<Action> {
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
      return build(gh, fire, hint, log);
    case "rework-loop":
      return rework(gh, fire, hint);
    case "merge-flow":
      return mergeIfGreen(gh, fire);
    case "review-loop":
      return review(gh, fire, hint);
    case "auto-release-loop":
      return release(gh, fire, hint);
    case "release-publish":
      return publishRelease(gh, fire, hint);
    default:
      return "none";
  }
}

/** One discussion round: a signed question, numbered by the rounds so far. */
/** Marks the stub review-loop's PR reviews, which its rework-loop acts on. */
const REVIEW_SIGNATURE = "e2e stub (review-loop): review";

async function discuss(gh: Gh, f: Fire, hint: string | null): Promise<Action> {
  if (hint !== "discuss") return "none";
  const comments = (await gh("GET", `${base(f)}/issues/${f.number}/comments?per_page=100`)) as { body: string }[];
  const round = comments.filter((c) => c.body.includes(DISCUSS_SIGNATURE)).length + 1;
  await comment(gh, f, `${DISCUSS_SIGNATURE}\ne2e stub (issue-discuss-loop): round ${round}. What should this do?`);
  return "discussed";
}

async function build(gh: Gh, f: Fire, hint: string | null, log?: LogWriter): Promise<Action> {
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
    // "Closes #N", as the real build writes it: the merge moves the issue on.
    body: `Built by the e2e stub. Closes #${f.number}.\n\n<!-- e2e: merge -->`,
  })) as { number: number };
  // The work log, as the real build writes it (best effort, as there).
  // The work log, as the real build writes it: a journal entry as it
  // chooses, then the decision list derived from it and a build entry
  // (best effort, as there).
  if (log) {
    const journal = await log({
      kind: "journal",
      category: "judgment-call",
      body: `Decision: one file per build (e2e #${f.number}).\nOptions: one shared file, then one per build.\nRationale: the e2e stub's convention; a shared file conflicts between builds.\nRejected: a shared file.`,
    }).catch(() => null);
    await log({
      kind: "decision",
      category: "judgment-call",
      ...(journal ? { refs: [journal] } : {}),
      body: `One file per build (e2e #${f.number}) — a shared file would conflict between builds`,
    }).catch(() => null);
    await log({ kind: "build", body: `Commit: e2e stub\nTests: none (the stub)\nReview: none\nNot verified: everything (it's the stub)` }).catch(() => null);
  }
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
    case "review_ci_fail": // CI red before the review: the fix CI needs
      await putFile(gh, f, head.ref, "ci-state", "pass\n", "e2e stub: fix CI");
      return "pushed";
    case "review_findings_once": // the review's findings: a push, but only with a review to act on
    case "review_findings_always": {
      // As the real rework-loop: findings left anywhere but a PR review look
      // like nothing to do, so no review means no push.
      const reviews = (await gh("GET", `${base(f)}/pulls/${f.number}/reviews?per_page=100`)) as { body: string }[];
      if (!Array.isArray(reviews) || !reviews.some((r) => r.body.includes(REVIEW_SIGNATURE))) return "none";
      await putFile(gh, f, head.ref, `rework/${f.number}.txt`, `addressed ${Date.now()}\n`, "e2e stub: address the review");
      return "pushed";
    }
    default:
      return "none";
  }
}

const GREEN = new Set(["success", "neutral", "skipped"]);

/** Merge attempts while the base branch settles: 2 s, then 4 s (inside a
 * Worker's 30 s waitUntil, with the webhook's own re-checks). */
const MERGE_ATTEMPTS = 3;
const MERGE_RETRY_MS = 2000;

/**
 * merge-flow's gate and merge. Real merge-flow polls CI for minutes; the
 * stub can't wait inside a request, so it acts on what's there now and the
 * stub's own check_suite webhook calls this again when CI finishes.
 * A conflict or requested changes are the orchestrator's to block.
 */
export async function mergeIfGreen(gh: Gh, f: Fire, mergeRetryMs = MERGE_RETRY_MS): Promise<Action> {
  const pr = (await gh("GET", `${base(f)}/pulls/${f.number}`)) as {
    state: string;
    mergeable: boolean | null;
    head: { sha: string };
    labels: { name: string }[];
  };
  if (pr.state !== "open" || !pr.labels.some((l) => l.name === LABELS.AUTO_MERGING)) return "none";

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

  // GitHub refuses a merge (405/409) both when another attempt already merged
  // it (the fire and the check_suite webhook can race) and while the base
  // branch is still settling after another merge into it. Tell them apart by
  // re-reading the PR, and retry the second, as the real merge-flow would.
  for (let attempt = 1; ; attempt++) {
    try {
      await gh("PUT", `${base(f)}/pulls/${f.number}/merge`, { merge_method: "squash" });
      break;
    } catch (e) {
      if (!(e instanceof Error && / (405|409) /.test(e.message))) throw e;
      const now = (await gh("GET", `${base(f)}/pulls/${f.number}`)) as { state: string; merged?: boolean };
      if (now.merged || now.state !== "open" || attempt >= MERGE_ATTEMPTS) return "none";
      await new Promise((r) => setTimeout(r, mergeRetryMs * attempt));
    }
  }
  await comment(gh, f, "e2e stub (merge-flow): merged (squash).");
  return "merged";
}

/**
 * review-loop's verdict, scripted by the PR's hint: review_findings_once
 * asks for changes on its first round and passes the next;
 * review_findings_always never passes (the cap); review_block blocks;
 * review_pass and review_ci_fail pass.
 */
async function review(gh: Gh, f: Fire, hint: string | null): Promise<Action> {
  const verdict = async (outcome: Outcome) => {
    // As the real review-loop: findings and a block go in a PR review (a
    // comment review: the stub may be the PR's author), the verdict in a comment.
    if (outcome.outcome !== "review_passed") {
      await gh("POST", `${base(f)}/pulls/${f.number}/reviews`, { event: "COMMENT", body: `${REVIEW_SIGNATURE}\n${outcome.outcome}` });
    }
    await comment(gh, f, outcomeComment("review-loop", outcome));
    return outcome.outcome as Action;
  };
  switch (hint) {
    case "review_pass":
    case "review_ci_fail":
      return verdict({ outcome: "review_passed" });
    case "review_block":
      return verdict({ outcome: "review_blocked", reason: "e2e stub: scripted block" });
    case "review_findings_always":
      return verdict({ outcome: "review_findings", findings: 1 });
    case "review_findings_once": {
      const comments = (await gh("GET", `${base(f)}/issues/${f.number}/comments?per_page=100`)) as { body: string }[];
      const asked = comments.some((c) => c.body.includes('"outcome":"review_findings"'));
      return verdict(asked ? { outcome: "review_passed" } : { outcome: "review_findings", findings: 1 });
    }
    default:
      return "none";
  }
}

/**
 * The release split's before part, orchestrated: what auto-release-loop does
 * (cut release/<version> from dev, open its PR into main, the pre-publish
 * review passes) ending in release_approved with the reviewed head and the
 * merge method. The orchestrator merges, then fires release-publish.
 */
async function approveRelease(gh: Gh, f: Fire): Promise<Action> {
  const version = `0.0.${f.number}`;
  const branch = `release/${version}`;
  const { object } = (await gh("GET", `${base(f)}/git/ref/heads/dev`)) as { object: { sha: string } };
  await gh("POST", `${base(f)}/git/refs`, { ref: `refs/heads/${branch}`, sha: object.sha });
  await putFile(gh, f, branch, `releases/${version}.txt`, `released ${version}\n`, `chore(release): ${version}`);
  const pr = (await gh("POST", `${base(f)}/pulls`, {
    title: `release ${version}`,
    head: branch,
    base: "main",
    // "Part of", not "Closes": on the default branch "Closes" would close
    // the release issue at the merge, before release-publish has run.
    body: `The e2e stub's release PR. Part of #${f.number}.\n\n<!-- e2e: release -->`,
  })) as { number: number; head: { sha: string } };
  await comment(
    gh,
    f,
    outcomeComment("auto-release-loop", { outcome: "release_approved", pr: pr.number, sha: pr.head.sha, version, merge_method: "merge" }),
  );
  return "release_approved";
}

/**
 * The release split's after part (release-publish), with the repo's own
 * tagging workflow played too: tag the release PR's merge v<version>, then report
 * release_published with that tag. (The real skill also posts the release
 * note and merges main back into dev; the sandbox skips both.)
 */
async function publishRelease(gh: Gh, f: Fire, hint: string | null): Promise<Action> {
  if (hint !== "approve") return "none";
  const version = `0.0.${f.number}`;
  const tag = `v${version}`;
  // The release PR's merge commit, as release-tag.yml tags the push that
  // merge made. Not main's head: read straight after the merge it can still
  // be the commit before it (e2e #826, 06-10-2026).
  const prs = (await gh("GET", `${base(f)}/pulls?state=closed&base=main&head=${f.owner}:release/${version}`)) as {
    merge_commit_sha: string | null;
  }[];
  const sha = prs.find((p) => p.merge_commit_sha)?.merge_commit_sha;
  if (!sha) return "none";
  await gh("POST", `${base(f)}/git/refs`, { ref: `refs/tags/${tag}`, sha });
  await comment(gh, f, outcomeComment("release-publish", { outcome: "release_published", version, tag }));
  return "release_published";
}

async function release(gh: Gh, f: Fire, hint: string | null): Promise<Action> {
  if (hint === "blocked") {
    await comment(gh, f, outcomeComment("auto-release-loop", { outcome: "release_blocked", reason: "e2e stub: scripted block" }));
    return "release_blocked";
  }
  if (hint === "approve") return approveRelease(gh, f);
  if (hint !== "published") return "none";
  const version = `0.0.${f.number}`;
  // The tag a real release makes (release-tag.yml), on what's on dev: the
  // orchestrator checks it contains each waiting issue's merge.
  const { object } = (await gh("GET", `${base(f)}/git/ref/heads/dev`)) as { object: { sha: string } };
  await gh("POST", `${base(f)}/git/refs`, { ref: `refs/tags/v${version}`, sha: object.sha });
  await comment(gh, f, outcomeComment("auto-release-loop", { outcome: "release_published", version }));
  // The real loop closes the issue itself on publish (a native close).
  await gh("PATCH", `${base(f)}/issues/${f.number}`, { state: "closed" });
  return "release_published";
}
