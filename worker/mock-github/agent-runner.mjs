// Runs a REAL Claude Agent SDK session to check that a loop's outcome-
// reporting step is actually followed correctly — not a hand-typed curl
// standing in for what the loop "would" do. The agent gets the VERBATIM
// text of the relevant SKILL.md section read live off disk (so this
// drifts with the real skills, never with a paraphrase of them) plus a
// small set of tools that mutate this mock's real issue state via
// mock-state.mjs — so its tool calls fire the same webhooks a raw curl
// would, and the self-trigger guard gets exercised for real.
//
// Deliberately scoped, per routine: this does NOT simulate the loop's
// full work (worktree, implementation, CI, mcp-review, the release
// review agent, publishing) — that's real infrastructure work, not
// something worth faking here. It starts from "the work up to the
// outcome step already happened" as a given and checks only whether the
// agent then does what that step says to do about it. Covers the full
// agent-outcomes catalog (issue-build-loop's build_succeeded/blocked,
// auto-release-loop's release_blocked/published) — see worker/README.md
// for why rework-loop's push and merge-flow's merge are deliberately NOT
// covered here (native GitHub signals, no self-report to fake; simulated
// directly via mock-state.mjs's firePrSynchronize/firePrMerged instead).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  getIssue,
  BOT_SENDER,
  addLabelInternal,
  removeLabelInternal,
  postCommentInternal,
  createIssueInternal,
  setIssueStateInternal,
} from "./mock-state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const AGENT_OUTCOMES_SKILL_PATH = path.join(REPO_ROOT, "plugins/agent-outcomes/skills/agent-outcomes/SKILL.md");

function extractSection(markdown, startHeading, endHeading) {
  const start = markdown.indexOf(startHeading);
  if (start === -1) throw new Error(`heading not found: ${startHeading}`);
  const afterStart = start + startHeading.length;
  const end = endHeading ? markdown.indexOf(endHeading, afterStart) : -1;
  return markdown.slice(start, end === -1 ? undefined : end).trim();
}

function readSection(skillFile, startHeading, endHeading) {
  return extractSection(readFileSync(skillFile, "utf8"), startHeading, endHeading);
}

function readOutcomesSkill() {
  return readFileSync(AGENT_OUTCOMES_SKILL_PATH, "utf8");
}

// Every tool takes an explicit issue_number — same shape as the real
// github-ops skill (operations parameterized by number, not bound to one
// fixed issue) — since auto-release-loop's Step 2.5 acts on the
// triggering issue AND a newly-created one in the same run. Built
// per-run, bound to this run's owner/repo, so tool implementations don't
// need extra plumbing to know which repo they're operating on.
function buildServer(owner, repo) {
  const getLabels = tool("get_labels", "Get the current labels on an issue or PR.", { issue_number: z.number() }, async ({ issue_number }) => ({
    content: [{ type: "text", text: JSON.stringify([...getIssue(owner, repo, issue_number).labels]) }],
  }));
  const addLabel = tool(
    "add_label",
    "Add a label to an issue or PR (github-ops: Add / remove a label).",
    { issue_number: z.number(), label: z.string() },
    async ({ issue_number, label }) => ({
      content: [{ type: "text", text: JSON.stringify(addLabelInternal(owner, repo, issue_number, label, BOT_SENDER)) }],
    }),
  );
  const removeLabel = tool(
    "remove_label",
    "Remove a label from an issue or PR (github-ops: Add / remove a label).",
    { issue_number: z.number(), label: z.string() },
    async ({ issue_number, label }) => ({
      content: [{ type: "text", text: JSON.stringify(removeLabelInternal(owner, repo, issue_number, label, BOT_SENDER)) }],
    }),
  );
  const postComment = tool(
    "post_comment",
    "Post a comment on an issue or PR (github-ops: Comment on an issue).",
    { issue_number: z.number(), body: z.string() },
    async ({ issue_number, body }) => ({
      content: [{ type: "text", text: JSON.stringify(postCommentInternal(owner, repo, issue_number, body, BOT_SENDER)) }],
    }),
  );
  const createIssue = tool(
    "create_issue",
    "Create a new issue in this repo (github-ops: Create an issue).",
    { title: z.string(), body: z.string() },
    async ({ title, body }) => ({
      content: [{ type: "text", text: JSON.stringify(createIssueInternal(owner, repo, title, body, BOT_SENDER)) }],
    }),
  );
  const closeIssue = tool(
    "close_issue",
    "Close an issue (github-ops: Close an issue).",
    { issue_number: z.number() },
    async ({ issue_number }) => ({
      content: [{ type: "text", text: JSON.stringify(setIssueStateInternal(owner, repo, issue_number, "closed", BOT_SENDER)) }],
    }),
  );
  return createSdkMcpServer({
    name: "github_ops",
    version: "1.0.0",
    tools: [getLabels, addLabel, removeLabel, postComment, createIssue, closeIssue],
  });
}

