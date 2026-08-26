// Fires a Claude Code routine by name, per the routines API call already
// sketched in 05-technical-elements.md — this is that call made real.
// Routine IDs aren't hardcoded: ROUTINE_IDS_JSON is a secret holding
// {"issue-build-loop": "rt_...", ...}, since the actual IDs only exist
// once routines are configured for real, outside this repo.

export type RoutinesEnv = {
  CLAUDE_API_KEY: string;
  ROUTINE_IDS_JSON: string;
  // Overridable for local smoke-testing against a stub server instead of
  // the real API — see worker/README.md. Defaults to the real API in
  // every environment that doesn't set it, including production.
  CLAUDE_API_BASE_URL?: string;
};

export async function fireRoutine(
  env: RoutinesEnv,
  routine: string,
  additionalContext: string,
): Promise<void> {
  let ids: Record<string, string>;
  try {
    ids = JSON.parse(env.ROUTINE_IDS_JSON);
  } catch {
    throw new Error("ROUTINE_IDS_JSON is not valid JSON");
  }

  const routineId = ids[routine];
  if (!routineId) {
    throw new Error(`No routine id configured for "${routine}" in ROUTINE_IDS_JSON`);
  }

  const base = env.CLAUDE_API_BASE_URL ?? "https://api.claude.com";
  const res = await fetch(`${base}/routines/${routineId}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CLAUDE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ additional_context: additionalContext }),
  });

  if (!res.ok) {
    throw new Error(`Routine fire failed for "${routine}": ${res.status} ${await res.text()}`);
  }
}
