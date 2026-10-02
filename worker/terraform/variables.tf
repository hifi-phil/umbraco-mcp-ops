variable "cloudflare_account_id" {
  type        = string
  description = "The Cloudflare account to deploy into (dashboard → Workers & Pages → Account ID)."
}

variable "workers_subdomain" {
  type        = string
  description = "The account's workers.dev subdomain, i.e. the <x> in <script>.<x>.workers.dev. Used to build the webhook URL."

  validation {
    condition     = !endswith(var.workers_subdomain, ".workers.dev") && !strcontains(var.workers_subdomain, "/")
    error_message = "workers_subdomain is only the part before .workers.dev (e.g. \"my-sub\", not \"my-sub.workers.dev\")."
  }
}

variable "script_name" {
  type    = string
  default = "agent-orchestration-worker"
}

variable "database_name" {
  type    = string
  default = "agent-orchestration-log"
}

variable "deployed_do_migration_tag" {
  type        = string
  default     = null
  description = "The Durable Object migration tag already deployed. Leave unset for the first apply (it creates the class, tag v1); set to \"v1\" for every apply after that. Unset it again after a destroy. See `tofu output migration_tag`."

  validation {
    condition     = var.deployed_do_migration_tag == null || var.deployed_do_migration_tag == "v1"
    error_message = "Only migration v1 exists. Use \"v1\" once deployed, or leave unset for a fresh deploy."
  }
}

variable "mode" {
  type        = string
  default     = "shadow"
  description = "shadow = decide and log only. enforce = the Worker dispatches the repo's loops and writes labels for real (Phase 4); then immediately disable and delete the repo's loop-dispatch caller workflow (a clean break), or loops fire twice (see worker/README.md \"Enforcing\")."

  validation {
    condition     = contains(["shadow", "enforce"], var.mode)
    error_message = "mode must be \"shadow\" or \"enforce\"."
  }
}

variable "watchdog" {
  type        = string
  default     = "shadow"
  description = "The watchdog's own switch, only honoured when mode is enforce. shadow = expiries only log; enforce = move the issue to ai-stuck and comment. Kept separate because its timeouts are still guesses."

  validation {
    condition     = contains(["shadow", "enforce"], var.watchdog)
    error_message = "watchdog must be \"shadow\" or \"enforce\"."
  }
}

variable "github_owner" {
  type        = string
  description = "The GitHub account the Worker's repos belong to (the e2e sandbox's owner, and the GitHub provider's)."
}


variable "github_read_token" {
  type        = string
  sensitive   = true
  description = "A personal token, the Worker's fallback GITHUB_APP_TOKEN. Unused while the GitHub App (github_app_id + github_app_private_key) is configured, which it always is now; kept so a Worker without the App still has something to call GitHub with."
}

variable "github_app_id" {
  type        = string
  description = "The Worker's GitHub App ID (the App's settings page). The Worker reads and writes GitHub as this App's bot. The App needs Issues and Pull requests read & write, Checks and Contents read, and must be installed on every repo the Worker serves (including e2e_repo)."
}

variable "github_app_private_key" {
  type        = string
  sensitive   = true
  description = "The App's private key: the .pem GitHub downloads (App settings -> Private keys -> Generate), pasted as-is into terraform.tfvars as a heredoc, or set as TF_VAR_github_app_private_key. Either PKCS#1 (GitHub's format) or PKCS#8 works. Like every secret here, it ends up in tofu's state, so keep that file safe."

  validation {
    condition     = strcontains(var.github_app_private_key, "PRIVATE KEY-----")
    error_message = "github_app_private_key must be the key's PEM text (\"-----BEGIN RSA PRIVATE KEY-----…\"), not a path."
  }
}

variable "repo_routines" {
  type = map(object({
    fire_url = string
    token    = string
  }))
  sensitive   = true
  default     = {}
  description = "Each repo's loop-dispatch routine, keyed \"owner/repo\": its Fire URL (Routines UI → Call via API) and token, the same pair as that repo's LOOP_DISPATCH_FIRE_URL / LOOP_DISPATCH_TOKEN secrets. Only used when an enforced transition fires; shadow never does, so it can stay empty until then."
}

variable "e2e_repo" {
  type        = string
  default     = null
  description = "The e2e sandbox repo (no owner), e.g. \"mcp-ops-e2e-testing\". Set it to deploy the stub agent as the sandbox's Fire URL and install the sandbox's webhook; leave unset for none. See docs/agent-orchestration/14-e2e-testing.md."
}

variable "e2e_stub_script_name" {
  type    = string
  default = "agent-orchestration-e2e-stub"
}

variable "e2e_watchdog_minutes" {
  type        = number
  default     = 2
  description = "The sandbox's watchdog timeout, for every routine. Its watchdog is always real (enforce), whatever `watchdog` is; no other repo is affected. Long enough for merge-flow to outlast a CI run (it stays watched while CI runs), short enough for a scenario to wait out."
}

variable "e2e_stub_github_token" {
  type        = string
  sensitive   = true
  default     = null
  description = "The stub agent's GitHub token: fine-grained, the sandbox repo only, with Contents, Issues and Pull requests read/write. Required when e2e_repo is set."

  validation {
    condition     = var.e2e_repo == null || var.e2e_stub_github_token != null
    error_message = "e2e_stub_github_token is required when e2e_repo is set."
  }
}
