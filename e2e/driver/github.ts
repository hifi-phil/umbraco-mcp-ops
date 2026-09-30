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

const ATTEMPTS = 4;

/** Retries a network error or a 5xx: a scenario runs for minutes, and one
 * dropped connection from the driver's own side shouldn't fail it. */
export async function gh<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${authToken()}`,
          Accept: "application/vnd.github+json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      if (attempt >= ATTEMPTS) throw e;
      await sleep(2000 * attempt);
      continue;
    }
    if (res.status >= 500 && attempt < ATTEMPTS) {
      await sleep(2000 * attempt);
      continue;
    }
    if (!res.ok) throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${await res.text()}`);
    return (res.status === 204 ? null : await res.json()) as T;
  }
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
export async function waitFor(number: number, done: (s: Snapshot) => boolean, timeoutMs: number, pollMs = 8000) {
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
  base?: string;
  /** An existing branch to open the PR from, instead of a new one. */
  branch?: string;
  /** Runs after the branch's commits, before the PR opens (e.g. the other side of a conflict). */
  beforePr?: () => Promise<void>;
}): Promise<{ number: number; branch: string }> {
  const branch = opts.branch ?? `e2e/${opts.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
  if (!opts.branch) {
    await gh("POST", `${R}/git/refs`, { ref: `refs/heads/${branch}`, sha: opts.fromSha ?? (await devSha()) });
  }
  for (const [path, content] of Object.entries(opts.files)) await putFile(branch, path, content, `e2e: ${path}`);
  await opts.beforePr?.();
  const { number } = await gh<{ number: number }>("POST", `${R}/pulls`, {
    title: `e2e: ${opts.title}`,
    head: branch,
    base: opts.base ?? "dev",
    body: `An e2e scenario's PR.\n\n<!-- e2e: ${opts.hint} -->`,
  });
  return { number, branch };
}

/** GitHub computes `mergeable` in the background; wait until it reads
 * `want`. Right after a push it can still show the old value rather than
 * null, so the first non-null answer isn't enough. */
export async function waitForMergeable(number: number, want: boolean, timeoutMs = 60_000): Promise<boolean | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { mergeable } = await gh<{ mergeable: boolean | null }>("GET", `${R}/pulls/${number}`);
    if (mergeable === want || Date.now() >= deadline) return mergeable;
    await sleep(2000);
  }
}

export async function comment(number: number, body: string): Promise<void> {
  await gh("POST", `${R}/issues/${number}/comments`, { body });
}

/** Changes an issue's or PR's hint, e.g. before a retry. */
export async function setHint(number: number, hint: string): Promise<void> {
  const { body } = await gh<{ body: string | null }>("GET", `${R}/issues/${number}`);
  await gh("PATCH", `${R}/issues/${number}`, { body: (body ?? "").replace(/<!--\s*e2e:\s*[\w-]+\s*-->/, `<!-- e2e: ${hint} -->`) });
}

export async function merge(number: number): Promise<void> {
  await gh("PUT", `${R}/pulls/${number}/merge`, { merge_method: "squash" });
}

export type CheckRun = { name: string; status: string; conclusion: string | null; completed_at: string | null };

/** Waits until every check on the PR's head has finished, and returns them. */
export async function waitForChecks(number: number, timeoutMs = 3 * 60_000): Promise<CheckRun[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { head } = await gh<{ head: { sha: string } }>("GET", `${R}/pulls/${number}`);
    const { check_runs } = await gh<{ check_runs: CheckRun[] }>("GET", `${R}/commits/${head.sha}/check-runs`);
    if ((check_runs.length > 0 && check_runs.every((r) => r.status === "completed")) || Date.now() >= deadline) return check_runs;
    await sleep(3000);
  }
}

export async function labelledAt(number: number, label: string): Promise<string | undefined> {
  const events = await gh<{ event: string; label?: { name: string }; created_at: string }[]>(
    "GET",
    `${R}/issues/${number}/events?per_page=100`,
  );
  return events.find((e) => e.event === "labeled" && e.label?.name === label)?.created_at;
}

// --- The orchestrator's webhook deliveries --------------------------------
// What the Worker answered each delivery (its JSON body), so a run can check
// that nothing errored and the table had a rule for everything it saw.
// Delivery ids overflow a JS number, so they're kept as strings.

async function ghText(path: string, init: RequestInit = {}): Promise<{ text: string; link: string | null }> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`https://api.github.com${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${authToken()}`, Accept: "application/vnd.github+json", ...init.headers },
      });
      if (res.status >= 500 && attempt < ATTEMPTS) throw new Error(`${res.status}`);
      if (!res.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`);
      return { text: await res.text(), link: res.headers.get("link") };
    } catch (e) {
      if (attempt >= ATTEMPTS || (e instanceof Error && e.message.startsWith("GitHub "))) throw e;
      await sleep(2000 * attempt);
    }
  }
}
const bigIds = (text: string) => text.replace(/"id":(\d{15,})/g, '"id":"$1"');

export async function workerHookId(): Promise<number> {
  const hooks = await gh<{ id: number; config: { url: string } }[]>("GET", `${R}/hooks`);
  const hook = hooks.find((h) => !h.config.url.endsWith("/webhook"));
  if (!hook) throw new Error(`no orchestrator webhook on ${REPO}`);
  return hook.id;
}

export type Delivery = { id: string; guid: string; event: string; action: string | null; redelivery: boolean; delivered_at: string };

/** Deliveries since `since` (ISO), newest first, following GitHub's cursor pages. */
export async function deliveriesSince(hookId: number, since: string): Promise<Delivery[]> {
  const out: Delivery[] = [];
  let path: string | null = `${R}/hooks/${hookId}/deliveries?per_page=100`;
  while (path) {
    const { text, link } = await ghText(path);
    const page = JSON.parse(bigIds(text)) as Delivery[];
    out.push(...page.filter((d) => d.delivered_at >= since));
    const next = link?.match(/<https:\/\/api\.github\.com([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    path = page.length > 0 && page[page.length - 1]!.delivered_at >= since ? next : null;
  }
  return out;
}

export type DeliveryDetail = {
  event: string;
  action: string | null;
  statusCode: number;
  numbers: number[];
  response: string;
};

export async function deliveryDetail(hookId: number, id: string): Promise<DeliveryDetail> {
  const { text } = await ghText(`${R}/hooks/${hookId}/deliveries/${id}`);
  const d = JSON.parse(bigIds(text)) as {
    event: string;
    action: string | null;
    status_code: number;
    request: { payload: Record<string, any> | null };
    response: { payload: string | null };
  };
  const p = d.request.payload ?? {};
  const numbers: number[] =
    p.issue?.number !== undefined
      ? [p.issue.number]
      : p.pull_request?.number !== undefined
        ? [p.pull_request.number]
        : (p.check_suite?.pull_requests ?? []).map((x: { number: number }) => x.number);
  return { event: d.event, action: d.action, statusCode: d.status_code, numbers, response: d.response.payload ?? "" };
}

export async function redeliver(hookId: number, id: string): Promise<void> {
  await ghText(`${R}/hooks/${hookId}/deliveries/${id}/attempts`, { method: "POST" });
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
