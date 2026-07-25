---
name: worker-env
description: >-
  What THIS cloud worker environment provides for Umbraco MCP work — the baked demo-instance
  directories, .NET SDK, Docker/SQL Server, and how to bring Umbraco up — plus how to read it
  from the manifest the env-build writes. Consult this BEFORE any DB-backed work (running
  integration tests, chaining to a live CMS) so you use what's already installed instead of
  probing or rebuilding from scratch. Delivered from umbraco-mcp-ops alongside the loop skills.
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
- **Demo instances** — the **v17 and v18** instances and their directories (e.g.
  `/root/umbraco-seed/17`, `/root/umbraco-seed/18`).
- **Ops scripts** — `/root/umbraco-ops/run-umbraco.sh`.

If the manifest is **absent**, this env wasn't built by `env-setup.sh` — fall back to the
repo's own `CLAUDE.md` (`npm run umbraco:bootstrap` + `npm run start:umbraco`).

## 2. Choose the database

The **SQL Server daemon does not persist across sessions**, so check it live — don't assume:

```
docker info >/dev/null 2>&1 && echo "SQL Server: RUNNING" || echo "SQL Server: NOT running"
```

- **RUNNING** → use `--provider sqlserver`.
- **NOT running** (the usual fresh-session state) → use **SQLite** (`--provider sqlite`),
  fast from the baked v17/v18 instances. Only start SQL Server if you specifically need
  CI-parity.

## 3. Bring Umbraco up

From your repo checkout, one command does everything (starts Docker + SQL Server when
needed, bootstraps `demo-site/`, boots Umbraco, creates the API user, writes `.env`):

```
bash /root/umbraco-ops/run-umbraco.sh --provider <sqlite|sqlserver>
```

- **sqlite** — add `--seed <major>` to restore a baked instance in seconds (if the manifest
  lists one for your version); otherwise it bootstraps fresh (~1–2 min first boot).
- **sqlserver** — CI-parity; brings up the cached `mssql:2022` container and a fresh DB.

Then run the change's tests: **`npm run test:changed`** (only the tests touching your diff),
or `npm test` for the full suite. CI still runs the whole suite on the PR.

## Guardrails

- **Match the provider to the env** — use the provider the manifest reports; don't try to
  run SQL Server in a sqlite env (no image) or vice-versa.
- **Don't reinstall what's listed** — the SDK, image, and seeds are already cached; use them.
- **The daemon is per-session** — if `docker ps` fails, that's expected; `run-umbraco.sh`
  starts it. Don't conclude Docker is broken.
