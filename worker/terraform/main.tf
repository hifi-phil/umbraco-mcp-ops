# Everything worker/ needs, so `tofu destroy` removes all of it: the D1
# log, the Worker + its Durable Object, the workers.dev route, and the
# GitHub webhook. The Worker bundle is built by wrangler first
# (`npm run build` → ../dist/index.js); this uploads that file.

locals {
  bundle     = "${path.module}/../dist/index.js"
  worker_url = "https://${var.script_name}.${var.workers_subdomain}.workers.dev"

  # The e2e sandbox (docs/agent-orchestration/14-e2e-testing.md): off unless
  # e2e_repo is set. Its Fire URL is the stub agent, not a real routine.
  e2e        = var.e2e_repo != null
  e2e_bundle = "${path.module}/../../e2e/stub/dist/index.js"
  e2e_url    = "https://${var.e2e_stub_script_name}.${var.workers_subdomain}.workers.dev"
  e2e_routines = local.e2e ? {
    "${var.github_owner}/${var.e2e_repo}" = { fireUrl = local.e2e_url, token = random_password.e2e_fire_token[0].result }
  } : {}
}

resource "cloudflare_d1_database" "log" {
  account_id = var.cloudflare_account_id
  name       = var.database_name

  # Cloudflare reports this after create; leaving it out makes every plan
  # try to "remove" it (a perpetual no-op diff).
  read_replication = {
    mode = "disabled"
  }
}

# Tofu can't run SQL, so wrangler applies ../migrations/ against the real
# database, tracking what's applied in its own d1_migrations table. Re-runs
# when any migration file changes; already-applied ones are skipped.
resource "terraform_data" "d1_migrations" {
  triggers_replace = [
    cloudflare_d1_database.log.id,
    sha256(join("", [for f in sort(fileset("${path.module}/../migrations", "*.sql")) : filesha256("${path.module}/../migrations/${f}")])),
  ]

  provisioner "local-exec" {
    command = "${path.module}/apply-d1-migrations.sh"
    environment = {
      CLOUDFLARE_ACCOUNT_ID = var.cloudflare_account_id
      DB_NAME               = cloudflare_d1_database.log.name
      DB_ID                 = cloudflare_d1_database.log.id
      MIGRATIONS_DIR        = abspath("${path.module}/../migrations")
    }
  }
}

resource "random_password" "webhook_secret" {
  length  = 40
  special = false
}

resource "random_password" "routine_signal_secret" {
  length  = 40
  special = false
}

# The live-status dashboard's key for scripts (GET /status, Bearer).
resource "random_password" "status_secret" {
  length  = 40
  special = false
}

# Signs the dashboard's session cookie after a GitHub sign-in. Rotating it
# signs everyone out.
resource "random_password" "session_secret" {
  length  = 48
  special = false
}

