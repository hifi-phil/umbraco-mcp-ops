// The driver's GitHub access: your own `gh` login (or GITHUB_TOKEN), so its
// label adds arrive as a human's, the way a maintainer's do.

import { execFileSync } from "node:child_process";
import { progress } from "./progress";
import { appJwt } from "../../worker/src/github-app";

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
  let seen: string | undefined;
  for (;;) {
    const s = await snapshot(number);
    const now = `${s.merged ? "merged" : s.state} [${s.labels.join(", ")}]`;
    if (seen !== undefined && now !== seen) progress(`#${number} ${seen} -> ${now}`);
    seen = now;
    if (done(s)) return s;
    if (Date.now() >= deadline) {
      progress(`#${number} gave up waiting after ${Math.round(timeoutMs / 1000)}s at ${now}`);
      return s;
    }
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
  progress(`opened issue #${number} (hint: ${hint})`);
  return number;
}

export async function addLabel(number: number, label: string): Promise<void> {
  await gh("POST", `${R}/issues/${number}/labels`, { labels: [label] });
  progress(`#${number} +${label}`);
}

/** A human taking a label off by hand, as a maintainer would. */
export async function removeLabel(number: number, label: string): Promise<void> {
  await gh("DELETE", `${R}/issues/${number}/labels/${encodeURIComponent(label)}`);
  progress(`#${number} -${label} (by hand)`);
}

let me: string | undefined;
/** The driver's own login: who a scenario's human edits come from. */
export async function driverLogin(): Promise<string> {
  me ??= (await gh<{ login: string }>("GET", "/user")).login;
  return me;
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
  if (branch === "dev" || process.env.E2E_VERBOSE) progress(`pushed ${path} to ${branch}`);
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
  progress(`opened PR #${number} into ${opts.base ?? "dev"} (hint: ${opts.hint})`);
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
  progress(`#${number} comment: ${body.split("\n")[0]!.slice(0, 60)}`);
}

/** Changes an issue's or PR's hint, e.g. before a retry. */
export async function setHint(number: number, hint: string): Promise<void> {
  const { body } = await gh<{ body: string | null }>("GET", `${R}/issues/${number}`);
  await gh("PATCH", `${R}/issues/${number}`, { body: (body ?? "").replace(/<!--\s*e2e:\s*[\w-]+\s*-->/, `<!-- e2e: ${hint} -->`) });
  progress(`#${number} hint -> ${hint}`);
}

export async function merge(number: number): Promise<void> {
  await gh("PUT", `${R}/pulls/${number}/merge`, { merge_method: "squash" });
  progress(`PR #${number} merged by hand`);
}

export type CheckRun = { name: string; status: string; conclusion: string | null; completed_at: string | null };

/**
 * The CI results for a commit: the jobs of its Actions runs (the sandbox's CI
 * is one Actions job). Read through the Actions API, not check-runs: a
 * fine-grained token, as the deploy workflow's E2E_GITHUB_TOKEN is, can't read
 * check-runs on a private repo, but can read Actions with Actions: read.
 */
export async function ciRuns(sha: string): Promise<CheckRun[]> {
  const { workflow_runs } = await gh<{ workflow_runs: { id: number }[] }>("GET", `${R}/actions/runs?head_sha=${sha}&per_page=100`);
  const jobs: CheckRun[] = [];
  for (const run of workflow_runs) {
    const page = await gh<{ jobs: CheckRun[] }>("GET", `${R}/actions/runs/${run.id}/jobs?per_page=100`);
    jobs.push(...page.jobs.map(({ name, status, conclusion, completed_at }) => ({ name, status, conclusion, completed_at })));
  }
  return jobs;
}

/** Waits until every check on the PR's head has finished, and returns them. */
export async function waitForChecks(number: number, timeoutMs = 3 * 60_000): Promise<CheckRun[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { head } = await gh<{ head: { sha: string } }>("GET", `${R}/pulls/${number}`);
    const check_runs = await ciRuns(head.sha);
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

async function ghText(path: string, init: RequestInit = {}, token?: string): Promise<{ text: string; link: string | null }> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`https://api.github.com${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token ?? authToken()}`, Accept: "application/vnd.github+json", ...init.headers },
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

/**
 * Where the orchestrator's deliveries are listed. They come from its
 * GitHub App's webhook, readable only as the App (a JWT from its key, which
 * the driver reads from tofu and never prints). A repo hook pointing at the
 * Worker, if one is still there, is used instead.
 */
export type Hook = { base: string; token: () => Promise<string | undefined> };

export async function workerHook(): Promise<Hook> {
  const hooks = await gh<{ id: number; config: { url: string } }[]>("GET", `${R}/hooks`);
  const repoHook = hooks.find((h) => !h.config.url.endsWith("/webhook"));
  if (repoHook) return { base: `${R}/hooks/${repoHook.id}`, token: async () => undefined };
  return {
    base: "/app/hook",
    token: () => appJwt(tofuOutput("github_app_id"), tofuSecret("github_app_private_key", "E2E_APP_PRIVATE_KEY")),
  };
}

export type Delivery = { id: string; guid: string; event: string; action: string | null; redelivery: boolean; delivered_at: string };

