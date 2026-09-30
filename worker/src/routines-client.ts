// Fires a repo's loop-dispatch routine exactly the way
// .github/workflows/loop-dispatch.yml does today: POST to that routine's
// Fire URL (Routines UI → Call via API) with its own token, the routines
// beta headers, and the same `route=… repo=… number=…` text. The
// loop-dispatch skill then dispatches to the named loop, so a fire from
// here is indistinguishable from one from the workflow.
//
// One routine per repo, so the config is a map: REPO_ROUTINES_JSON is a
// secret holding {"owner/repo": {"fireUrl": "...", "token": "..."}}. Keys
// match case-insensitively (GitHub names do).

export type RoutineTarget = { fireUrl: string; token: string };

export type RoutinesEnv = {
  REPO_ROUTINES_JSON: string;
};

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

export function routineTargetFor(env: RoutinesEnv, owner: string, repo: string): RoutineTarget {
  let map: Record<string, Partial<RoutineTarget>>;
  try {
    map = JSON.parse(env.REPO_ROUTINES_JSON);
  } catch {
    throw new Error("REPO_ROUTINES_JSON is not valid JSON");
  }
  const want = `${owner}/${repo}`.toLowerCase();
  const entry = Object.entries(map).find(([key]) => key.toLowerCase() === want)?.[1];
  if (!entry?.fireUrl || !entry.token) {
    // A config error, not a quiet skip: in enforce mode an unfired routine
    // is exactly the stall this system exists to prevent.
    throw new Error(`No loop-dispatch routine (fireUrl + token) configured for "${owner}/${repo}" in REPO_ROUTINES_JSON`);
  }
  return { fireUrl: entry.fireUrl, token: entry.token };
}

/** The workflow's text, word for word, with route-event.sh's result line. */
export function dispatchText(route: string, owner: string, repo: string, issueNumber: number): string {
  const result = `route=${route} repo=${owner}/${repo} number=${issueNumber}`;
  return (
    `loop-dispatch (cloud worker). A GitHub loop event was routed at the edge: ${result}. ` +
    `Run the loop-dispatch skill and dispatch this already-resolved route to its loop for that number, ` +
    `following loop-dispatch's guardrails (do all GitHub work via the GitHub MCP / github-ops). ` +
    `Re-check the entity still qualifies before acting; quiet no-op if not.`
  );
}

export async function fireRoutine(
  env: RoutinesEnv,
  owner: string,
  repo: string,
  issueNumber: number,
  route: string,
): Promise<void> {
  const target = routineTargetFor(env, owner, repo);
  const body = JSON.stringify({ text: dispatchText(route, owner, repo, issueNumber) });

  // Same retry policy as the workflow's curl (--retry 3 on any 5xx or
  // network error). A retried fire is safe: loop-dispatch re-checks the
  // entity still qualifies and no-ops if the first fire already handled it.
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(target.fireUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${target.token}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "experimental-cc-routine-2026-04-01",
          "Content-Type": "application/json",
        },
        body,
      });
      if (res.ok) return;
      lastError = `${res.status} ${await res.text()}`;
      if (res.status < 500) break; // a 4xx won't fix itself
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
  }
  throw new Error(`Routine fire failed for ${owner}/${repo} (route=${route}): ${lastError}`);
}
