#!/usr/bin/env bash
# Called by main.tf's terraform_data.d1_migrations. Applies ../migrations/
# to the D1 database tofu just created, via wrangler (which tracks applied
# migrations in its own d1_migrations table, so re-runs are safe).
# wrangler.toml deliberately keeps a placeholder database_id, so this
# writes a throwaway config pointing at the real one instead.
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?must be set}" "${CLOUDFLARE_ACCOUNT_ID:?}" "${DB_NAME:?}" "${DB_ID:?}" "${MIGRATIONS_DIR:?}"

worker_dir="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cat >"$tmp/wrangler.json" <<EOF
{
  "name": "d1-migrations-only",
  "d1_databases": [
    { "binding": "DB", "database_name": "$DB_NAME", "database_id": "$DB_ID", "migrations_dir": "$MIGRATIONS_DIR" }
  ]
}
EOF

# CI=true: wrangler skips its interactive "Ok to proceed?" prompt.
cd "$worker_dir"
CI=true npx wrangler d1 migrations apply "$DB_NAME" --remote -c "$tmp/wrangler.json"