const ALL_TOOL_NAMES = [
  "mcp__github_ops__get_labels",
  "mcp__github_ops__add_label",
  "mcp__github_ops__remove_label",
  "mcp__github_ops__post_comment",
  "mcp__github_ops__create_issue",
  "mcp__github_ops__close_issue",
];

function markerCheck(commentBody, expectedOutcome, matchesShape) {
  const markerPresent = commentBody.includes(`<!-- agent-outcome:${expectedOutcome.routine} -->`);
  const jsonMatch = commentBody.match(/```json\s*([\s\S]*?)```/);
  let parsed = null;
  try {
    parsed = jsonMatch ? JSON.parse(jsonMatch[1]) : null;
  } catch {
    parsed = null;
  }
  return { markerPresent, outcomeJsonMatches: Boolean(parsed) && matchesShape(parsed) };
}

const ISSUE_BUILD_LOOP_SKILL = path.join(REPO_ROOT, "plugins/mcp-issue-loop/skills/issue-build-loop/SKILL.md");
const AUTO_RELEASE_LOOP_SKILL = path.join(REPO_ROOT, "plugins/release-flow/skills/auto-release-loop/SKILL.md");

// Each entry: how to build the system prompt + task prompt for one
// (routine, outcome) pair, the tool calls expected, and the check against
// the resulting mock state. `params` carries the scenario-specific facts
// (pr number, reason, version) the caller supplies.
const OUTCOME_CONFIGS = {
  "issue-build-loop:build_succeeded": {
    routine: "issue-build-loop",
    section: () => readSection(ISSUE_BUILD_LOOP_SKILL, "## Step 3", "## Step 4"),
    prompt: ({ issueNumber, owner, repo, params }) =>
      `Issue #${issueNumber} in ${owner}/${repo}. Everything up to the outcome step has already ` +
      `happened: a build subagent implemented the fix, CI is green, and mcp-review just came back ` +
      `clean on PR #${params.pr}. Perform Step 3's outcome step for exactly this situation now.`,
    checks: (toolCalls, issue) => {
      const comment = toolCalls.find((c) => c.name.endsWith("post_comment"));
      const marker = markerCheck(comment?.input?.body ?? "", { routine: "issue-build-loop" }, (j) => j.outcome === "build_succeeded");
      return {
        removedAiReady: toolCalls.some((c) => c.name.endsWith("remove_label") && c.input?.label === "ai-ready"),
        addedAiGenerated: toolCalls.some((c) => c.name.endsWith("add_label") && c.input?.label === "ai-generated"),
        posted: Boolean(comment),
        ...marker,
        finalLabelsCorrect: !issue.labels.has("ai-ready") && issue.labels.has("ai-generated"),
      };
    },
  },
  "issue-build-loop:build_blocked": {
    routine: "issue-build-loop",
    section: () => readSection(ISSUE_BUILD_LOOP_SKILL, "## Step 3", "## Step 4"),
    prompt: ({ issueNumber, owner, repo, params }) =>
      `Issue #${issueNumber} in ${owner}/${repo}. The CI-green cap tripped after repeated fix ` +
      `attempts. The last failing check's log said: "${params.reason}". Perform Step 3's outcome ` +
      `step for exactly this blocked situation now.`,
    checks: (toolCalls, issue) => {
      const comment = toolCalls.find((c) => c.name.endsWith("post_comment"));
      const marker = markerCheck(comment?.input?.body ?? "", { routine: "issue-build-loop" }, (j) => j.outcome === "build_blocked" && typeof j.reason === "string");
      return {
        removedAiReady: toolCalls.some((c) => c.name.endsWith("remove_label") && c.input?.label === "ai-ready"),
        addedAiBlocked: toolCalls.some((c) => c.name.endsWith("add_label") && c.input?.label === "ai-blocked"),
        posted: Boolean(comment),
        ...marker,
        finalLabelsCorrect: !issue.labels.has("ai-ready") && issue.labels.has("ai-blocked"),
      };
    },
  },
  "auto-release-loop:release_blocked": {
    routine: "auto-release-loop",
    section: () => readSection(AUTO_RELEASE_LOOP_SKILL, "## Step 2.5", "## Step 3"),
    prompt: ({ issueNumber, owner, repo, params }) =>
      `Issue #${issueNumber} in ${owner}/${repo} is the triggering issue for auto-release-loop, ` +
      `releasing version ${params.version}. Everything up to the pre-publish review has already ` +
      `happened: CI is green on the release PR #${params.pr}. The release-reviewer agent just ` +
      `returned VERDICT: BLOCK with these findings: "${params.findings}". Perform Step 2.5's outcome ` +
      `step for exactly this BLOCK situation now (skip the push-notification sub-step — no such tool here).`,
    checks: (toolCalls, issue) => {
      const created = toolCalls.find((c) => c.name.endsWith("create_issue"));
      const comment = toolCalls.find((c) => c.name.endsWith("post_comment") && c.input?.issue_number === issue.number);
      const marker = markerCheck(comment?.input?.body ?? "", { routine: "auto-release-loop" }, (j) => j.outcome === "release_blocked" && typeof j.reason === "string");
      return {
        createdBlockedIssue: Boolean(created),
        removedAutoReleasing: toolCalls.some((c) => c.name.endsWith("remove_label") && c.input?.label === "auto-releasing"),
        posted: Boolean(comment),
        ...marker,
        finalLabelRemoved: !issue.labels.has("auto-releasing"),
      };
    },
  },
  "auto-release-loop:release_published": {
    routine: "auto-release-loop",
    section: () => readSection(AUTO_RELEASE_LOOP_SKILL, "## Step 4", "## Guardrails"),
    prompt: ({ issueNumber, owner, repo, params }) =>
      `Issue #${issueNumber} in ${owner}/${repo} is the triggering issue for auto-release-loop. ` +
      `Everything up to this step already happened: release PR #${params.pr} for version ` +
      `${params.version} was merged, tagged v${params.version}, the GitHub Release was published, ` +
      `and main was synced back to dev. Perform Step 4's outcome step for exactly this situation now ` +
      `(skip the push-notification sub-step — no such tool here).`,
    checks: (toolCalls, issue) => {
      const comment = toolCalls.find((c) => c.name.endsWith("post_comment"));
      const closed = toolCalls.some((c) => c.name.endsWith("close_issue"));
      const marker = markerCheck(comment?.input?.body ?? "", { routine: "auto-release-loop" }, (j) => j.outcome === "release_published" && typeof j.version === "string");
      return {
        posted: Boolean(comment),
        closedIssue: closed,
        ...marker,
        finalStateClosed: issue.state === "closed",
      };
    },
  },
};

