// Runs the real agent-outcomes hook (plugins/agent-outcomes/hooks/
// report-completion.sh), as a routine session would, against the deployed
// orchestrator: a PostToolUse event plus a transcript whose first prompt is
// the Worker's fire text for a sandbox issue. That's the hook -> Worker
// contract end to end, without an agent.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orchestratorUrl, REPO, tofuSecret } from "./github";
import { progress } from "./progress";

const HOOK = new URL("../../plugins/agent-outcomes/hooks/report-completion.sh", import.meta.url).pathname;

/** One hook call for `routine` on sandbox issue `number`, as `toolCall` (a PostToolUse event's tool_name + tool_input). */
export async function runHook(
  routine: string,
  number: number,
  toolCall: { tool_name: string; tool_input: Record<string, unknown> },
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "e2e-hook-"));
  const transcript = join(dir, "transcript.jsonl");
  writeFileSync(
    transcript,
    JSON.stringify({
      type: "user",
      message: { content: `loop-dispatch (cloud worker). A GitHub loop event was routed at the edge: route=${routine} repo=${REPO} number=${number}. Run the loop-dispatch skill…` },
    }) + "\n",
  );
  const event = { hook_event_name: "PostToolUse", session_id: `e2e-${number}`, transcript_path: transcript, ...toolCall };
  const log = join(dir, "hook.log");
  execFileSync("bash", [HOOK], {
    input: JSON.stringify(event),
    env: {
      ...process.env,
      AGENT_OUTCOMES_ENDPOINT: `${await orchestratorUrl()}/routine-signal`,
      AGENT_OUTCOMES_TOKEN: tofuSecret("routine_signal_secret", "E2E_ROUTINE_SIGNAL_SECRET"),
      AGENT_OUTCOMES_STATE: join(dir, "state"),
      AGENT_OUTCOMES_LOG: log,
    },
    stdio: ["pipe", "ignore", "ignore"],
  });
  let out = "";
  try {
    out = execFileSync("cat", [log], { encoding: "utf8" });
  } catch {
    out = "";
  }
  const sent = out.match(/sent [^\n]+/)?.[0] ?? "nothing sent";
  progress(`#${number} hook: ${sent}`);
  return out;
}
