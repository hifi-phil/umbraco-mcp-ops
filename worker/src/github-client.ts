// Thin wrapper over the GitHub REST API for the operations coordinate/types.ts's
// Deps interface needs. No retry/backoff logic here on purpose — that's
// the DO's job (via the watchdog alarm noticing a stuck attempt), not
// this client's; keeping this dumb makes it easy to reason about and easy
// to fully replace with github-ops's actual dual-path mechanism later.

import { appConfigured, forgetInstallationToken, installationToken, type GitHubAppEnv } from "./github-app";

export type GitHubEnv = GitHubAppEnv & {
  // A personal token, for local runs and tests without the GitHub App only.
  // A deployed Worker always has the App (GITHUB_APP_ID +
  // GITHUB_APP_PRIVATE_KEY; tofu sets no personal token), so every call goes
  // as the App's bot on an installation token (github-app.ts).
  GITHUB_APP_TOKEN?: string;
  // Overridable for local smoke-testing against a stub server instead of
  // the real API — see worker/README.md. Defaults to the real API in
  // every environment that doesn't set it, including production.
  GITHUB_API_BASE_URL?: string;
};

/** The token for a call on `path` (every call here is under /repos/{owner}/{repo}). */
async function tokenFor(env: GitHubEnv, path: string): Promise<string> {
  if (!appConfigured(env)) {
    if (env.GITHUB_APP_TOKEN) return env.GITHUB_APP_TOKEN;
    throw new Error("no GitHub access: set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY (or, locally, GITHUB_APP_TOKEN)");
  }
  const m = path.match(/^\/repos\/([^/]+)\/([^/]+)\//);
  if (!m) throw new Error(`no repo in GitHub path ${path}`);
  return installationToken(env, m[1]!, m[2]!);
}

/** Whether the Worker can call GitHub at all: the App, or (locally) a token. */
export function githubConfigured(env: GitHubEnv): boolean {
  return appConfigured(env) || !!env.GITHUB_APP_TOKEN;
}

/**
 * A 403 on the App's token is retried once on a fresh one (see
 * forgetInstallationToken): a cached token can predate a permission the App
 * has since been granted. A second 403 is a real refusal, and throws.
 *
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
  const call = async () =>
    fetch(`${base}${path}`, {
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
  let res = await call();
  const repo = path.match(/^\/repos\/([^/]+)\/([^/]+)\//);
  if (res.status === 403 && appConfigured(env) && repo) {
    forgetInstallationToken(repo[1]!, repo[2]!);
    res = await call();
  }
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

/** An issue or PR (GitHub's issues API covers both), or null if it's gone. */
export async function getIssue(env: GitHubEnv, owner: string, repo: string, issueNumber: number): Promise<Record<string, unknown> | null> {
  const res = await gh(env, "GET", `/repos/${owner}/${repo}/issues/${issueNumber}`, undefined, { allow404: true });
  if (res.status === 404) return null;
  return (await res.json()) as Record<string, unknown>;
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

export async function getPullDetails(
  env: GitHubEnv,
  owner: string,
  repo: string,
  pr: number,
): Promise<{ headRef: string; headSha: string; baseRef: string; defaultBranch: string; merged: boolean }> {
  const res = await gh(env, "GET", `/repos/${owner}/${repo}/pulls/${pr}`);
  const p = (await res.json()) as {
    head: { ref: string; sha: string };
    base: { ref: string; repo: { default_branch: string } };
    merged: boolean;
  };
  return { headRef: p.head.ref, headSha: p.head.sha, baseRef: p.base.ref, defaultBranch: p.base.repo.default_branch, merged: p.merged };
}

/** Merges a PR the way the project says (merge, squash or rebase), only if
 * its head is still `sha`. GitHub's refusal (head moved, not mergeable)
 * throws with its message. */
export async function mergePull(env: GitHubEnv, owner: string, repo: string, pr: number, sha: string, method: "merge" | "squash" | "rebase"): Promise<void> {
  await gh(env, "PUT", `/repos/${owner}/${repo}/pulls/${pr}/merge`, { merge_method: method, sha });
}

/** Whether `ref` (a tag or branch) contains commit `sha`: the compare
 * from the commit to the ref is "ahead" or "identical". A missing ref or
 * commit (404) reads as not contained. */
export async function commitInRef(env: GitHubEnv, owner: string, repo: string, sha: string, ref: string): Promise<boolean> {
  const res = await gh(env, "GET", `/repos/${owner}/${repo}/compare/${sha}...${encodeURIComponent(ref)}`, undefined, { allow404: true });
  if (res.status === 404) return false;
  const { status } = (await res.json()) as { status: string };
  return status === "ahead" || status === "identical";
}

/** Open issues and PRs carrying `label` (the sweep's candidates). */
export async function openWithLabel(
  env: GitHubEnv,
  owner: string,
  repo: string,
  label: string,
): Promise<{ number: number; updatedAt: string; title: string }[]> {
  const found: { number: number; updatedAt: string; title: string }[] = [];
  for (let page = 1; ; page++) {
    const res = await gh(
      env,
      "GET",
      `/repos/${owner}/${repo}/issues?state=open&per_page=100&page=${page}&labels=${encodeURIComponent(label)}`,
    );
    const issues = (await res.json()) as Array<{ number: number; updated_at: string; title: string }>;
    found.push(...issues.map((i) => ({ number: i.number, updatedAt: i.updated_at, title: i.title })));
    if (issues.length < 100) return found;
  }
}
