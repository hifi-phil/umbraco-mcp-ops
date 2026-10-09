#!/usr/bin/env bash
# Prints the OpenTofu state-encryption config (HCL) for TF_ENCRYPTION, from the
# passphrase in TOFU_STATE_PASSPHRASE. The deploy workflow and a person running
# tofu by hand use the same one, so both read the encrypted state:
#   export TF_ENCRYPTION="$(scripts/deploy/tofu-encryption.sh)"
# --migrate adds an unencrypted fallback, for the one-time move of today's
# plain local state (docs/agent-orchestration/19-deploy.md): it reads the plain
# state and writes it back encrypted. Never leave --migrate on afterwards.
# AES-GCM with a PBKDF2 key; the passphrase is at least 16 characters and
# mustn't contain a double quote (openssl rand -base64 32 is fine).
set -euo pipefail
: "${TOFU_STATE_PASSPHRASE:?must be set}"
case "$TOFU_STATE_PASSPHRASE" in *'"'*|*'\'*) echo "TOFU_STATE_PASSPHRASE mustn't contain \" or \\" >&2; exit 1 ;; esac
[ "${#TOFU_STATE_PASSPHRASE}" -ge 16 ] || { echo "TOFU_STATE_PASSPHRASE must be at least 16 characters" >&2; exit 1; }

if [ "${1:-}" = "--migrate" ]; then
  fallback='
  fallback { method = method.unencrypted.migrate }'
  extra='method "unencrypted" "migrate" {}'
  enforced=false
else
  fallback=''; extra=''; enforced=true
fi

cat <<HCL
key_provider "pbkdf2" "state" {
  passphrase = "$TOFU_STATE_PASSPHRASE"
}
method "aes_gcm" "state" {
  keys = key_provider.pbkdf2.state
}
$extra
state {
  method   = method.aes_gcm.state
  enforced = $enforced$fallback
}
plan {
  method   = method.aes_gcm.state
  enforced = $enforced$fallback
}
HCL
