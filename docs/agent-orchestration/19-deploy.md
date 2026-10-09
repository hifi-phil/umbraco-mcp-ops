# 19. Deploying from a release

[← Index](00-index.md)

---

**Status:** Built, not yet switched on (needs the setup below). **Date:** 09-10-2026

A published release deploys itself: `release-tag.yml` tags and releases, then
calls `deploy.yml`, which builds the Worker and the e2e stub from the tag,
runs `tofu plan` and `apply`, runs the e2e suite, and posts the result on the
`release X.Y.Z` issue. Nobody runs `tofu apply` by hand any more.

---

## How it works

| Piece | What it is |
|---|---|
| **State** | `terraform.tfstate` in a **private** repo (`hifi-phil/umbraco-mcp-ops-state`; `STATE_REPO` repo variable overrides). Encrypted with OpenTofu state encryption (AES-GCM, a PBKDF2 key from a passphrase), so even the private repo holds no readable secret. |
| **Access to it** | A deploy key: write access to that one repo, nothing else. |
| **Lock** | The workflow's `concurrency` group: one deploy at a time, queued, never cancelled mid-apply. Don't run `tofu apply` locally while one is running. |
| **After a failed apply** | The state is committed anyway (it records what *was* changed). Fix forward with a new release, or re-run the workflow by hand for the tag (`workflow_dispatch`, with or without e2e). |
| **Logs** | This repo's Actions logs are public, so the workflow prints only each resource's planned action and any error block, never the plan's values. |
| **Approval (optional)** | Give the `orchestrator-prod` environment a required reviewer and every deploy waits for one click. |

No R2 or other bucket: the state repo needs no payment method. To move to a
bucket later: add the backend, `tofu init -migrate-state`, same encryption.

## Setup, once (a person does this)

1. **Sign-off from the Cloudflare account's owner.** The account is shared
   production: an automated deploy into it needs their OK first.
2. **The state repo.** Create the private repo, empty. Generate a key pair
   (`ssh-keygen -t ed25519 -N "" -f state-deploy`), add `state-deploy.pub`
   to it as a deploy key **with write access**, keep the private half for 4.
3. **The `orchestrator-prod` environment** in umbraco-mcp-ops (Settings →
   Environments). Optionally a required reviewer. If you limit which refs can
   deploy, allow the branch `main`: the job runs on `main` (the release's push,
   or the branch a manual run is started from), not on the tag, so a tag-only
   rule blocks every deploy.
4. **Its secrets:**

   | Secret | Value |
   |---|---|
   | `STATE_DEPLOY_KEY` | the private key from 2 |
   | `TOFU_STATE_PASSPHRASE` | `openssl rand -base64 32`. **Keep a copy outside GitHub** (a password manager): without it the state can't be read. |
   | `TFVARS` | the whole `worker/terraform/terraform.tfvars`: `gh secret set TFVARS --env orchestrator-prod < worker/terraform/terraform.tfvars` |
   | `CLOUDFLARE_API_TOKEN` | a token limited to this account: Workers Scripts edit, D1 edit, and whatever else today's local token has that the plan needs (start from the same scopes) |
   | `E2E_GITHUB_TOKEN` | a fine-grained token on the sandbox only (`mcp-ops-e2e-testing`): Contents, Issues, Pull requests and Webhooks, read and write. Used by tofu's github provider and by the e2e driver |

5. **Move today's state in** (from the checkout that has it, with the same
   passphrase exported as `TOFU_STATE_PASSPHRASE`):

   ```sh
   git clone git@github.com:hifi-phil/umbraco-mcp-ops-state.git ~/ops-state
   cp ~/.local/state/umbraco-mcp-ops/agent-orchestration-worker.tfstate ~/ops-state/terraform.tfstate
   cd worker/terraform
   tofu init -reconfigure -backend-config="path=$HOME/ops-state/terraform.tfstate"
   TF_ENCRYPTION="$(../../scripts/deploy/tofu-encryption.sh --migrate)" tofu apply   # expect no changes; it rewrites the state encrypted
   head -c 60 ~/ops-state/terraform.tfstate   # must show "encrypted_data", not "resources"
   cd ~/ops-state && git add terraform.tfstate && git commit -m "initial state (encrypted)" && git push
   ```

   Then move the old plain file somewhere safe (it holds every secret in
   plain text) and delete it once a deploy has worked.

## Changing a setting

A tfvars value (a routine URL, a watchdog override, `deployed_do_migration_tag`
after a DO migration) is now a secret: edit the local file, re-run the
`gh secret set TFVARS …` line, and it applies with the next release, or
straight away with a `workflow_dispatch` run for the current tag.

To run tofu by hand (to look, or in an emergency), use the state repo's
checkout and the encryption config, and don't overlap a running deploy:

```sh
export TF_ENCRYPTION="$(scripts/deploy/tofu-encryption.sh)"   # with TOFU_STATE_PASSPHRASE set
tofu -chdir=worker/terraform init -reconfigure -backend-config="path=$HOME/ops-state/terraform.tfstate"
git -C ~/ops-state pull   # before; commit and push after any apply
```

---

[← Index](00-index.md)
