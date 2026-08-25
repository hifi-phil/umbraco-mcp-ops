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
