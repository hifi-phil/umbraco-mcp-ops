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

# The e2e driver's key to GET /transitions. It reads this itself (tofu
# output -raw e2e_log_read_secret) unless E2E_LOG_SECRET is set.
output "e2e_log_read_secret" {
  value     = local.e2e ? random_password.e2e_log_read_secret[0].result : null
  sensitive = true
}

output "e2e_stub_url" {
  value = local.e2e ? local.e2e_url : null
}
