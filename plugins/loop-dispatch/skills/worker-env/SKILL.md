---
name: worker-env
description: >-
  What THIS cloud worker environment provides for Umbraco MCP work — the .NET SDK, whether
  SQL Server is available, and how to bring a fresh Umbraco instance up per session — plus
  how to read it from the manifest the env-build writes. Consult this BEFORE any DB-backed
  work (running integration tests, chaining to a live CMS) so you use what's already
  installed instead of probing or reinstalling.
---

# worker-env

## 1. Read the manifest first

```
cat /root/env-manifest.md
```

`env-setup.sh` writes it on every env build (initial **and** cached rebuild), so it's the
authoritative record of this worker. It lists:

- **Provider** — `sqlite` (server-less, file-based) or `sqlserver` (CI-parity via Docker).
- **.NET SDK** — version, on `PATH` via `/usr/local/bin`.
- **SQL Server image** — whether the `mssql:2022` image is cached.
- **Ops scripts** — `/root/.umbraco-ops/run-umbraco.sh`.

There is **no pre-baked Umbraco instance** — you bring one up per session with
`run-umbraco.sh` (bootstrap + boot, ~1–2 min). If the manifest is **absent**, this env
wasn't built by `env-setup.sh` — fall back to the repo's own `CLAUDE.md`
(`npm run umbraco:bootstrap` + `npm run start:umbraco`).

## 2. Choose the database

**Prefer SQL Server for any test run** — it's the provider CI uses, so its results are
trustworthy. **SQLite is a last resort**, not an equivalent target: a different provider
that throws provider-specific false failures *and* false passes. Use SQLite only when no
mssql image is cached, or for a quick smoke of a single focused change where speed matters —
and treat its results as non-authoritative (confirm on SQL Server / CI).

If the manifest shows the `mssql:2022` image is cached, SQL Server is *available* here even
if it's not running — the daemon does not persist across sessions, so it's usually stopped
at session start; "stopped" means *startable*, not unavailable. Check live:

```
docker info >/dev/null 2>&1 && echo RUNNING || echo "AVAILABLE (not started)"
```

- **RUNNING** → `--provider sqlserver`.
- **AVAILABLE (not started)** — usual fresh session → **start it**: `run-umbraco.sh
  --provider sqlserver` brings it up from the cached image. This is the default for testing.
- **No image cached** (a sqlite-only env) → `--provider sqlite`, and treat CI as the real
  test gate — SQLite is not CI-parity.

## 3. Bring Umbraco up

There's no auto-boot — start it yourself, ideally as your first action so it boots while you
read the issue / check out / make the change. Default to **SQL Server** (§2); drop to
`--provider sqlite` only as the last resort described there:

```
bash /root/.umbraco-ops/run-umbraco.sh --provider sqlserver >/tmp/run-umbraco-wrapper.log 2>&1 &
RUN_PID=$!
```
**Give the wrapper its own log path, distinct from `/tmp/umbraco-run.log`** — the script
redirects `npm run start:umbraco`'s output to that exact path internally, so reusing it for
the outer invocation truncates it out from under the running process and corrupts both.

It bootstraps `demo-site/`, boots Umbraco in the background, creates the API user, and writes
`.env`. First boot runs the unattended install (~1–2 min). The script already polls for
readiness internally and exits non-zero on failure — don't re-implement that wait (repeated
attempts have each hit a different bug: a hand-typed loop drifting from the script's own
timeout, grepping a log that races with a truncating redirect inside the script, an
unbounded/mistimed poll). Just wait on the process itself and trust its exit status:
```
wait "$RUN_PID" || { echo "Umbraco did not become ready — tail /tmp/umbraco-run.log (script's own boot log) or /tmp/run-umbraco-wrapper.log (this wrapper's output)"; exit 1; }
```

Then run the change's tests:

- **`npm run test:changed`** — only the integration tests touching your diff (preferred). If
  the repo doesn't have that script yet, fall back to
  **`npm run test:one -- --testPathPattern='<collection>/__tests__/<tool>'`** for each area
  you changed.
- **`npm run test:all`** — the full suite; use only for a broad / cross-cutting change.

CI still runs the whole suite on the PR, so `test:changed` is the normal local gate.
