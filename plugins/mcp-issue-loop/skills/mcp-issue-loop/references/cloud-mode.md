# Cloud mode

Everything in `SKILL.md` (Config → Rules) is **local mode**. **Cloud mode** is set explicitly by
the caller — the routine prompt says *run in cloud mode*. It's **event-triggered, one
session per `ready-for-ai` issue**, so there's **no cap-3 queue and no worktrees** —
cross-issue parallelism comes from separate sessions firing. The session is a **thin
orchestrator on a cheap base model**: it triages the one issue and dispatches a **single**
build subagent on the best-fit model — the same *Model selection* logic as local, just one
subagent instead of up to three.

**Know the environment first.** Before triaging, consult the **[`worker-env`](../../../../loop-dispatch/skills/worker-env/SKILL.md)** skill
(`cat /root/env-manifest.md`) — it tells you what this cloud worker provides (.NET SDK,
whether SQL Server is available, the ops `run-umbraco.sh`). Cloud sessions **do** get a
local Umbraco now: the build subagent boots one and runs a real local test gate (below) —
this is no longer a compile-only, CI-is-the-only-gate flow. Run these sessions in a **SQL
Server** worker-env so the local run is **CI-parity** — the subagent tests on the same
provider CI uses, greens the suite locally, and skips the slow push → CI-fail → fix →
re-push loop. (SQLite is a degraded fallback only — a different provider that throws
false failures and false passes; see step 2.)

For the one triggering issue (identify it from the event; if unclear, take the **oldest**
open `ready-for-ai` issue; none → quiet no-op):

1. **Triage + dispatch.** Read the issue, pick its tier from
   [Model selection](../SKILL.md#model-selection) (`opus` / `sonnet` / `haiku`; never `fable`; floor
   `sonnet` for code-touching work), and spawn **one** build subagent on that model
   (Agent/Task tool with the chosen `model`). The base session stays on a cheap model — it
   only triages, dispatches, and reports. *If the routine environment can't spawn a
   subagent with a model override, do the build **inline** on the routine's own model
   instead (set that to a sensible default, e.g. `sonnet`) and note it.*
2. **Build (in the subagent).** Work **directly in the session's checkout** — no
   `EnterWorktree` (cloud sessions are already isolated, and the worktree hooks need the
   local DB/toolchain). Implement the issue following the **shared build playbook**
   ([`issue-lifecycle.md`](issue-lifecycle.md)) and the MCP skills,
   with two substitutions for playbook steps 1 and 4:
   - **Instead of the worktree (playbook step 1):** work directly in the session checkout.
   - **Instead of `npm run start:umbraco` + `npm run test:all` (playbook step 4):** bring up
     a local Umbraco via the **[`worker-env`](../../../../loop-dispatch/skills/worker-env/SKILL.md)**
     skill and run a local test gate **on SQL Server**. As your **first action** (so Umbraco
     boots while you implement — first boot runs the unattended install, ~1–2 min):
     ```
     bash /root/.umbraco-ops/run-umbraco.sh --provider sqlserver >/tmp/umbraco-run.log 2>&1 &
     ```
     **Default to SQL Server** — it's the provider CI uses, so the results are trustworthy.
     **SQLite is a last resort**, not an equivalent: it's a different provider and produces
     provider-specific false failures *and* false passes. Use `--provider sqlite` only when
     `worker-env` reports no mssql image (a sqlite-only env), or for a quick smoke of a single
     focused change where speed matters — and in either case its results aren't authoritative:
     confirm anything surprising on SQL Server, and treat CI as the real gate. Implement, then **wait for Umbraco
     ready** (`.demo-site-port` exists and `/umbraco/management/api/v1/server/status` returns
     200) and run
     the same gate as playbook step 4 (`npm run test:changed` vs. `test:all` — see
     `issue-lifecycle.md` for the criteria). If the repo doesn't have `test:changed` yet,
     fall back to `npm run test:one -- --testPathPattern='<collection>/__tests__/<tool>'`
     for each area you touched.

     Fix locally until green **before** pushing. Because the local run is SQL Server
     (CI-parity), a green local gate means CI passes first time — much quicker than pushing
     and looping on remote CI failures (the 8-attempt cap).
   - **The build subagent does NOT review its own code, and does NOT drive CI.** No
     `/security-review` / `/code-review` here — those slash commands can't run in a
     subagent anyway, and self-review is weak. Once local tests are green, **commit, push,
     and open the PR** against `<base>` (github-ops → *Create a PR*), linking the issue
     (`Closes #N`), ready for review, not draft — then **return**. Driving that PR's CI
     green (step 3) and reviewing it with `mcp-review` (step 4) are the **base session's**
     job, not yours — you do not poll CI or wait for review.
3. **Drive CI green — from the base session, not the subagent.** Once the build subagent
   returns an open PR, poll its check-run status (github-ops → *Get PR CI / check-run
   status*) until every check passes or the **8-attempt cap** trips. Since you tested on SQL
   Server (CI-parity), CI should pass first time — this is usually just a confirmation, not a
   fix loop; a surprise CI failure usually means the local run was on SQLite or the diff
   wasn't fully covered by `test:changed`. On a failing check, read the log (github-ops →
   *Read a failing check's log*) and **re-dispatch a subagent into that same checkout** with
   the log to fix the root cause, re-test locally, re-push, and re-check. Never re-push an
   identical fix that already failed (no-progress guard).
4. **Review the PR with `mcp-review` — from the base session, not the subagent.** Once CI
   is green (step 3), the **base session** runs the
   **[`mcp-review`](../../mcp-review/SKILL.md)** skill over that PR (the faithful 5-lens code
   review + security scan). It spawns its own review subagents, so it must run here at the
   top level — that's also what makes it an *independent* reviewer rather than the author
   grading itself. Fix any surviving findings (dispatch a fix on the build subagent's model,
   or fix inline), then **re-run the local tests before pushing** (the same local SQL Server
   gate from step 2 — the review→fix cycle re-tests locally, never leaning on CI), re-green
   CI, and report per `SKILL.md`'s "Reviews are non-negotiable" rule.
5. **Mark the issue complete, then stop at the CI-green PR.** Once CI is green **and
   mcp-review is clean/addressed**,
   do the **outcome-label swap** on the triggering issue — remove `ready-for-ai`, add
   `generated-by-ai`, comment the PR link. Removing `ready-for-ai` is what stops this
   routine re-firing on the same issue. Then **stop**: do **not** enter a review phase and
   do **not** merge — review-response is [`rework-loop`](../../rework-loop/SKILL.md)'s job (it
   fires on the PR-review event), and merging is `merge-flow`'s.

**Not used in cloud mode:** the cap-3 queue, worktrees, and the review-response phase. The
same guardrails still hold — `ready-for-ai` is the only gate, reviews are non-negotiable,
follow the repo's `CLAUDE.md`, never leave CI red, and a blocked issue gets labelled
`ai-blocked` + a comment, then stop.
