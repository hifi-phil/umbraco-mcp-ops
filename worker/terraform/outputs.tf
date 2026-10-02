output "worker_url" {
  value = local.worker_url
}

output "d1_database_id" {
  value = cloudflare_d1_database.log.id
}

output "mode" {
  value = var.mode
}

# What deployed_do_migration_tag should be set to for the next apply.
output "migration_tag" {
  value = cloudflare_workers_script.worker.migration_tag
}

# For AGENT_OUTCOMES_ENDPOINT's bearer token (plugins/agent-outcomes). Read
# with `tofu output -raw routine_signal_secret`.
output "routine_signal_secret" {
  value     = random_password.routine_signal_secret.result
  sensitive = true
}

# The live-status dashboard: open <worker_url>/status and give this as the
# password (any user name). Read with `tofu output -raw status_secret`.
output "status_secret" {
  value     = random_password.status_secret.result
  sensitive = true
}

# The e2e driver's key to GET /transitions. It reads this itself (tofu
# output -raw e2e_log_read_secret) unless E2E_LOG_SECRET is set.
output "e2e_log_read_secret" {
  value     = local.e2e ? random_password.e2e_log_read_secret[0].result : null
  sensitive = true
}

# The e2e driver's key to the stub's POST /review (the same bearer as a fire).
output "e2e_fire_token" {
  value     = local.e2e ? random_password.e2e_fire_token[0].result : null
  sensitive = true
}

# For the GitHub App's webhook settings (Webhook secret). Read with
# `tofu output -raw webhook_secret`.
output "webhook_secret" {
  value     = random_password.webhook_secret.result
  sensitive = true
}

# The e2e driver reads the App's webhook deliveries as the App.
output "github_app_id" {
  value = var.github_app_id
}

output "github_app_private_key" {
  value     = var.github_app_private_key
  sensitive = true
}

output "e2e_stub_url" {
  value = local.e2e ? local.e2e_url : null
}
