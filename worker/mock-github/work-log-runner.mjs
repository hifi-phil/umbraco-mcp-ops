// Runs a REAL Claude Agent SDK session to check that the work-log steps
// (docs/agent-orchestration/16-work-log.md) are actually followed: that an
// agent given the VERBATIM work-log skill and issue-build-loop's
// references/work-log.md, read live off disk, writes the entries those
// say to write. The same shape as agent-runner.mjs: no real build, no real
// Worker; the agent is told what already happened and gets one tool,
// log_entry, which stands in for log-entry.sh and the Worker's /log (the
// same checks: kinds, categories, a one-line decision, refs only on a
// decision) and records every call.
//
// Three steps, one scenario each (test/evals/work-log.eval.test.mjs):
// - journal: the build subagent records its choices as it makes them, and
//   not its routine steps.
// - decision-list: a fresh subagent derives the list from a journal (with
//   refs), and flags a choice the diff shows that nobody journalled.
// - build-entry: the orchestrator's build entry has what it should.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const WORK_LOG_SKILL = path.join(REPO_ROOT, "plugins/agent-outcomes/skills/work-log/SKILL.md");
const BUILD_WORK_LOG = path.join(REPO_ROOT, "plugins/mcp-issue-loop/skills/issue-build-loop/references/work-log.md");

const KINDS = ["journal", "decision", "build"];
const CATEGORIES = ["assumption", "deviation", "workaround", "judgment-call"];

/** The log: entries seeded by the scenario, then whatever the agent adds. */
function makeLog(seed) {
  const entries = seed.map((e, i) => ({ id: i + 1, refs: [], ...e }));
  const added = [];
  const add = ({ kind, category, refs, body }) => {
    // The Worker's own checks (work-log.ts handleLogAdd), so a bad entry is
    // refused here as it would be there, and the agent sees why.
    if (!KINDS.includes(kind)) return { error: `kind must be one of: ${KINDS.join(", ")}` };
    if (kind !== "build" && !CATEGORIES.includes(category)) return { error: `a ${kind} entry needs a category: ${CATEGORIES.join(", ")}` };
    if (refs?.length && kind !== "decision") return { error: "refs: a decision's journal entry ids" };
    if (!body?.trim()) return { error: "body is required" };
    if (kind === "decision" && body.trim().includes("\n")) return { error: "a decision is one line" };
    const entry = { id: entries.length + 1, kind, category: kind === "build" ? null : category, refs: refs ?? [], body };
    entries.push(entry);
    added.push(entry);
    return { id: entry.id };
  };
  return { entries, added, add };
}

function buildServer(log) {
  const logEntry = tool(
    "log_entry",
    "The work log (the work-log skill's log-entry.sh): action 'add' adds a journal, decision or build entry and returns its id; action 'read' returns the entries.",
    {
      action: z.enum(["add", "read"]),
      kind: z.enum(["journal", "decision", "build"]).optional(),
      category: z.string().optional(),
      refs: z.array(z.number()).optional(),
      body: z.string().optional(),
    },
    async (input) => ({
      content: [{ type: "text", text: JSON.stringify(input.action === "read" ? { entries: log.entries } : log.add(input)) }],
    }),
  );
  return createSdkMcpServer({ name: "work_log", version: "1.0.0", tools: [logEntry] });
}

const oneOf = (s, words) => words.some((w) => s.toLowerCase().includes(w));

