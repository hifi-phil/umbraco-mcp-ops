// The driver's GitHub access: your own `gh` login (or GITHUB_TOKEN), so its
// label adds arrive as a human's, the way a maintainer's do.

import { execFileSync } from "node:child_process";

export const REPO = process.env.E2E_REPO ?? "hifi-phil/mcp-ops-e2e-testing";
const R = `/repos/${REPO}`;

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

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Snapshot = { state: string; merged: boolean; labels: string[]; comments: string[] };

export async function snapshot(number: number): Promise<Snapshot> {
  const issue = await gh<{ state: string; labels: { name: string }[]; pull_request?: { merged_at: string | null } }>(
    "GET",
    `${R}/issues/${number}`,
  );
  const comments = await gh<{ body: string }[]>("GET", `${R}/issues/${number}/comments?per_page=100`);
  return {
    state: issue.state,
    merged: !!issue.pull_request?.merged_at,
    labels: issue.labels.map((l) => l.name).sort(),
    comments: comments.map((c) => c.body),
  };
}

/** Polls until `done` holds or the timeout passes, returning the last
 * snapshot either way so a failed assertion shows where it got stuck. */
export async function waitFor(number: number, done: (s: Snapshot) => boolean, timeoutMs: number, pollMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await snapshot(number);
    if (done(s) || Date.now() >= deadline) return s;
    await sleep(pollMs);
  }
}

/** Every label added or removed, in order: the path an issue took, which
 * polling alone can miss when a label only stays on for a second. */
export async function labelHistory(number: number): Promise<string[]> {
  const events = await gh<{ event: string; label?: { name: string } }[]>("GET", `${R}/issues/${number}/events?per_page=100`);
  return events
    .filter((e) => (e.event === "labeled" || e.event === "unlabeled") && e.label)
    .map((e) => `${e.event === "labeled" ? "+" : "-"}${e.label!.name}`);
}

export function hasMarker(snap: Snapshot, loop: string, outcome: string): boolean {
  return snap.comments.some((c) => c.includes(`<!-- agent-outcome:${loop} -->`) && c.includes(`"outcome":"${outcome}"`));
}

export async function openIssue(title: string, body: string, hint: string): Promise<number> {
  const { number } = await gh<{ number: number }>("POST", `${R}/issues`, {
    title: `e2e: ${title}`,
    body: `${body}\n\n<!-- e2e: ${hint} -->`,
  });
  return number;
}

export async function addLabel(number: number, label: string): Promise<void> {
  await gh("POST", `${R}/issues/${number}/labels`, { labels: [label] });
}

export async function devSha(): Promise<string> {
  return (await gh<{ object: { sha: string } }>("GET", `${R}/git/ref/heads/dev`)).object.sha;
}

/** One commit on `branch` writing `path` (creating or replacing it). */
export async function putFile(branch: string, path: string, content: string, message: string): Promise<void> {
  let sha: string | undefined;
  try {
    ({ sha } = await gh<{ sha: string }>("GET", `${R}/contents/${path}?ref=${encodeURIComponent(branch)}`));
  } catch {
    sha = undefined;
  }
  await gh("PUT", `${R}/contents/${path}`, {
    message,
    content: Buffer.from(content).toString("base64"),
    branch,
    ...(sha ? { sha } : {}),
  });
}

/** A branch off dev (or `fromSha`) with `files` committed, and a PR into dev. */
export async function openPr(opts: {
  title: string;
  hint: string;
  files: Record<string, string>;
  fromSha?: string;
}): Promise<{ number: number; branch: string }> {
  const branch = `e2e/${opts.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
  await gh("POST", `${R}/git/refs`, { ref: `refs/heads/${branch}`, sha: opts.fromSha ?? (await devSha()) });
  for (const [path, content] of Object.entries(opts.files)) await putFile(branch, path, content, `e2e: ${path}`);
  const { number } = await gh<{ number: number }>("POST", `${R}/pulls`, {
    title: `e2e: ${opts.title}`,
    head: branch,
    base: "dev",
    body: `An e2e scenario's PR.\n\n<!-- e2e: ${opts.hint} -->`,
  });
  return { number, branch };
}

/** GitHub computes `mergeable` in the background; wait until it has. */
export async function waitForMergeable(number: number, timeoutMs = 60_000): Promise<boolean | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { mergeable } = await gh<{ mergeable: boolean | null }>("GET", `${R}/pulls/${number}`);
    if (mergeable !== null || Date.now() >= deadline) return mergeable;
    await sleep(2000);
  }
}

/** Close whatever a scenario left open, and delete an unmerged PR's branch. */
export async function cleanUp(numbers: number[], branches: string[] = []): Promise<void> {
  for (const n of numbers) {
    const { state } = await gh<{ state: string }>("GET", `${R}/issues/${n}`);
    if (state === "open") await gh("PATCH", `${R}/issues/${n}`, { state: "closed" });
  }
  for (const b of branches) {
    await gh("DELETE", `${R}/git/refs/heads/${b}`).catch(() => {}); // already gone after a merge
  }
}
