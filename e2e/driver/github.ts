// The driver's GitHub access: your own `gh` login (or GITHUB_TOKEN), so its
// label adds arrive as a human's, the way a maintainer's do.

import { execFileSync } from "node:child_process";

export const REPO = process.env.E2E_REPO ?? "hifi-phil/mcp-ops-e2e-testing";

let token: string | undefined;
function authToken(): string {
  token ??= process.env.GITHUB_TOKEN ?? execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  return token;
}

export async function gh<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${authToken()}`,
      Accept: "application/vnd.github+json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? null : await res.json()) as T;
}

export type Snapshot = { state: string; labels: string[]; comments: string[] };

export async function snapshot(number: number): Promise<Snapshot> {
  const issue = await gh<{ state: string; labels: { name: string }[] }>("GET", `/repos/${REPO}/issues/${number}`);
  const comments = await gh<{ body: string }[]>("GET", `/repos/${REPO}/issues/${number}/comments?per_page=100`);
  return { state: issue.state, labels: issue.labels.map((l) => l.name).sort(), comments: comments.map((c) => c.body) };
}

/** Polls until `done` holds or the timeout passes, returning the last
 * snapshot either way so a failed assertion shows where it got stuck. */
export async function waitFor(
  number: number,
  done: (s: Snapshot) => boolean,
  timeoutMs: number,
  pollMs = 5000,
): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await snapshot(number);
    if (done(s) || Date.now() >= deadline) return s;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
