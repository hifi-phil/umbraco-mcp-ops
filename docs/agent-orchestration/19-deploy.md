# 19. Deploying from a release

[← Index](00-index.md)

---

**Status:** Live. Set up and first green run (deploy and e2e) on 09-10-2026, for v2.3.2. **Date:** 09-10-2026

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
| **Approval** | None: a deploy runs as soon as the release is tagged. The guards are the release's pre-publish review, the refusal to run without state, e2e after every apply, and the result on the release issue. To gate deploys again, give the `orchestrator-prod` environment a required reviewer: each deploy then waits for one click. |
| **Secrets** | On the environment, never the repo: a repo secret is readable by any workflow on any branch, including one on an agent's PR branch. An environment secret is released only to an approved job on `main` or a `v*` tag. |

No R2 or other bucket: the state repo needs no payment method. To move to a
bucket later: add the backend, `tofu init -migrate-state`, same encryption.

## Setup, once (a person does this)

1. **The right Cloudflare account.** The orchestrator runs on its maintainer's
   own account, not a shared production one. Deploying anywhere shared needs
   that account owner's OK first.
2. **The state repo.** Create the private repo, empty. Generate a key pair
   (`ssh-keygen -t ed25519 -N "" -f state-deploy`), add `state-deploy.pub`
   to it as a deploy key **with write access**, keep the private half for 4.
3. **The `orchestrator-prod` environment** in umbraco-mcp-ops (Settings →
   Environments). A required reviewer (if the UI won't add you, the API
   will: `PUT repos/<repo>/environments/orchestrator-prod` with `reviewers`).
   If you limit which refs can deploy, allow the branch `main` as well as
   tags `v*`: the job runs on `main` (the release's push, or the branch a
   manual run is started from), not on the tag, so a tag-only rule blocks
   every deploy.
4. **Its secrets.** Every line names the environment. Without `--env` a
   secret lands on the repo, where the deploy job still reads it but so can
   everything else:

   ```sh
   R=hifi-phil/umbraco-mcp-ops
   gh secret set STATE_DEPLOY_KEY      -R $R --env orchestrator-prod < state-deploy
   gh secret set TOFU_STATE_PASSPHRASE -R $R --env orchestrator-prod      # prompts
   gh secret set TFVARS                -R $R --env orchestrator-prod < worker/terraform/terraform.tfvars
   gh secret set CLOUDFLARE_API_TOKEN  -R $R --env orchestrator-prod      # prompts
   gh secret set E2E_GITHUB_TOKEN      -R $R --env orchestrator-prod      # prompts
   gh api repos/$R/environments/orchestrator-prod/secrets -q '.secrets[].name'   # all five
   gh secret list -R $R                                                          # none of them
   ```

   | Secret | Value |
   |---|---|
   | `STATE_DEPLOY_KEY` | the **private** half from 2 (the public half is the state repo's deploy key) |
   | `TOFU_STATE_PASSPHRASE` | `openssl rand -base64 32`. **Keep a copy outside GitHub** (a password manager): secrets can't be read back, and without it the state can't be read. |
   | `TFVARS` | the whole `worker/terraform/terraform.tfvars`. Keep that file in the password manager too: the secret is write-only, and every later change starts from the file. |
   | `CLOUDFLARE_API_TOKEN` | its own token, limited to this account: Workers Scripts edit, D1 edit, and whatever else the plan needs (start from the local token's scopes). Separate from your own, so either can be revoked alone and the audit log tells them apart. |
   | `E2E_GITHUB_TOKEN` | a fine-grained token on the sandbox only (`mcp-ops-e2e-testing`): Contents, Issues, Pull requests and Webhooks, read and write; Actions, read. Tofu's github provider uses Webhooks (the stub's hook); the e2e driver reads CI through Actions, because a fine-grained token can't read check-runs on a private repo. Note its expiry date. |

5. **Move today's state in.** This is also that release's hand apply, so run
   it from a checkout **at the release tag**, with the bundles built, and with
   `CLOUDFLARE_API_TOKEN` and `GITHUB_TOKEN` exported (`gh auth token` is fine
   locally):

   ```sh
   git worktree add --detach ../deploy-vX.Y.Z vX.Y.Z && cd ../deploy-vX.Y.Z
   cp <your checkout>/worker/terraform/terraform.tfvars worker/terraform/
   npm ci && (cd worker && npm run build) && (cd e2e && npm run build)
   git clone git@github.com:hifi-phil/umbraco-mcp-ops-state.git ~/Projects/umbraco-mcp-ops-state
   cp ~/.local/state/umbraco-mcp-ops/agent-orchestration-worker.tfstate ~/Projects/umbraco-mcp-ops-state/terraform.tfstate
   export TOFU_STATE_PASSPHRASE="<from the password manager>"
   cd worker/terraform
   export TF_ENCRYPTION="$(../../scripts/deploy/tofu-encryption.sh --migrate)" && [ -n "$TF_ENCRYPTION" ] && echo "encryption ready"
   tofu init -reconfigure -backend-config="path=$HOME/Projects/umbraco-mcp-ops-state/terraform.tfstate"
   tofu apply      # the "Unencrypted method configured" warning is expected here
   jq -c keys ~/Projects/umbraco-mcp-ops-state/terraform.tfstate   # encrypted_data, not resources
   cd ~/Projects/umbraco-mcp-ops-state
   printf 'terraform.tfstate.backup\n*.lock.info\n' > .gitignore
   git add .gitignore terraform.tfstate && git commit -m "initial state (encrypted)" && git push -u origin main
   ```

   Only run `tofu apply` after **encryption ready**: written as one line,
   `TF_ENCRYPTION="$(missing-script)" tofu apply` still runs the apply, with
   no encryption. Then `export TF_ENCRYPTION="$(../../scripts/deploy/tofu-encryption.sh)"`
   (no `--migrate`) for anything else in that terminal.

6. **Test it:** Actions → `deploy` → Run workflow, from `main`, with the
   release tag. Expect `No changes` from the plan, then e2e. The `tag` field
   takes a branch name too, which is how to run a fix through the pipeline
   before it's released.
7. **Clean up** once it's green: delete the old plain state and its backup
   (`~/.local/state/umbraco-mcp-ops/`), the key files from 2, and the
   release worktree (it holds a tfvars copy).

## When it fails

| Where | What it means |
|---|---|
| Check out the state repo: `Not Found` | `STATE_DEPLOY_KEY` isn't set on the environment (the checkout fell back to the workflow token, which can't see a private repo), or the deploy key isn't on the state repo |
| Configure tofu: `no state at …` | The state repo is empty: step 5 hasn't been done. It refuses on purpose, rather than create every resource again |
| plan: Cloudflare `401` | `CLOUDFLARE_API_TOKEN` missing, expired or not for this account. Check it with `curl …/user/tokens/verify` |
| plan: GitHub `403 … personal access token` on `/hooks/…` | `E2E_GITHUB_TOKEN` lacks Webhooks |
| e2e: `403` on `/check-runs` | an e2e driver from before #301, which read CI through check-runs |
| e2e: `403` on `/actions/…` | `E2E_GITHUB_TOKEN` lacks Actions: read |
| Locally: `Unsupported state file format` | `TF_ENCRYPTION` isn't set in that terminal |

