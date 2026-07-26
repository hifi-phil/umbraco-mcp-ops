---
name: worker-env
description: >-
  What THIS cloud worker environment provides for Umbraco MCP work — the .NET SDK, whether
  SQL Server is available, and how to bring a fresh Umbraco instance up per session — plus
  how to read it from the manifest the env-build writes. Consult this BEFORE any DB-backed
  work (running integration tests, chaining to a live CMS) so you use what's already
  installed instead of probing or reinstalling. Delivered from umbraco-mcp-ops alongside the
  loop skills.
---

# worker-env

Before anything that needs a **live Umbraco** (integration tests, MCP chaining to the CMS),
find out what this environment already provides — don't probe blindly or reinstall.

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

**If the manifest shows the `mssql:2022` image is cached, SQL Server is *available* here** —
even if it's not running. The daemon does not persist across sessions, so it's usually
stopped at session start; "stopped" means *startable*, not unavailable. Check live:

```
docker info >/dev/null 2>&1 && echo RUNNING || echo "AVAILABLE (not started)"
```

- **RUNNING** → use it: `--provider sqlserver`.
- **AVAILABLE (not started)** — usual fresh session → either **start it on demand**
  (`run-umbraco.sh --provider sqlserver` brings it up from the cached image) or use
  `--provider sqlite` for a quicker start. Both valid.
- **No image cached** (a sqlite-only env) → use `--provider sqlite`.

## 3. Bring Umbraco up

From your repo checkout, one command does everything (starts Docker + SQL Server when
needed, bootstraps `demo-site/`, boots Umbraco, creates the API user, writes `.env`):

```
bash /root/.umbraco-ops/run-umbraco.sh --provider <sqlite|sqlserver>
```

- **sqlite** — bootstraps a fresh server-less instance (~1–2 min first-boot install).
- **sqlserver** — CI-parity; brings up the cached `mssql:2022` container and a fresh DB.

Then run the change's tests: **`npm run test:changed`** (only the tests touching your diff),
or `npm test` for the full suite. CI still runs the whole suite on the PR.

## Guardrails

- **Match the provider to the env** — use the provider the manifest reports; don't try to
  run SQL Server in a sqlite env (no image) or vice-versa.
- **Don't reinstall what's listed** — the SDK and mssql image are already cached; use them.
- **The daemon is per-session** — if `docker ps` fails, that's expected; `run-umbraco.sh`
  starts it. Don't conclude Docker is broken.
