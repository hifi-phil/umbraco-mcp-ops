# Everything worker/ needs, so `tofu destroy` removes all of it: the D1
# log, the Worker + its Durable Object, the workers.dev route, and the
# GitHub webhook. The Worker bundle is built by wrangler first
# (`npm run build` → ../dist/index.js); this uploads that file.

locals {
  bundle     = "${path.module}/../dist/index.js"
  worker_url = "https://${var.script_name}.${var.workers_subdomain}.workers.dev"
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

resource "cloudflare_workers_script" "worker" {
  account_id          = var.cloudflare_account_id
  script_name         = var.script_name
  main_module         = "index.js"
  content_file        = local.bundle
  content_sha256      = filesha256(local.bundle)
  compatibility_date  = "2026-08-25"
  compatibility_flags = ["nodejs_compat"]

  # Cloudflare rejects an upload whose old_tag doesn't match the tag already
  # deployed (412, "Actor migration tag precondition failed"). First deploy:
  # no old_tag, create the class. After that: old_tag = new_tag = v1 and no
  # steps, a no-op. The provider can't read the deployed tag, hence the var.
  migrations = var.deployed_do_migration_tag == null ? {
    old_tag            = null
    new_tag            = "v1"
    new_sqlite_classes = ["IssueCoordinator"]
    } : {
    old_tag            = var.deployed_do_migration_tag
    new_tag            = var.deployed_do_migration_tag
    new_sqlite_classes = null
  }

  bindings = [
    { type = "durable_object_namespace", name = "ISSUE_COORDINATOR", class_name = "IssueCoordinator" },
    { type = "d1", name = "DB", id = cloudflare_d1_database.log.id },
    { type = "plain_text", name = "MODE", text = var.mode },
    { type = "secret_text", name = "GITHUB_APP_TOKEN", text = var.github_read_token },
    { type = "secret_text", name = "GITHUB_WEBHOOK_SECRET", text = random_password.webhook_secret.result },
    { type = "secret_text", name = "ROUTINE_SIGNAL_SECRET", text = random_password.routine_signal_secret.result },
    { type = "secret_text", name = "CLAUDE_API_KEY", text = var.claude_api_key },
    { type = "secret_text", name = "ROUTINE_IDS_JSON", text = var.routine_ids_json },
  ]

  # Don't take webhook traffic before the log table exists.
  depends_on = [terraform_data.d1_migrations]
}

resource "cloudflare_workers_script_subdomain" "worker" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_workers_script.worker.script_name
  enabled     = true
}

resource "github_repository_webhook" "worker" {
  repository = var.github_repo
  active     = true
  # Exactly what graph/github/from-github.ts and coordinate.ts translate.
  events = ["issues", "issue_comment", "pull_request", "check_suite"]

  configuration {
    url          = local.worker_url
    content_type = "json"
    secret       = random_password.webhook_secret.result
    insecure_ssl = false
  }

  depends_on = [cloudflare_workers_script_subdomain.worker]
}
