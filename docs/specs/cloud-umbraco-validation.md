# Spec — Cloud Umbraco validation for the build loops

**Status:** draft · **Scope:** `mcp-issue-loop` + `rework-loop` (cloud mode) · **Repos:** ops (env + skills), Editor MCP first, Dev MCP later

## Goal

Run a real, **SQLite** Umbraco instance inside the cloud build sessions so each change can
**validate its own test(s)** before the PR reaches CI. CI still runs the full suite — this
is a fast pre-flight, not a replacement. It closes the gap that let a cloud-built PR ship
with **unrun** checks (Dev #308): a build can no longer *claim* a test passed without a real
Umbraco to run it against.

Non-goals: replacing CI; running the full `test:all` in a session; touching the loops that
don't build code.

## Scope

- **Only** `mcp-issue-loop` and `rework-loop`. `merge-flow` / `auto-release-loop` /
  `loop-dispatch` never start Umbraco.
- **Editor MCP first** — it already has the `--sqlite` bootstrap path. Dev MCP follows once
  the pattern is proven.

## Architecture: thin stub → repo-hosted `env-setup.sh`

Today the whole `cloud-skill-sync.sh` is pasted into the env's **Setup script** field, and a
`VERSION` bump + re-paste is how you force a rebuild. That gets unwieldy as the script grows
(now it also installs the .NET SDK and primes NuGet). Invert it:

**Env Setup field = a tiny stub** (paste once):

```bash
set -e
# rebuild: 1          # bump this number to force an env-cache rebuild
git clone --depth 1 https://github.com/<owner>/umbraco-mcp-ops /tmp/ops-boot
bash /tmp/ops-boot/scripts/cloud-skill-sync/env-setup.sh
```

- All heavy logic lives in the repo (`env-setup.sh`), edited via PRs — no more pasting a
  large script.
- **The cache-bust lever moves into the stub.** The env snapshot is cached (~7 days) and only
  busts when the **Setup-field text** changes. A stub that always pulls `main` will *not*
  rebuild when the repo script changes — so bump `# rebuild: N` to force it. Everything else
  is a PR.
- **Egress:** the stub uses `git clone` from `github.com` (the host today's clone already
  reaches), **not** `curl` from `raw.githubusercontent.com` (a different host that may not be
  allow-listed).
- The `VERSION=` var inside `env-setup.sh` stops being the cache-bust; keep it only as a log
  marker (`env-setup v13` in the log) so you can confirm which build ran.

## `env-setup.sh` (runs at env-build; needs egress once)

Folds today's `cloud-skill-sync` delivery together with the new toolchain steps. Everything
it writes under `$HOME` is captured in the snapshot; the session's repo checkout is **not**
(it's fresh per session), so anything the session needs must land in `$HOME`.

1. **Skills / agents / hooks** — the existing `cloud-skill-sync` logic (copy listed skills to
   `~/.claude/skills`, agents to `~/.claude/agents`, deliver + register the capture hooks in
   `settings.json`). Unchanged.
2. **.NET SDK** — install via `dotnet-install.sh`, fetched from
   `https://raw.githubusercontent.com/dotnet/install-scripts/main/src/dotnet-install.sh`
   (**not** `dot.net/v1/...` — it 301-redirects and `curl` without `-L` silently writes an
   empty file). Install to `$HOME/.dotnet`; export `DOTNET_ROOT` + PATH and persist to
   `.bashrc`. Channel(s) resolved per supported Umbraco version (see *Versioning*).
3. **Build a ready-to-run demo-site seed per version (v17 + v18)** — the big win. The
   demo-site's starting point never changes between sessions (the code under test is the
   TypeScript MCP server, not this Umbraco host), so bake the **fully prepared instance**
   once per major and copy it in per session. For **each of v17 and v18**:
   - clone the target repo at that version's branch (Editor: `v17/*` for 17, `dev` for 18),
   - `npm run umbraco:bootstrap -- --sqlite`,
   - `dotnet restore` + `dotnet build` (warms `~/.nuget/packages` — ~1.5 GB / 170+ packages
     cold; stored version-side-by-side so both majors share the cache),
   - `dotnet run` once to complete the **unattended install** (creates the SQLite DB),
   - `create-api-user.mjs` + `publish-root-content.mjs`, then stop,
   - snapshot the prepared instance to `$HOME/umbraco-seed/<major>/` — the built output +
     `umbraco/Data/*.sqlite.db` + any generated starter-kit files, i.e. everything a session
     needs to `dotnet run` immediately with the API user + root content already present.
   *Implementation note:* nail down exactly what the seed must contain (SQLite DB is
   essential; verify whether the built `bin/` and generated `Views`/`wwwroot` must be
   included or are regenerated cheaply on boot). The seed **is** version-keyed (per major) —
   that's fine and bounded (17, 18); the NuGet cache is not.
4. **Idempotence** — skip re-installing the SDK / re-priming / re-seeding if already present,
   so a rebuild is cheap. Log a one-line `env-setup vN` marker.

Snapshot ends up holding: `$HOME/.dotnet`, `~/.nuget/packages`, `$HOME/umbraco-seed/{17,18}/`,
`~/.claude/{skills,agents,ops-hooks}`, `settings.json`.

> Rebuild the env (bump `# rebuild: N` in the stub) whenever the demo-site-template or its
> pinned `Umbraco.Cms` version changes — that's what makes the baked seed go stale.

## Per-session flow (cloud mode, build + rework only)

After the change is implemented and the fast checks (`npm run compile` / `build`) pass:

1. **Copy the baked seed into place**: `cp -r $HOME/umbraco-seed/<major>/ ./demo-site` (major
   chosen from the branch's pinned `Umbraco.Cms`). No `bootstrap`, no unattended install, no
   `create-api-user` — the seed already has the DB, API user, and published root content.
2. Start Umbraco in the background:
   `ASPNETCORE_ENVIRONMENT=Development dotnet run --no-launch-profile --urls http://localhost:<port>`
   — restore is a cache hit and the DB already exists, so this is a **normal boot** (seconds),
   not a first-boot install.
3. **Wait for startup** by grepping `"Now listening on"` in the run log (bounded, ~180s);
   bail on `Unhandled exception` / `Failed to bind` / process death — never a blind sleep.
4. **Run only the change's test(s)** via a deterministic helper — `npm run test:changed`,
   which runs `jest --findRelatedTests` over the files changed vs the PR base, so **Jest**
   selects the tests that import the change (no `--testPathPattern` for the model to
   construct). `test:one -- --testPathPattern='…'` stays as the manual fallback. Never
   `test:all` in a session; CI owns the full suite.
5. **Report honestly** — state exactly which test(s) ran and their result; never claim
   coverage the session didn't run (same honesty rule as the review fix).

Because the seed is baked, a session goes from "code compiled" to "test running" in
**seconds** — no bootstrap, no ~1–2 min unattended install, no API-user setup.

## Versioning (multi-version support)

- Editor MCP: `main`/`dev` track **v18**; `v17/*` LTS branches track **v17**. The
  `Umbraco.Cms` version is pinned in the demo-site csproj per branch.
- The **.NET channel** and **`Umbraco.Templates` version** are version-specific — resolve per
  release from `docs.umbraco.com/umbraco-cms/<version>.latest`, don't guess (Umbraco's
  supported .NET tracks the CMS release).
- Because the NuGet cache is version-side-by-side, the only version-aware work is **which
  majors to prime** at env-build (start with v17 + v18).

## Deferred

- Nothing structural — the per-version baked seed (moved into the core design above) already
  removes the first-boot install. Possible later polish: trimming what the seed contains, or
  a periodic auto-rebuild when the demo-site-template changes.

## Egress

- **Env-build:** make the build-loop env **unrestricted for now** (decision) — env-build
  needs `github.com` (clone), the NuGet feed, and the .NET install CDN, and enumerating every
  host a restore touches is fiddly. Tighten to an allow-list later if we want.
- **Session:** runs against the baked SDK + warm cache + seeded demo-site → no network needed
  for the toolchain (GitHub work still goes through github-ops as today).

## Resolved decisions

1. **Majors to prime:** v17 + v18 (Dev MCP revisited when it's added).
2. **Env-build egress:** unrestricted for now.
3. **Test selection:** add a `test:changed` helper (`jest --findRelatedTests` over the PR
   diff) so the loop runs **one deterministic command** — Jest picks the tests importing the
   change, nothing for the model to construct. `test:one -- --testPathPattern` remains the
   manual fallback.
4. **Prime source:** the **real demo-site** (clone the target repo per version), **including
   the seeded SQLite DB** — the starting point never changes, so caching it makes sessions
   very quick.

## Implementation note to resolve during build

- Exactly what `$HOME/umbraco-seed/<major>/` must contain for an instant boot — SQLite DB is
  essential; confirm whether built `bin/` + generated `Views`/`wwwroot` need to be in the seed
  or are regenerated cheaply. (§`env-setup.sh` step 3.)
- The `test:changed` helper (new npm script in the target repo): resolve the PR base for the
  diff, and handle the edge cases — a **shared file** selecting a large test set (cap or
  accept), and a change that only touches a `*.test.ts` (run it directly as well as via
  `--findRelatedTests`).

## Rollout

1. Land `env-setup.sh` (stub + repo script) with the SDK + NuGet-prime steps; paste the stub
   once; validate a session can start SQLite Umbraco fast and run one test.
2. Add the per-session flow to `mcp-issue-loop` + `rework-loop` cloud mode (gated to those
   two skills).
3. Measure first-boot cost; decide on the deferred DB seed.
4. Extend to Dev MCP.