resource "cloudflare_workers_script" "worker" {
  account_id          = var.cloudflare_account_id
  script_name         = var.script_name
  main_module         = "index.js"
  content_file        = local.bundle
  content_sha256      = filesha256(local.bundle)
  compatibility_date  = "2026-08-25"
  compatibility_flags = ["nodejs_compat"]

  # Cloudflare rejects an upload whose old_tag doesn't match the tag already
  # deployed (412, "Actor migration tag precondition failed"). The provider
  # can't read the deployed tag, hence the var. v1 created IssueCoordinator;
  # v2 adds Scheduler (the sweep). A fresh deploy creates both at v2; one at
  # v1 moves to v2 once; one at v2 re-sends v2 with no steps (a no-op).
  migrations = (
    var.deployed_do_migration_tag == null ? {
      old_tag            = null
      new_tag            = "v2"
      new_sqlite_classes = ["IssueCoordinator", "Scheduler"]
      } : var.deployed_do_migration_tag == "v1" ? {
      old_tag            = "v1"
      new_tag            = "v2"
      new_sqlite_classes = ["Scheduler"]
      } : {
      old_tag            = "v2"
      new_tag            = "v2"
      new_sqlite_classes = null
    }
  )

  bindings = concat([
    { type = "durable_object_namespace", name = "ISSUE_COORDINATOR", class_name = "IssueCoordinator" },
    # The reconciliation sweep (src/scheduler.ts): a DO alarm, not a Cron
    # Trigger. Real repos sweep in shadow (log what would be re-fired) until
    # sweep_mode = "enforce"; the e2e sandbox always enforces.
    { type = "durable_object_namespace", name = "SCHEDULER", class_name = "Scheduler" },
    { type = "plain_text", name = "SWEEP_MINUTES", text = tostring(var.sweep_minutes) },
    { type = "plain_text", name = "SWEEP_MODE", text = var.sweep_mode },
    { type = "plain_text", name = "SWEEP_MAX_REFIRES", text = tostring(var.sweep_max_refires) },
    { type = "plain_text", name = "SWEEP_ENFORCE_REPOS", text = local.e2e ? "${var.github_owner}/${var.e2e_repo}" : "" },
    { type = "d1", name = "DB", id = cloudflare_d1_database.log.id },
    { type = "plain_text", name = "MODE", text = var.mode },
    { type = "plain_text", name = "WATCHDOG", text = var.watchdog },
    # The sandbox's own watchdog: real, with a short timeout a scenario can
    # wait out. Every other repo keeps `watchdog` and the default minutes.
    {
      type = "plain_text",
      name = "WATCHDOG_OVERRIDES_JSON",
      text = jsonencode(local.e2e ? {
        "${var.github_owner}/${var.e2e_repo}" = { mode = "enforce", minutes = var.e2e_watchdog_minutes }
      } : {}),
    },
    # The sandbox's CI-fix and review-round caps, so its cap scenarios run
    # one round, not three. Every other repo keeps the defaults.
    {
      type = "plain_text",
      name = "CAP_OVERRIDES_JSON",
      text = jsonencode(local.e2e ? {
        "${var.github_owner}/${var.e2e_repo}" = { ciFixAttempts = var.e2e_rework_cap, botReviewReworks = var.e2e_rework_cap }
      } : {}),
    },
    # The Worker's own GitHub identity: every call goes as the App's bot on
    # an installation token (src/github-app.ts), and the self-trigger guard
    # drops that bot's label echoes. Required, not optional: the table's
    # CI-fix rules fire their loops directly, which only stays single-fire
    # while the echoes are dropped.
    { type = "plain_text", name = "GITHUB_APP_ID", text = var.github_app_id },
    { type = "secret_text", name = "GITHUB_APP_PRIVATE_KEY", text = var.github_app_private_key },
    { type = "secret_text", name = "GITHUB_WEBHOOK_SECRET", text = random_password.webhook_secret.result },
    { type = "secret_text", name = "ROUTINE_SIGNAL_SECRET", text = random_password.routine_signal_secret.result },
    {
      type = "secret_text",
      name = "REPO_ROUTINES_JSON",
      text = jsonencode(merge(
        { for repo, r in var.repo_routines : repo => { fireUrl = r.fire_url, token = r.token } },
        local.e2e_routines,
      )),
    },
    # GET /status, the live-status dashboard (src/dashboard/).
    { type = "secret_text", name = "STATUS_SECRET", text = random_password.status_secret.result },
    ],
    # The dashboard's GitHub sign-in (src/auth.ts), limited to
    # sign_in_domains. Without github_app_client_id it's off, and only the
    # Bearer key reads /status.
    var.github_app_client_id != "" ? [
      { type = "plain_text", name = "GITHUB_OAUTH_CLIENT_ID", text = var.github_app_client_id },
      { type = "secret_text", name = "GITHUB_OAUTH_CLIENT_SECRET", text = var.github_app_client_secret },
      { type = "secret_text", name = "SESSION_SECRET", text = random_password.session_secret.result },
      { type = "plain_text", name = "SIGN_IN_DOMAINS", text = var.sign_in_domains },
    ] : [],
    # GET /transitions, the e2e suite's read of the D1 log, for the sandbox
    # only. Without e2e_repo there's no LOG_READ_SECRET, so the route is off.
    local.e2e ? [
      { type = "plain_text", name = "LOG_READ_REPOS", text = "${var.github_owner}/${var.e2e_repo}" },
      { type = "secret_text", name = "LOG_READ_SECRET", text = random_password.e2e_log_read_secret[0].result },
    ] : [],
  )

  # Don't take webhook traffic before the log table exists.
  depends_on = [terraform_data.d1_migrations]
}

