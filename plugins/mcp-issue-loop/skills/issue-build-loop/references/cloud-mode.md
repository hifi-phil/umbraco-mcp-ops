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
way), then review and hand off per step 3 below — that step is shape-agnostic.

**Know the environment first.** Before triaging, consult the **`worker-env`** skill
(`cat /root/env-manifest.md`) — it tells you what this cloud worker provides (.NET SDK,
whether SQL Server is available, the ops `run-umbraco.sh`). Cloud sessions **do** get a
local Umbraco now: the build subagent boots one and runs a real local test gate (below) —
this is no longer a compile-only, CI-is-the-only-gate flow. Run these sessions in a **SQL
Server** worker-env so the local run is **CI-parity** — the subagent tests on the same
provider CI uses, greens the suite locally, and skips the slow push → CI-fail → fix →
re-push loop. (SQLite is a degraded fallback only; see step 2.)

For the one triggering issue (identify it from the event; if unclear, take the **oldest**
open `ai-ready` issue; none → quiet no-op):

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
     a local Umbraco via the **`worker-env`**
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
     (CI-parity), a green local gate means CI passes first time — much quicker than a
     red CI going round `rework-loop`. Don't run eval suites as part
     of this gate (`mcp-playbook.md` step 4) — CI's own gated `evals` job covers those.
   - **The build subagent does NOT review its own code, and does NOT drive CI.** Don't
     run `/security-review`/`/code-review` here — see `SKILL.md`'s Rules for why. Once
     local tests are green, **commit, push, and open the PR** against `<base>` (github-ops →
     *Create a PR*), linking the issue (`Closes #N`), ready for review, not draft — then
     **return**. Reviewing it (step 3) is the **base session's** job.
3. **Review the PR with `mcp-review`, then hand it to `ai-reviewing` — from the base
   session.** As `SKILL.md` Step 3: fix any surviving findings by **dispatching a fix on the
   build subagent's model** (or fix inline; the base session stays on its cheap model, so a
   fix must not silently inherit that tier), re-run the SQL Server gate from step 2, push,
   then add `ai-reviewing` and mark the outcome. Removing `ai-ready` (by you, or by the
   orchestrator in orchestrated mode) is what stops this routine re-firing on the issue.
   Then stop: no CI polling.

**Not used in cloud mode:** the cap-3 queue, worktrees, and the review-response phase. The
same guardrails in `SKILL.md`'s Rules still apply — plus Step 3's: a blocked issue
(no-progress guard tripped) gets a comment (and `ai-blocked`, unorchestrated), then stop.
