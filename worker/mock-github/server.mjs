#!/usr/bin/env node
// A small, stateful mock of both external APIs the Worker calls, for
// testing the WHOLE stack locally — not just the Worker in isolation:
//
// - GitHub REST (labels, issue state, comments) — in-memory, so a label
//   the Worker just added actually shows up on the next GET, unlike a
//   canned-response stub.
// - Claude Code's routines API (POST /routines/:id) — a stub that just
//   logs the fired context and returns 200. This only covers the KICKOFF
//   fire (the routine starting); it does not simulate the routine's own
//   multi-step work. See agent-runner.mjs + the "Testing outcome fidelity
//   with a real agent" section in README.md for the part that actually
//   runs a real Claude Agent SDK session against Step 3's instructions.
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
import {
  getIssue,
  resetState,
  getAllState,
  senderFor,
  fireWebhook,
  addLabelInternal,
  removeLabelInternal,
  postCommentInternal,
  createIssueInternal,
  setIssueStateInternal,
  firePrSynchronize,
  firePrMerged,
} from "./mock-state.mjs";
import { runLoopOutcome } from "./agent-runner.mjs";

const PORT = process.env.MOCK_GITHUB_PORT ? Number(process.env.MOCK_GITHUB_PORT) : 8943;

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (req.method === "POST" && parts[0] === "mock" && parts[1] === "reset") {
    resetState();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && parts[0] === "mock" && parts[1] === "state") {
    return sendJson(res, 200, getAllState());
  }

  // A convenience endpoint to kick off the loop as if a human did it on
  // github.com — adds the label AND fires the webhook, matching real
  // GitHub's actual behaviour (a UI action is one atomic state-change +
  // webhook, not two separate steps the way calling the REST API directly
  // and then separately triggering a webhook would be).
  if (req.method === "POST" && parts[0] === "mock" && parts[1] === "simulate-label") {
    const body = await readJsonBody(req);
    const { owner, repo, issueNumber, label, senderLogin } = body;
    const sender = { login: senderLogin ?? "external-tester", type: "User" };
    const issue = getIssue(owner, repo, issueNumber);
    issue.labels.add(label);
    fireWebhook(
      "issues",
      "labeled",
      { label: { name: label }, repository: { name: repo, owner: { login: owner } }, issue: { number: issueNumber } },
      sender,
    );
    return sendJson(res, 200, { ok: true, labels: [...issue.labels] });
  }

  // Same as /mock/simulate-label, but fires pull_request.labeled instead
  // of issues.labeled — real GitHub picks the event type by whether the
  // labeled number is an issue or a PR, even though both go through the
  // same REST path; this mock's single issues Map doesn't track that
  // distinction, so callers pick the right endpoint for what they're
  // testing (auto-reworking/auto-merging are matched under
  // pull_request.labeled in translate(), not issues.labeled).
  if (req.method === "POST" && parts[0] === "mock" && parts[1] === "simulate-pr-label") {
    const body = await readJsonBody(req);
    const { owner, repo, prNumber, label, senderLogin } = body;
    const sender = { login: senderLogin ?? "external-tester", type: "User" };
    const issue = getIssue(owner, repo, prNumber);
    issue.labels.add(label);
    fireWebhook(
      "pull_request",
      "labeled",
      { label: { name: label }, repository: { name: repo, owner: { login: owner } }, pull_request: { number: prNumber } },
      sender,
    );
    return sendJson(res, 200, { ok: true, labels: [...issue.labels] });
  }

  // Runs a REAL Claude Agent SDK session against the verbatim text of one
  // loop's outcome-reporting step + the agent-outcomes skill, given a
  // fixed scenario, and reports back every tool call it made. Makes a
  // real, billed Anthropic API call — see README.md before scripting this
  // into a loop. Body: {routine, owner, repo, issueNumber, scenario} —
  // see agent-runner.mjs's ROUTINE_CONFIG for supported routine/scenario
  // combinations (issue-build-loop's build_succeeded/build_blocked,
  // auto-release-loop's release_blocked/release_published).
  if (req.method === "POST" && parts[0] === "mock" && parts[1] === "run-agent-outcome-test") {
    const body = await readJsonBody(req);
    try {
      const outcome = await runLoopOutcome(body);
      return sendJson(res, 200, outcome);
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
    }
  }

  // Native, directly-observable PR signals — no agent, no self-report,
  // just the raw webhook GitHub would fire. See mock-state.mjs's
  // firePrSynchronize/firePrMerged doc comment for why these two loop
  // signals (rework-loop's push, merge-flow's merge) are correctly NOT
  // agent-mocked, unlike the outcome-artifact ones above.
  if (req.method === "POST" && parts[0] === "mock" && parts[1] === "simulate-pr-push") {
    const body = await readJsonBody(req);
    const { owner, repo, prNumber, senderLogin } = body;
    firePrSynchronize(owner, repo, prNumber, { login: senderLogin ?? "external-tester", type: "User" });
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "POST" && parts[0] === "mock" && parts[1] === "simulate-pr-merge") {
    const body = await readJsonBody(req);
    const { owner, repo, prNumber, senderLogin } = body;
    firePrMerged(owner, repo, prNumber, { login: senderLogin ?? "external-tester", type: "User" });
    return sendJson(res, 200, { ok: true });
  }

  // Minimal Claude Code routines API stub — enough for fireRoutine() to
  // succeed; not a real simulation of what the routine would then do.
  if (req.method === "POST" && parts[0] === "routines" && parts[1]) {
    const body = await readJsonBody(req);
    console.log(`routine ${parts[1]} fired: ${body.additional_context ?? ""}`);
    return sendJson(res, 200, { ok: true });
  }

  if (parts[0] === "repos" && parts[3] === "issues" && parts.length === 4) {
    const [, owner, repo] = parts;
    const sender = senderFor(req);
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const created = createIssueInternal(owner, repo, body.title ?? "", body.body ?? "", sender);
      return sendJson(res, 201, created);
    }
  }

  if (parts[0] === "repos" && parts[3] === "issues") {
    const [, owner, repo, , numberStr, sub, labelName] = parts;
    const number = Number(numberStr);
    const issue = getIssue(owner, repo, number);
    const sender = senderFor(req);

    if (!sub && req.method === "PATCH") {
      const body = await readJsonBody(req);
      if (body.state === "open" || body.state === "closed") setIssueStateInternal(owner, repo, number, body.state, sender);
      return sendJson(res, 200, { number, state: getIssue(owner, repo, number).state });
    }

    if (sub === "labels" && !labelName) {
      if (req.method === "GET") return sendJson(res, 200, [...issue.labels].map((name) => ({ name })));
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        for (const l of body.labels ?? []) addLabelInternal(owner, repo, number, l, sender);
        return sendJson(res, 200, [...issue.labels].map((name) => ({ name })));
      }
    }

    if (sub === "labels" && labelName) {
      if (req.method === "DELETE") {
        const { existed } = removeLabelInternal(owner, repo, number, labelName, sender);
        return sendJson(res, existed ? 200 : 404, existed ? {} : { message: "Label does not exist" });
      }
    }

    if (sub === "comments") {
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const comment = postCommentInternal(owner, repo, number, body.body ?? "", sender);
        return sendJson(res, 201, comment);
      }
      if (req.method === "GET") return sendJson(res, 200, issue.comments);
    }
  }

  sendJson(res, 404, { message: "no mock route for this request", method: req.method, path: url.pathname });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock GitHub + routines API listening on http://127.0.0.1:${PORT}`);
  console.log(`  Webhook forwarding: ${process.env.WORKER_WEBHOOK_URL || "(disabled — set WORKER_WEBHOOK_URL)"}`);
  console.log(`  Bot identity:       ${process.env.BOT_TOKEN ? "enabled" : "(disabled — set BOT_TOKEN)"}`);
  console.log(`GET  /mock/state                  — inspect all in-memory issue state`);
  console.log(`POST /mock/reset                  — clear it`);
  console.log(`POST /mock/simulate-label         — {owner,repo,issueNumber,label,senderLogin} as a human action`);
  console.log(`POST /mock/simulate-pr-label      — same, but fires pull_request.labeled (for auto-reworking/auto-merging)`);
  console.log(`POST /mock/simulate-pr-push       — {owner,repo,prNumber,senderLogin} — native pull_request.synchronize, no agent`);
  console.log(`POST /mock/simulate-pr-merge      — {owner,repo,prNumber,senderLogin} — native pull_request.closed(merged), no agent`);
  console.log(`POST /mock/run-agent-outcome-test — {routine,owner,repo,issueNumber,scenario} — runs a REAL agent (costs $, see README)`);
});
