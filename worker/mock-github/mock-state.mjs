// In-memory GitHub state + webhook emission, shared by server.mjs's HTTP
// routes and agent-runner.mjs's tool implementations — extracted so a real
// agent's tool calls and a raw curl hit the exact same mutation + webhook
// path, not two parallel implementations that could drift.

import { randomUUID } from "node:crypto";

const WORKER_WEBHOOK_URL = process.env.WORKER_WEBHOOK_URL ?? "";
const BOT_TOKEN = process.env.BOT_TOKEN ?? "";
export const BOT_LOGIN = process.env.BOT_LOGIN ?? "umbraco-mcp-ops[bot]";
export const BOT_SENDER = { login: BOT_LOGIN, type: "Bot" };

/** @type {Map<string, { labels: Set<string>, state: "open" | "closed", comments: { id: number, body: string }[], title?: string, body?: string }>} */
const issues = new Map();
let nextCommentId = 1;
let nextIssueNumber = 9000; // high, to avoid colliding with manually-chosen test issue numbers

export function issueKey(owner, repo, number) {
  return `${owner}/${repo}#${number}`;
}
export function getIssue(owner, repo, number) {
  const key = issueKey(owner, repo, number);
  if (!issues.has(key)) issues.set(key, { labels: new Set(), state: "open", comments: [] });
  return issues.get(key);
}

export function resetState() {
  issues.clear();
  nextCommentId = 1;
  nextIssueNumber = 9000;
}

export function getAllState() {
  const out = {};
  for (const [key, v] of issues) out[key] = { labels: [...v.labels], state: v.state, comments: v.comments };
  return out;
}

export function senderFor(req) {
  const auth = req.headers["authorization"] ?? "";
  if (BOT_TOKEN && auth === `Bearer ${BOT_TOKEN}`) return BOT_SENDER;
  return { login: req.headers["x-mock-sender-login"]?.toString() ?? "external-tester", type: "User" };
}

/** Fire-and-forget, like real GitHub's own async webhook delivery — never
 * lets a webhook-delivery failure affect the caller's own result. */
export function fireWebhook(eventType, action, body, sender) {
  if (!WORKER_WEBHOOK_URL) return;
  const payload = { action, sender, ...body };
  fetch(WORKER_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": eventType,
      "X-GitHub-Delivery": randomUUID(),
    },
    body: JSON.stringify(payload),
  })
    .then((res) => console.log(`webhook ${eventType}.${action} -> ${res.status}`))
    .catch((err) => console.error(`webhook ${eventType}.${action} failed:`, err.message));
}

export function getLabelsInternal(owner, repo, issueNumber) {
  return [...getIssue(owner, repo, issueNumber).labels];
}

export function addLabelInternal(owner, repo, issueNumber, label, sender) {
  const issue = getIssue(owner, repo, issueNumber);
  const alreadyPresent = issue.labels.has(label);
  issue.labels.add(label);
  if (!alreadyPresent) {
    fireWebhook(
      "issues",
      "labeled",
      { label: { name: label }, repository: { name: repo, owner: { login: owner } }, issue: { number: issueNumber } },
      sender,
    );
  }
  return { alreadyPresent, labels: [...issue.labels] };
}

export function removeLabelInternal(owner, repo, issueNumber, label, sender) {
  const issue = getIssue(owner, repo, issueNumber);
  const existed = issue.labels.delete(label);
  if (existed) {
    fireWebhook(
      "issues",
      "unlabeled",
      { label: { name: label }, repository: { name: repo, owner: { login: owner } }, issue: { number: issueNumber } },
      sender,
    );
  }
  return { existed, labels: [...issue.labels] };
}

export function postCommentInternal(owner, repo, issueNumber, body, sender) {
  const issue = getIssue(owner, repo, issueNumber);
  const comment = { id: nextCommentId++, body };
  issue.comments.push(comment);
  fireWebhook(
    "issue_comment",
    "created",
    { comment: { body }, repository: { name: repo, owner: { login: owner } }, issue: { number: issueNumber } },
    sender,
  );
  return comment;
}

export function createIssueInternal(owner, repo, title, body, sender) {
  const number = nextIssueNumber++;
  const issue = getIssue(owner, repo, number);
  issue.title = title;
  issue.body = body;
  fireWebhook(
    "issues",
    "opened",
    { repository: { name: repo, owner: { login: owner } }, issue: { number, title, body } },
    sender,
  );
  return { number, title, body };
}

export function setIssueStateInternal(owner, repo, issueNumber, state, sender) {
  const issue = getIssue(owner, repo, issueNumber);
  if (issue.state === state) return { changed: false, state };
  issue.state = state;
  fireWebhook(
    "issues",
    state === "closed" ? "closed" : "reopened",
    { repository: { name: repo, owner: { login: owner } }, issue: { number: issueNumber } },
    sender,
  );
  return { changed: true, state };
}

/** Native, directly-observable PR signals — no agent involved, real or
 * mocked: a push and a merge are GitHub events, not self-reports, so the
 * correct stand-in is firing the raw webhook, not an LLM call. See
 * graph/github/from-github.ts's translate() for pull_request.synchronize
 * -> REWORK_PUSHED and pull_request.closed(merged) -> MERGED. */
export function firePrSynchronize(owner, repo, prNumber, sender) {
  fireWebhook(
    "pull_request",
    "synchronize",
    { repository: { name: repo, owner: { login: owner } }, pull_request: { number: prNumber } },
    sender,
  );
}

export function firePrMerged(owner, repo, prNumber, sender) {
  // Mirrors reality: merge-flow's own real merge call already closed the
  // PR before this webhook fires — the webhook is confirmation, not the
  // action itself (see graph.ts's EVENTS.MERGED rule comment). Only fires
  // pull_request.closed, not a separate issues.closed — real GitHub
  // doesn't double-fire those for a PR merge, even though a PR is also an
  // "issue" in GitHub's data model.
  getIssue(owner, repo, prNumber).state = "closed";
  fireWebhook(
    "pull_request",
    "closed",
    {
      repository: { name: repo, owner: { login: owner } },
      pull_request: { number: prNumber, merged: true },
    },
    sender,
  );
}
