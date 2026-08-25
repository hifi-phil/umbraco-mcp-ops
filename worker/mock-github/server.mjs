#!/usr/bin/env node
// A small, stateful mock of both external APIs the Worker calls, for
// testing the WHOLE stack locally — not just the Worker in isolation:
//
// - GitHub REST (labels, issue state, comments) — in-memory, so a label
//   the Worker just added actually shows up on the next GET, unlike a
//   canned-response stub.
// - Claude Code's routines API (POST /routines/:id) — a stub that just
//   logs the fired context and returns 200. Not a real mock of routine
//   behaviour, just enough for the Worker's fireRoutine() call to succeed.
//
// The important part for whole-stack testing: every GitHub REST call that
// changes state (label add/remove, a new comment, issue open/closed) also
// fires a webhook to WORKER_WEBHOOK_URL, exactly like real GitHub does —
// including for changes the Worker's OWN calls make. That's what lets you
// actually exercise the self-trigger guard (translate()'s isOwnBot check)
// against a real webhook loop instead of just a unit test with a fixed
// sender. Attribution: a request whose Authorization header matches
// BOT_TOKEN is attributed to BOT_LOGIN; anything else is attributed to
// whatever X-Mock-Sender-Login header it sent (default "external-tester").
//
// Not a GitHub clone: no auth check beyond the bot-token comparison above,
// no pagination, no rate limits. State is in-memory only — resets on
// restart, or via POST /mock/reset.

import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = process.env.MOCK_GITHUB_PORT ? Number(process.env.MOCK_GITHUB_PORT) : 8943;
const WORKER_WEBHOOK_URL = process.env.WORKER_WEBHOOK_URL ?? "";
const BOT_TOKEN = process.env.BOT_TOKEN ?? "";
const BOT_LOGIN = process.env.BOT_LOGIN ?? "umbraco-mcp-ops[bot]";

/** @type {Map<string, { labels: Set<string>, state: "open" | "closed", comments: { id: number, body: string }[] }>} */
const issues = new Map();
let nextCommentId = 1;

function issueKey(owner, repo, number) {
  return `${owner}/${repo}#${number}`;
}
function getIssue(owner, repo, number) {
  const key = issueKey(owner, repo, number);
  if (!issues.has(key)) issues.set(key, { labels: new Set(), state: "open", comments: [] });
  return issues.get(key);
}
function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function senderFor(req) {
  const auth = req.headers["authorization"] ?? "";
  if (BOT_TOKEN && auth === `Bearer ${BOT_TOKEN}`) {
    return { login: BOT_LOGIN, type: "Bot" };
  }
  return { login: req.headers["x-mock-sender-login"]?.toString() ?? "external-tester", type: "User" };
}

/** Fire-and-forget, like real GitHub's own async webhook delivery — never
 * lets a webhook-delivery failure affect the REST call's own response. */
function fireWebhook(eventType, action, body, sender) {
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (req.method === "POST" && parts[0] === "mock" && parts[1] === "reset") {
    issues.clear();
    nextCommentId = 1;
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && parts[0] === "mock" && parts[1] === "state") {
    const out = {};
    for (const [key, v] of issues) out[key] = { labels: [...v.labels], state: v.state, comments: v.comments };
    return sendJson(res, 200, out);
  }

  // A convenience endpoint to kick off the loop as if a human did it on
  // github.com — adds the label AND fires the webhook, matching real
  // GitHub's actual behaviour (a UI action is one atomic state-change +
  // webhook, not two separate steps the way calling the REST API directly
  // and then separately triggering a webhook would be).
  if (req.method === "POST" && parts[0] === "mock" && parts[1] === "simulate-label") {
    const body = await readJsonBody(req);
    const { owner, repo, issueNumber, label, senderLogin } = body;
    const issue = getIssue(owner, repo, issueNumber);
    issue.labels.add(label);
    const sender = { login: senderLogin ?? "external-tester", type: "User" };
    fireWebhook("issues", "labeled", {
      label: { name: label },
      repository: { name: repo, owner: { login: owner } },
      issue: { number: issueNumber },
    }, sender);
    return sendJson(res, 200, { ok: true, labels: [...issue.labels] });
  }

  // Minimal Claude Code routines API stub — enough for fireRoutine() to
  // succeed; not a real simulation of what the routine would then do.
  if (req.method === "POST" && parts[0] === "routines" && parts[1]) {
    const body = await readJsonBody(req);
    console.log(`routine ${parts[1]} fired: ${body.additional_context ?? ""}`);
    return sendJson(res, 200, { ok: true });
  }

  if (parts[0] === "repos" && parts[3] === "issues") {
    const [, owner, repo, , numberStr, sub, labelName] = parts;
    const number = Number(numberStr);
    const issue = getIssue(owner, repo, number);
    const sender = senderFor(req);

    if (!sub && req.method === "PATCH") {
      const body = await readJsonBody(req);
      if (body.state === "open" || body.state === "closed") issue.state = body.state;
      fireWebhook("issues", issue.state === "closed" ? "closed" : "reopened", {
        repository: { name: repo, owner: { login: owner } },
        issue: { number },
      }, sender);
      return sendJson(res, 200, { number, state: issue.state });
    }

    if (sub === "labels" && !labelName) {
      if (req.method === "GET") return sendJson(res, 200, [...issue.labels].map((name) => ({ name })));
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        for (const l of body.labels ?? []) {
          issue.labels.add(l);
          fireWebhook("issues", "labeled", {
            label: { name: l },
            repository: { name: repo, owner: { login: owner } },
            issue: { number },
          }, sender);
        }
        return sendJson(res, 200, [...issue.labels].map((name) => ({ name })));
      }
    }

    if (sub === "labels" && labelName) {
      if (req.method === "DELETE") {
        const existed = issue.labels.delete(labelName);
        if (existed) {
          fireWebhook("issues", "unlabeled", {
            label: { name: labelName },
            repository: { name: repo, owner: { login: owner } },
            issue: { number },
          }, sender);
        }
        return sendJson(res, existed ? 200 : 404, existed ? {} : { message: "Label does not exist" });
      }
    }

    if (sub === "comments") {
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const comment = { id: nextCommentId++, body: body.body ?? "" };
        issue.comments.push(comment);
        fireWebhook("issue_comment", "created", {
          comment: { body: comment.body },
          repository: { name: repo, owner: { login: owner } },
          issue: { number },
        }, sender);
        return sendJson(res, 201, comment);
      }
      if (req.method === "GET") return sendJson(res, 200, issue.comments);
    }
  }

  sendJson(res, 404, { message: "no mock route for this request", method: req.method, path: url.pathname });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock GitHub + routines API listening on http://127.0.0.1:${PORT}`);
  console.log(`  Webhook forwarding: ${WORKER_WEBHOOK_URL || "(disabled — set WORKER_WEBHOOK_URL)"}`);
  console.log(`  Bot identity:       ${BOT_TOKEN ? BOT_LOGIN : "(disabled — set BOT_TOKEN)"}`);
  console.log(`GET  /mock/state           — inspect all in-memory issue state`);
  console.log(`POST /mock/reset           — clear it`);
  console.log(`POST /mock/simulate-label  — {owner,repo,issueNumber,label,senderLogin} as a human action`);
});
