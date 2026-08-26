// Thin wrapper over the GitHub REST API for the operations coordinate.ts's
// Deps interface needs. No retry/backoff logic here on purpose — that's
// the DO's job (via the watchdog alarm noticing a stuck attempt), not
// this client's; keeping this dumb makes it easy to reason about and easy
// to fully replace with github-ops's actual dual-path mechanism later.

export type GitHubEnv = {
  GITHUB_APP_TOKEN: string;
  // Overridable for local smoke-testing against a stub server instead of
  // the real API — see worker/README.md. Defaults to the real API in
  // every environment that doesn't set it, including production.
  GITHUB_API_BASE_URL?: string;
};

async function gh(env: GitHubEnv, method: string, path: string, body?: unknown): Promise<Response> {
  const base = env.GITHUB_API_BASE_URL ?? "https://api.github.com";
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_APP_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agent-orchestration-worker",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 404) {
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
  if (res.status === 404) return [];
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
  // A 404 here means the label was already gone (e.g. a human beat us to
  // it) -- gh() already tolerates 404 as non-fatal, so nothing extra here.
  await gh(
    env,
    "DELETE",
    `/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
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
): Promise<Array<{ status: string; conclusion: string | null }>> {
  const res = await gh(env, "GET", `/repos/${owner}/${repo}/commits/${ref}/check-runs`);
  const body = (await res.json()) as { check_runs: Array<{ status: string; conclusion: string | null }> };
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