/** Deliveries since `since` (ISO), newest first, following GitHub's cursor pages. */
export async function deliveriesSince(hook: Hook, since: string): Promise<Delivery[]> {
  const out: Delivery[] = [];
  let path: string | null = `${hook.base}/deliveries?per_page=100`;
  while (path) {
    const { text, link } = await ghText(path, {}, await hook.token());
    const page = JSON.parse(bigIds(text)) as Delivery[];
    out.push(...page.filter((d) => d.delivered_at >= since));
    const next = link?.match(/<https:\/\/api\.github\.com([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    path = page.length > 0 && page[page.length - 1]!.delivered_at >= since ? next : null;
  }
  return out;
}

export type DeliveryDetail = {
  guid: string;
  /** owner/repo: the App's hook delivers for every repo it's installed on. */
  repo: string;
  event: string;
  action: string | null;
  statusCode: number;
  numbers: number[];
  response: string;
};

export async function deliveryDetail(hook: Hook, id: string): Promise<DeliveryDetail> {
  const { text } = await ghText(`${hook.base}/deliveries/${id}`, {}, await hook.token());
  const d = JSON.parse(bigIds(text)) as {
    guid: string;
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
  return {
    guid: d.guid,
    repo: p.repository?.full_name ?? "",
    event: d.event,
    action: d.action,
    statusCode: d.status_code,
    numbers,
    response: d.response.payload ?? "",
  };
}

export async function redeliver(hook: Hook, id: string): Promise<void> {
  await ghText(`${hook.base}/deliveries/${id}/attempts`, { method: "POST" }, await hook.token());
}

// --- The orchestrator's D1 log (GET /transitions, sandbox only) ------------

export type LogRow = {
  id: number;
  delivery_id: string | null;
  from_state: string;
  event: string;
  to_effect: string | null;
  run: string | null;
  dropped_reason: string | null;
  mode: string;
  created_at: string;
};

const secrets = new Map<string, string>();
/** A sensitive tofu output, or its env override; read once, never printed. */
export function tofuSecret(output: string, envName: string): string {
  if (!secrets.has(output)) {
    secrets.set(
      output,
      process.env[envName] ??
        execFileSync("tofu", [`-chdir=${new URL("../../worker/terraform", import.meta.url).pathname}`, "output", "-raw", output], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim(),
    );
  }
  return secrets.get(output)!;
}
const logReadSecret = () => tofuSecret("e2e_log_read_secret", "E2E_LOG_SECRET");
/** A plain (not sensitive) tofu output, e.g. worker_url. */
export const tofuOutput = (name: string) => tofuSecret(name, `E2E_${name.toUpperCase()}`);

/** The orchestrator's URL (tofu's worker_url; E2E_WORKER_URL overrides). */
export async function orchestratorUrl(): Promise<string> {
  return tofuOutput("worker_url").replace(/\/$/, "");
}

export type SweepSummary = { repos: string[]; checked: number; refired: string[]; wouldRefire: string[]; errors: string[] };

/** An on-demand reconciliation sweep of the sandbox (the Worker's POST /sweep). */
export async function sweep(): Promise<SweepSummary> {
  const res = await fetch(`${await orchestratorUrl()}/sweep`, {
    method: "POST",
    headers: { Authorization: `Bearer ${logReadSecret()}` },
  });
  if (!res.ok) throw new Error(`POST /sweep failed: ${res.status} ${await res.text()}`);
  const summary = (await res.json()) as SweepSummary;
  progress(`sweep: checked ${summary.checked}, re-fired [${summary.refired.join(", ")}]`);
  return summary;
}

export type StatusRow = {
  owner: string;
  repo: string;
  issue_number: number;
  state: string;
  routine: string | null;
  attempt: number;
  running: number;
  last_step: string | null;
  rework_count: number;
};

/** This sandbox issue's live-status row (the Worker's GET /status), or
 * undefined if it has none (closed, or never tracked). */
export async function statusOf(number: number): Promise<StatusRow | undefined> {
  const res = await fetch(`${await orchestratorUrl()}/status?format=json`, {
    headers: { Authorization: `Bearer ${tofuSecret("status_secret", "E2E_STATUS_SECRET")}` },
  });
  if (!res.ok) throw new Error(`GET /status failed: ${res.status} ${await res.text()}`);
  const { rows } = (await res.json()) as { rows: StatusRow[] };
  return rows.find((r) => `${r.owner}/${r.repo}` === REPO.toLowerCase() && r.issue_number === number);
}

/** Every row the orchestrator logged for this issue/PR, oldest first. */
export async function transitions(number: number): Promise<LogRow[]> {
  const [owner, repo] = REPO.split("/");
  const url = `${await orchestratorUrl()}/transitions?owner=${owner}&repo=${repo}&issue=${number}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${logReadSecret()}` } });
      if (!res.ok) throw new Error(`GET /transitions for #${number} failed: ${res.status} ${await res.text()}`);
      return ((await res.json()) as { rows: LogRow[] }).rows;
    } catch (e) {
      if (attempt >= ATTEMPTS || (e instanceof Error && / 4\d\d /.test(e.message))) throw e;
      await sleep(2000 * attempt);
    }
  }
}

/** A review on a sandbox PR, submitted by the stub as the orchestrator's App bot. */
export async function review(number: number, event: "REQUEST_CHANGES" | "APPROVE"): Promise<{ state: string; by: string }> {
  const hooks = await gh<{ config: { url: string } }[]>("GET", `${R}/hooks`);
  const stubHook = hooks.map((h) => h.config.url).find((u) => u.endsWith("/webhook"));
  if (!stubHook) throw new Error(`no stub webhook on ${REPO}`);
  const res = await fetch(stubHook.replace(/\/webhook$/, "/review"), {
    method: "POST",
    headers: { Authorization: `Bearer ${tofuSecret("e2e_fire_token", "E2E_FIRE_TOKEN")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ number, event }),
  });
  if (!res.ok) throw new Error(`stub /review for #${number} failed: ${res.status} ${await res.text()}`);
  const out = (await res.json()) as { state: string; by: string };
  progress(`PR #${number} ${out.state.toLowerCase().replace(/_/g, " ")} by ${out.by}`);
  return out;
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