function buildSystemPrompt(config) {
  return [
    `You are the ${config.routine} routine, currently executing the outcome-reporting step of ` +
      `your own skill, for one issue. You are given the exact, current, verbatim text of that step ` +
      `below, and of the agent-outcomes skill it points to for the outcome-artifact format. Follow ` +
      `them exactly — do not paraphrase or improvise a different action.`,
    "You have six tools: get_labels, add_label, remove_label, post_comment, create_issue, " +
      "close_issue — each takes an explicit issue_number. There is no worktree, no CI, no " +
      "mcp-review or release-reviewer tool, no git, no Slack, no push-notification tool here — " +
      "assume everything before the outcome step has already genuinely happened, as described in " +
      "the task you're given, and perform only the outcome step for that situation.",
    "",
    `=== the outcome-reporting step, verbatim from ${config.routine}/SKILL.md ===`,
    config.section(),
    "",
    "=== agent-outcomes/SKILL.md, verbatim ===",
    readOutcomesSkill(),
  ].join("\n");
}

/**
 * @param {{routine: string, owner: string, repo: string, issueNumber: number, scenario: {type: string, [k: string]: any}}} input
 */
export async function runLoopOutcome({ routine, owner, repo, issueNumber, scenario }) {
  if (!routine || !owner || !repo || !issueNumber || !scenario?.type) {
    throw new Error("routine, owner, repo, issueNumber, and scenario.type are required");
  }
  const configKey = `${routine}:${scenario.type}`;
  const config = OUTCOME_CONFIGS[configKey];
  if (!config) {
    throw new Error(
      `no OUTCOME_CONFIGS entry for "${configKey}" — supported: ${Object.keys(OUTCOME_CONFIGS).join(", ")}`,
    );
  }

  const server = buildServer(owner, repo);
  const toolCalls = [];
  let finalResult = null;

  for await (const message of query({
    prompt: config.prompt({ issueNumber, owner, repo, params: scenario }),
    options: {
      systemPrompt: buildSystemPrompt(config),
      tools: [],
      mcpServers: { github_ops: server },
      allowedTools: ALL_TOOL_NAMES,
      // SDK isolation mode — without this, query() loads THIS repo's own
      // .claude/settings.json (hooks, marketplace plugins, slash commands),
      // since cwd defaults to process.cwd(). Confirmed by observation: an
      // early version without this ran SessionStart hooks and produced
      // duplicate/misnamed tool-call entries. The agent under test must not
      // run under the real session's own hook/plugin config.
      settingSources: [],
    },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "tool_use") toolCalls.push({ name: block.name, input: block.input });
      }
    }
    if (message.type === "result") finalResult = message;
  }

  const issue = getIssue(owner, repo, issueNumber);
  return {
    ok: true,
    routine,
    scenario,
    toolCalls,
    resultSubtype: finalResult?.subtype ?? null,
    resultText: finalResult?.result ?? null,
    finalIssueState: { labels: [...issue.labels], state: issue.state, comments: issue.comments },
    checks: config.checks(toolCalls, { ...issue, number: issueNumber }),
  };
}