const CONFIGS = {
  journal: {
    role: "the build subagent of issue-build-loop, given a log_token",
    // The lowest tier a code-touching build runs on.
    model: "claude-sonnet-5",
    seed: [],
    prompt: () =>
      "You are building issue #412, \"List form entries\": add a tool that lists a form's entries. " +
      "Here is what has happened in your work so far, in order. Record the work log as the work-log " +
      "skill says you would have, at each point, now:\n" +
      "1. You read the issue and the existing list tools.\n" +
      "2. You first implemented offset pagination, as the API docs show; the test that adds entries " +
      "while reading skipped rows, so you switched to cursor pagination, which every other list tool " +
      "in tools/ uses.\n" +
      "3. The issue asks to hide \"archived\" entries; Forms has no archive flag, so you treated entries " +
      "in the recycle bin as archived.\n" +
      "4. You named the file list-form-entries.ts, as the other tools are named.\n" +
      "5. You ran the tests: 42 run, 42 passed.\n" +
      "You are the build subagent: write only what the subagent writes.",
    checks: (log) => {
      const journal = log.added.filter((e) => e.kind === "journal");
      return {
        wroteJournal: journal.length >= 2,
        paginationJournalled: journal.some((e) => oneOf(e.body, ["cursor"])),
        assumptionJournalled: journal.some((e) => oneOf(e.body, ["recycle", "archiv"])),
        usedTemplate: journal.length > 0 && journal.every((e) => /Decided:/i.test(e.body) && /Considered:/i.test(e.body)),
        triedFirstIsInThePath: journal.some((e) => oneOf(e.body, ["cursor"]) && oneOf(e.body, ["offset"]) && oneOf(e.body, ["skip"])),
        noNoiseEntries: !journal.some((e) => /^Decided:[^\n]*(ran the tests|named the file|42 passed)/i.test(e.body)),
        notTooMany: journal.length <= 3,
        onlyJournal: log.added.every((e) => e.kind === "journal"),
      };
    },
  },
  "decision-list": {
    role: "the fresh decision-list subagent that issue-build-loop spawns at the end of a build",
    // Trying the cheapest tier: if this passes, the skill can spawn it on Haiku.
    model: "claude-haiku-4-5-20251001",
    seed: [
      { kind: "journal", category: "judgment-call", body: "Decided: cursor pagination for list-form-entries.\nConsidered: offset paging first; the test adding entries mid-read skipped rows.\nWhy: thousands of entries; every other list tool uses cursors.\nRejected: offset paging." },
      { kind: "journal", category: "assumption", body: "Decided: \"archived\" means in the recycle bin.\nConsidered: a custom archived property, the recycle bin.\nWhy: Forms has no archive flag.\nRejected: the property, which the API can't filter on." },
      { kind: "journal", category: "judgment-call", body: "Decided: a local const for the page token.\nConsidered: inlining it.\nWhy: reads more clearly.\nRejected: inlining." },
    ],
    prompt: () =>
      "Issue #412, \"List form entries\". The build is done and mcp-review has passed. The journal is " +
      "in the log (read it). The PR's diff adds tools/form/list-form-entries.ts: cursor pagination, " +
      "recycle-bin entries filtered out, and a page size of 50, where CLAUDE.md says list tools use 100 " +
      "(nothing in the journal mentions the page size). Do your job now, as the work-log skill's " +
      "*The decision list* says.",
    checks: (log) => {
      const decisions = log.added.filter((e) => e.kind === "decision");
      const refsTo = (id) => decisions.some((d) => d.refs.includes(id));
      return {
        readTheJournal: true, // see toolCalls in the result: a read is expected first
        wroteDecisions: decisions.length >= 2,
        paginationDecisionRefsJournal: refsTo(1),
        assumptionDecisionRefsJournal: refsTo(2),
        trivialChoiceLeftOut: !refsTo(3),
        flaggedUnjournalled: decisions.some((d) => /not journalled/i.test(d.body) && oneOf(d.body, ["50", "page size"]) && d.refs.length === 0),
        oneLineEach: decisions.every((d) => !d.body.trim().includes("\n")),
        onlyDecisions: log.added.every((e) => e.kind === "decision"),
      };
    },
  },
  "build-entry": {
    role: "issue-build-loop's orchestrator, at the end of a build, with a log_token",
    model: "claude-sonnet-5",
    seed: [],
    prompt: () =>
      "Issue #412. The build subagent has returned and journalled its choices; the decision-list " +
      "subagent has written the decision list. Facts: the PR's head commit is 3f9c2a1; the local gate " +
      "ran `npm run test:changed` on SQL Server, 42 run, 42 passed; mcp-review ran code-reviewer, " +
      "security-reviewer and pr-test-analyzer and found 2 issues (a missing uuid check, an untested 404), " +
      "both fixed; the eval suite wasn't run (only CI runs it). Write what you write at this point, " +
      "as references/work-log.md says, and nothing else.",
    checks: (log) => {
      const builds = log.added.filter((e) => e.kind === "build");
      const b = builds[0]?.body ?? "";
      return {
        oneBuildEntry: builds.length === 1,
        hasCommit: b.includes("3f9c2a1"),
        hasTestCounts: /42/.test(b),
        hasReview: /mcp-review|uuid|404/i.test(b),
        hasNotVerified: /not verified/i.test(b) && /eval/i.test(b),
        noOtherKinds: log.added.every((e) => e.kind === "build"),
      };
    },
  },
};

function systemPrompt(config) {
  return [
    `You are ${config.role}. You are given the exact, current, verbatim text of the work-log skill ` +
      `and of issue-build-loop's references/work-log.md. Follow them exactly.`,
    "Here, log-entry.sh is the `log_entry` tool: action 'add' (kind, category, refs, body) adds an " +
      "entry and returns its id; action 'read' returns the entries. There is no code, git, test or " +
      "GitHub tool: everything the task describes has genuinely happened. Do only the work-log steps.",
    "",
    "=== the work-log skill (SKILL.md), verbatim ===",
    readFileSync(WORK_LOG_SKILL, "utf8"),
    "",
    "=== issue-build-loop/references/work-log.md, verbatim ===",
    readFileSync(BUILD_WORK_LOG, "utf8"),
  ].join("\n");
}

/** @param {{step: "journal" | "decision-list" | "build-entry"}} input */
export async function runWorkLogStep({ step }) {
  const config = CONFIGS[step];
  if (!config) throw new Error(`no work-log step "${step}": ${Object.keys(CONFIGS).join(", ")}`);
  const log = makeLog(config.seed);
  const toolCalls = [];
  let finalResult = null;
  for await (const message of query({
    prompt: config.prompt(),
    options: {
      systemPrompt: systemPrompt(config),
      // Each step on the model that role runs on (also: the default model
      // refused these sessions before acting, run 37687625893).
      model: config.model,
      tools: [],
      mcpServers: { work_log: buildServer(log) },
      allowedTools: ["mcp__work_log__log_entry"],
      // Isolation, as agent-runner.mjs: never this repo's own settings, hooks or plugins.
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
  const checks = config.checks(log);
  if (step === "decision-list") {
    const firstAdd = toolCalls.findIndex((c) => c.input?.action === "add");
    const firstRead = toolCalls.findIndex((c) => c.input?.action === "read");
    checks.readTheJournal = firstRead !== -1 && (firstAdd === -1 || firstRead < firstAdd);
  }
  return {
    step,
    toolCalls,
    added: log.added,
    resultSubtype: finalResult?.subtype ?? null,
    costUsd: finalResult?.total_cost_usd ?? null,
    durationMs: finalResult?.duration_ms ?? null,
    checks,
  };
}