resource "cloudflare_workers_script_subdomain" "worker" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_workers_script.worker.script_name
  enabled     = true
}

# Webhooks come from the GitHub App, not a hook per repo: the App's webhook
# (its settings page) points at worker_url with this webhook_secret and the
# events issues, issue_comment, pull_request and check_suite, so a repo is
# connected by installing the App on it. Tofu can't manage an App's
# settings; see worker/README.md's "Deploying".

# --- The e2e sandbox: the stub agent and the sandbox's webhook -------------
# Build the stub first: `cd ../../e2e && npm run build` (→ e2e/stub/dist/index.js).

resource "random_password" "e2e_fire_token" {
  count   = local.e2e ? 1 : 0
  length  = 40
  special = false
}

resource "cloudflare_workers_script" "e2e_stub" {
  count              = local.e2e ? 1 : 0
  account_id         = var.cloudflare_account_id
  script_name        = var.e2e_stub_script_name
  main_module        = "index.js"
  content_file       = local.e2e_bundle
  content_sha256     = filesha256(local.e2e_bundle)
  compatibility_date = "2026-08-25"

  bindings = [
    { type = "plain_text", name = "E2E_REPO", text = "${var.github_owner}/${var.e2e_repo}" },
    { type = "secret_text", name = "FIRE_TOKEN", text = random_password.e2e_fire_token[0].result },
    { type = "secret_text", name = "HOOK_SECRET", text = random_password.e2e_hook_secret[0].result },
    # Heartbeats and completion signals to the orchestrator's /routine-signal.
    # A service binding, because a Worker can't fetch another Worker on the
    # same account's workers.dev URL (Cloudflare error 1042).
    { type = "service", name = "ORCHESTRATOR", service = cloudflare_workers_script.worker.script_name },
    { type = "secret_text", name = "ROUTINE_SIGNAL_SECRET", text = random_password.routine_signal_secret.result },
    # The orchestrator's App: every GitHub call the stub makes goes as its
    # bot, so no personal token is stored for the stub either.
    { type = "plain_text", name = "GITHUB_APP_ID", text = var.github_app_id },
    { type = "secret_text", name = "GITHUB_APP_PRIVATE_KEY", text = var.github_app_private_key },
  ]
}

resource "random_password" "e2e_log_read_secret" {
  count   = local.e2e ? 1 : 0
  length  = 40
  special = false
}

resource "random_password" "e2e_hook_secret" {
  count   = local.e2e ? 1 : 0
  length  = 40
  special = false
}

resource "cloudflare_workers_script_subdomain" "e2e_stub" {
  count       = local.e2e ? 1 : 0
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_workers_script.e2e_stub[0].script_name
  enabled     = true
}

# The stub's own webhook: CI finishing, so its merge-flow can merge on green
# (the real merge-flow polls for that instead).
resource "github_repository_webhook" "e2e_stub" {
  count      = local.e2e ? 1 : 0
  repository = var.e2e_repo
  active     = true
  events     = ["check_suite"]

  configuration {
    url          = "${local.e2e_url}/webhook"
    content_type = "json"
    secret       = random_password.e2e_hook_secret[0].result
    insecure_ssl = false
  }

  depends_on = [cloudflare_workers_script_subdomain.e2e_stub]
}