## Where to look

When a deploy or a webhook looks stuck, check Workers Logs first ("did it
arrive"), then the D1 log ("what did it do").

- **Workers Logs**: Cloudflare dashboard → Workers & Pages → `agent-orchestration-worker` → Observability. Every request with its time and status, plus the Worker's `console.error` lines. Shows when a webhook arrived and whether it errored. On since 2.3.4 (#307).
- **The D1 log** (`agent-orchestration-log`, the `transitions` table): what the Worker *did* for an issue, one row per transition, with `dropped_reason` when it chose not to act. A narrow query by `owner`, `repo` and `issue_number` (the indexed columns) in the D1 console. Free plan: 5M rows read a day, so never an unfiltered scan.
- **The GitHub App's Recent Deliveries**: whether GitHub sent the webhook, and **Redeliver** for one that failed.

### A routine's direct signals

Since 2.3.14–2.3.15 (#391), routines report straight to the Worker instead of waiting for a label or comment to be seen. When a run looks stuck, these are where to look:

- **Heartbeats** set `issue_status.last_step` in D1 for the item while it's open.
- **An explicit outcome** from `post-outcome.sh` is logged in `transitions` with a `delivery_id` starting `routine-signal:`. A later outcome comment for the same fire logs as `deduped`.
- **`blocked`** (a permission prompt) and **`ended`** (the session stopped without an outcome) each post one comment on the item at once.
- In Workers Logs, `POST /routine-signal` requests that get **401** mean `AGENT_OUTCOMES_TOKEN` doesn't match the Worker's secret (watch for a trailing `%` copied from zsh). Permission and hook changes reach sessions at their next start once released to `main` (`session-refresh.sh`); only an `env-setup.sh` change needs the stub's `rebuild:` bump.

### When the routines API refuses a fire

Each repo has **one** loop-dispatch routine, and every loop (build, review,
rework, merge, release) fires it, so they share its limits. Two refusals were
seen on 21-10-2026:

| The refusal | What it means | What happens |
|---|---|---|
| `429 rate_limit_error`: "This routine's fire rate limit has been reached. Try again in 30m21s." | Too many fires in a short time: about 15 in 30 minutes stalled every loop for half an hour | Since 2.3.6 (#322) the fire is **deferred** to the time given: the issue says "⏳ will start at about HH:MM UTC" and the Worker sends it then. Nothing to do |
| `403 forbidden`: "Request not allowed", for **one issue** while others go through | Something about that issue on the routines side: #316 was refused 6 times out of 6, on two routes, with budget to spare. The same issue re-filed as #326 built at once | The issue gets "⚠️ Couldn't start …" (since 2.3.5, #319). Re-adding the label won't help: **re-file the issue** under a new number |

When testing or running many items at once, pace them: about one
review-and-rework cycle at a time per repo.

## Changing a setting

A tfvars value (a routine URL, a watchdog override, `deployed_do_migration_tag`
after a DO migration) is now a secret: edit the local file, re-run the
`gh secret set TFVARS …` line, and it applies with the next release, or
straight away with a `workflow_dispatch` run for the current tag.

To run tofu by hand (to look, or in an emergency), use the state repo's
checkout and the encryption config, and don't overlap a running deploy. The
terminal needs `TOFU_STATE_PASSPHRASE`, `CLOUDFLARE_API_TOKEN` and
`GITHUB_TOKEN`; tfvars supplies the rest:

```sh
git -C ~/Projects/umbraco-mcp-ops-state pull   # before; commit and push after any apply
export TF_ENCRYPTION="$(scripts/deploy/tofu-encryption.sh)"
tofu -chdir=worker/terraform init -reconfigure -backend-config="path=$HOME/Projects/umbraco-mcp-ops-state/terraform.tfstate"
```

---

[← Index](00-index.md)
