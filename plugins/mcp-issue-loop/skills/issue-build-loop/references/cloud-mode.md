# Cloud mode

Everything in `SKILL.md` (Config → Rules) is **local mode**. **Cloud mode** is set explicitly by
the caller — the routine prompt says *run in cloud mode*. The session is a **thin
orchestrator on a cheap base model**: it triages the one issue and dispatches a **single**
build subagent on the best-fit model — the same *Model selection* logic as local, just one
subagent instead of up to three.

**This doc covers MCP-repo cloud mode** — the SQL-Server-boot dance below is what cloud
mode has to add over local specifically because the MCP playbook needs a real Umbraco to
test against. **For a content-repo issue in cloud mode**, there's no toolchain to boot, so
there's nothing extra to add over local mode: resolve the repo's shape as in `SKILL.md` →
*Config*, triage + dispatch a single build subagent per step 1 below on
[`content-playbook.md`](content-playbook.md) instead of `mcp-playbook.md`, working
directly in the session's checkout (content repos have no worktree hooks to lose either
way), then drive CI green and run `mcp-review` per steps 3–5 below — those steps are
shape-agnostic.

**Know the environment first.** Before triaging, consult the **[`worker-env`](../../../../loop-dispatch/skills/worker-env/SKILL.md)** skill
(`cat /root/env-manifest.md`) — it tells you what this cloud worker provides (.NET SDK,
whether SQL Server is available, the ops `run-umbraco.sh`). Cloud sessions **do** get a
local Umbraco now: the build subagent boots one and runs a real local test gate (below) —
this is no longer a compile-only, CI-is-the-only-gate flow. Run these sessions in a **SQL
Server** worker-env so the local run is **CI-parity** — the subagent tests on the same
provider CI uses, greens the suite locally, and skips the slow push → CI-fail → fix →
re-push loop. (SQLite is a degraded fallback only; see step 2.)

For the one triggering issue (identify it from the event; if unclear, take the **oldest**
open `ready-for-ai` issue; none → quiet no-op):

1. **Triage + dispatch.** Read the issue, pick its tier from
   [Model selection](../SKILL.md#model-selection), and spawn **one** build subagent on
   that model (Agent/Task tool with the chosen `model`). The base session stays on a cheap model — it
   only triages, dispatches, and reports. *If the routine environment can't spawn a
   subagent with a model override, do the build **inline** on the routine's own model
   instead (set that to a sensible default, e.g. `sonnet`) and note it.*
2. **Build (in the subagent).** Work **directly in the session's checkout** — no
   `EnterWorktree` (cloud sessions are already isolated, and the worktree hooks need the
   local DB/toolchain). Implement the issue following the **shared build playbook**
   ([`mcp-playbook.md`](mcp-playbook.md)) and the MCP skills,
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
     `mcp-playbook.md` for the criteria). If the repo doesn't have `test:changed` yet,
     fall back to `npm run test:one -- --testPathPattern='<collection>/__tests__/<tool>'`
     for each area you touched.

     Fix locally until green **before** pushing. Because the local run is SQL Server
     (CI-parity), a green local gate means CI passes first time — much quicker than pushing
     and looping on remote CI failures (the 8-attempt cap). Any `tests/evals/*.test.ts`
     failures here are expected in this environment — see the known
     `ANTHROPIC_API_KEY`-missing signature in `mcp-playbook.md` step 4.
   - **The build subagent does NOT review its own code, and does NOT drive CI.** Don't
     run `/security-review`/`/code-review` here — see `SKILL.md`'s Rules for why. Once
     local tests are green, **commit, push,
     and open the PR** against `<base>` (github-ops → *Create a PR*), linking the issue
     (`Closes #N`), ready for review, not draft — then **return**. Driving that PR's CI
     green (step 3) and reviewing it with `mcp-review` (step 4) are the **base session's**
     job, not yours — you do not poll CI or wait for review.
3. **Drive CI green — from the base session, not the subagent.** Same procedure as
   `SKILL.md` Step 3 (poll checks, 8-attempt cap, re-dispatch into the same checkout on a
   failing check, no-progress guard — including `SKILL.md` Step 3's known
   `ANTHROPIC_API_KEY`-missing eval signature, expected on every cloud run since this
   environment never has the key). Since you tested on SQL Server (CI-parity), CI
   should pass first time — this is usually just a confirmation, not a fix loop; a
   surprise failure usually means the local run was on SQLite or the diff wasn't fully
   covered by `test:changed`.
4. **Review the PR with `mcp-review` — from the base session, not the subagent.** Same
   mechanics and rationale as `SKILL.md` Step 3's mcp-review paragraph. Fix any surviving
   findings by **dispatching a fix on the build subagent's model** (or fix inline) — the
   base session itself stays on its cheap model, so a fix re-dispatch must not silently
   inherit that tier. The local re-test gate to re-run before re-pushing a fix is the same
   SQL Server gate from step 2.
5. **Mark the issue complete, then stop at the CI-green PR.** Same outcome-label swap and
   hand-off as `SKILL.md` Step 3/Step 4. Removing `ready-for-ai` is what stops this
   routine re-firing on the same issue.

**Not used in cloud mode:** the cap-3 queue, worktrees, and the review-response phase. The
same guardrails in `SKILL.md`'s Rules still apply — plus Step 3's: never leave CI red,
and a blocked issue (cap or no-progress guard tripped) gets labelled `ai-blocked` +
a comment, then stop.
