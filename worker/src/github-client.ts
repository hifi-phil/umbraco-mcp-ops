// Thin wrapper over the GitHub REST API for the operations coordinate.ts's
// Deps interface needs. No retry/backoff logic here on purpose — that's
// the DO's job (via the watchdog alarm noticing a stuck attempt), not
// this client's; keeping this dumb makes it easy to reason about and easy
// to fully replace with github-ops's actual dual-path mechanism later.

import { appConfigured, installationToken, type GitHubAppEnv } from "./github-app";

export type GitHubEnv = GitHubAppEnv & {
  // A personal token, used only while the GitHub App isn't configured
  // (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY): with the App, every call goes
  // as the App's bot on an installation token (github-app.ts).
  GITHUB_APP_TOKEN: string;
  // Overridable for local smoke-testing against a stub server instead of
  // the real API — see worker/README.md. Defaults to the real API in
  // every environment that doesn't set it, including production.
  GITHUB_API_BASE_URL?: string;
};

/** The token for a call on `path` (every call here is under /repos/{owner}/{repo}). */
async function tokenFor(env: GitHubEnv, path: string): Promise<string> {
  if (!appConfigured(env)) return env.GITHUB_APP_TOKEN;
  const m = path.match(/^\/repos\/([^/]+)\/([^/]+)\//);
  if (!m) throw new Error(`no repo in GitHub path ${path}`);
  return installationToken(env, m[1]!, m[2]!);
}

/**
 * A 404 throws like any other failure. GitHub also answers 404 for a repo
 * the token can't see, so treating it as "nothing there" turned a missing
 * token grant into empty labels and silently skipped writes (found by the
 * first e2e run). Only removeLabel opts out, since there a 404 really does
 * mean the label was already gone.
 */
async function gh(
  env: GitHubEnv,
  method: string,
  path: string,
  body?: unknown,
  { allow404 = false }: { allow404?: boolean } = {},
): Promise<Response> {
  const base = env.GITHUB_API_BASE_URL ?? "https://api.github.com";
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await tokenFor(env, path)}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agent-orchestration-worker",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && !(allow404 && res.status === 404)) {
    throw new Error(`GitHub API ${method} ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res;
}

export async function getLabels(
  env: GitHubEnv,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<string[]> {
  const res = await gh(env, "GET", `/repos/${owner}/${repo}/issues/${issueNumber}/labels`);
  const labels = (await res.json()) as Array<{ name: string }>;
  return labels.map((l) => l.name);
}

export async function addLabel(
  env: GitHubEnv,
  owner: string,
  repo: string,
  issueNumber: number,
  label: string,
): Promise<void> {
  await gh(env, "POST", `/repos/${owner}/${repo}/issues/${issueNumber}/labels`, { labels: [label] });
}

export async function removeLabel(
  env: GitHubEnv,
  owner: string,
  repo: string,
  issueNumber: number,
  label: string,
): Promise<void> {
  // A 404 here means the label was already gone (e.g. a human beat us to it).
  await gh(
    env,
    "DELETE",
    `/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
    undefined,
    { allow404: true },
  );
}

export async function closeIssue(
  env: GitHubEnv,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<void> {
  await gh(env, "PATCH", `/repos/${owner}/${repo}/issues/${issueNumber}`, { state: "closed" });
}

export async function commentOnIssue(
  env: GitHubEnv,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  await gh(env, "POST", `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body });
}

// --- The three real facts merge-gate.ts's deriveMergeGateOutcome() needs
// (see that file's header for why this is I/O and can't live in
// translate()) ---

export async function getPull(
  env: GitHubEnv,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ headSha: string; mergeable: boolean | null }> {
  const res = await gh(env, "GET", `/repos/${owner}/${repo}/pulls/${prNumber}`);
  const pr = (await res.json()) as { head: { sha: string }; mergeable: boolean | null };
  return { headSha: pr.head.sha, mergeable: pr.mergeable };
}

export async function getCheckRuns(
  env: GitHubEnv,
  owner: string,
  repo: string,
  ref: string,
): Promise<Array<{ status: string; conclusion: string | null; name?: string }>> {
  const res = await gh(env, "GET", `/repos/${owner}/${repo}/commits/${ref}/check-runs`);
  const body = (await res.json()) as {
    check_runs: Array<{ status: string; conclusion: string | null; name?: string }>;
  };
  return body.check_runs;
}

/** Simplified vs. github-ops's real review-state operation — see
 * merge-gate.ts's LatestReviewState doc comment for what's approximated. */
export async function getLatestReviewState(
  env: GitHubEnv,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<"approved" | "changes_requested" | "commented" | "none"> {
  const res = await gh(env, "GET", `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`);
  const reviews = (await res.json()) as Array<{ state: string }>;
  if (reviews.length === 0) return "none";
  const state = reviews[reviews.length - 1]!.state.toLowerCase();
  if (state === "approved" || state === "changes_requested" || state === "commented") return state;
  return "none"; // e.g. "pending" or "dismissed" — not a live blocking or approving state
}

/** The open PRs whose head is `sha`: how a check_suite GitHub sent without
 * its pull_requests is routed (index.ts). */
export async function openPullsForCommit(env: GitHubEnv, owner: string, repo: string, sha: string): Promise<number[]> {
  const res = await gh(env, "GET", `/repos/${owner}/${repo}/commits/${sha}/pulls`);
  const pulls = (await res.json()) as Array<{ number: number; state: string }>;
  return pulls.filter((p) => p.state === "open").map((p) => p.number);
}
