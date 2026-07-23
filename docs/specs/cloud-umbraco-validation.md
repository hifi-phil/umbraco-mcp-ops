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
3. **Prime the NuGet cache** — the big speed win. Cold Umbraco restore is **~1.5 GB / 170+
   packages**; priming it here makes per-session restore a cache hit (and lets the session
   run offline). For **each supported major**:
   - clone the target repo at that version's branch into a temp dir,
   - `npm run umbraco:bootstrap -- --sqlite`,
   - `dotnet restore` (and `dotnet build`) the demo-site,
   - discard the checkout — keep only the warmed `~/.nuget/packages`.
   `~/.nuget/packages` stores every version **side by side**, so one primed cache serves v17
   **and** v18 — no version-keying needed (unlike a DB seed).
   *(Lighter alternative if cloning the target repo at build is undesirable: scaffold a
   throwaway vanilla project per version — `dotnet new install Umbraco.Templates@<v>` +
   `dotnet new umbraco` — which pulls essentially the same package tree. Bootstrapping the
   real demo-site guarantees a complete cache; the vanilla scaffold gets ~95% and lets the
   session fetch any stragglers, which needs session-time egress.)*
4. **Idempotence** — skip re-installing the SDK / re-priming if already present, so a
   rebuild is cheap. Log a one-line `env-setup vN` marker.

Snapshot ends up holding: `$HOME/.dotnet`, `~/.nuget/packages`, `~/.claude/{skills,agents,ops-hooks}`, `settings.json`.

## Per-session flow (cloud mode, build + rework only)

After the change is implemented and the fast checks (`npm run compile` / `build`) pass:

1. `npm run umbraco:bootstrap -- --sqlite` — fast (file copy; DB config points at SQLite, no
   SQL Server / service container).
2. Start Umbraco in the background:
   `ASPNETCORE_ENVIRONMENT=Development dotnet run --no-launch-profile --urls http://localhost:<port>`
   — restore is a **cache hit**.
3. **Wait for startup** by grepping `"Now listening on"` in the run log (bounded, ~180s);
   bail on `Unhandled exception` / `Failed to bind` / process death — never a blind sleep.
4. `node scripts/create-api-user.mjs <baseUrl> admin@admin.com 1234567890` +
   `node scripts/publish-root-content.mjs <baseUrl>`.
5. **Run only the change's test(s)**:
   `npm run test:one -- --testPathPattern='<collection>/__tests__/<tool-or-area>'`.
   Never `test:all` in a session.
6. **Report honestly** — state exactly which test(s) ran and their result. CI owns the full
   suite; do not claim coverage the session didn't run. (Same honesty rule as the review fix.)

The one remaining per-session cost is Umbraco's **first-boot unattended install** (creates
the SQLite DB), ~1–2 min. Acceptable for v1.

## Versioning (multi-version support)

- Editor MCP: `main`/`dev` track **v18**; `v17/*` LTS branches track **v17**. The
  `Umbraco.Cms` version is pinned in the demo-site csproj per branch.
- The **.NET channel** and **`Umbraco.Templates` version** are version-specific — resolve per
  release from `docs.umbraco.com/umbraco-cms/<version>.latest`, don't guess (Umbraco's
  supported .NET tracks the CMS release).
- Because the NuGet cache is version-side-by-side, the only version-aware work is **which
  majors to prime** at env-build (start with v17 + v18).

## Deferred

- **Per-version SQLite DB seed** — bake a booted-once `umbraco/Data` DB per major into the
  snapshot and copy it into place at session start, removing the ~1–2 min first-boot install.
  Only pursue if that cost proves annoying. (This *is* version-keyed, unlike the NuGet cache.)

## Egress

- **Env-build only:** `github.com` (clone), NuGet feed (`api.nuget.org`), .NET install CDN
  (`builds.dotnet.microsoft.com` / the raw-github script host). The current loop env is
  restricted; either run env-build on an env with these allowed, or add them to the
  allow-list.
- **Session:** runs against baked SDK + warm cache → no network needed for the toolchain
  (GitHub work still goes through github-ops as today).

## Open questions

1. Which Umbraco majors to prime at env-build — confirm **v17 + v18** (and whether Dev MCP
   adds others).
2. Env for env-build: make the build-loop env unrestricted, or enumerate + add the
   allow-listed hosts above?
3. `test:one` selection heuristic — how the build subagent maps a change to its test file(s)
   (e.g. the tool it touched → its `__tests__/<tool>.test.ts`; a shared helper → the
   collection's suite). Worth a short rule in the skill.
4. Do we prime from the **real demo-site** (clone target repo) or a **vanilla scaffold**?
   (§`env-setup.sh` step 3.)

## Rollout

1. Land `env-setup.sh` (stub + repo script) with the SDK + NuGet-prime steps; paste the stub
   once; validate a session can start SQLite Umbraco fast and run one test.
2. Add the per-session flow to `mcp-issue-loop` + `rework-loop` cloud mode (gated to those
   two skills).
3. Measure first-boot cost; decide on the deferred DB seed.
4. Extend to Dev MCP.
