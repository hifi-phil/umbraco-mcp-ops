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
  description = "The Durable Object migration tag already deployed: unset for a fresh deploy, \"v1\" or \"v2\" after. v2 adds the Scheduler class (the reconciliation sweep): an apply with \"v1\" moves to v2, after which set it to \"v2\". Unset it again after a destroy. See `tofu output migration_tag`."

  validation {
    condition     = var.deployed_do_migration_tag == null || contains(["v1", "v2"], var.deployed_do_migration_tag)
    error_message = "Migrations v1 and v2 exist. Use the deployed one (tofu output migration_tag), or leave unset for a fresh deploy."
  }
}

variable "sweep_minutes" {
  type        = number
  default     = 15
  description = "Minutes between reconciliation sweeps (src/scheduler.ts), which re-fire issues left in a trigger state with no watchdog."
}

variable "sweep_max_refires" {
  type        = number
  default     = 3
  description = "At most this many re-fires per sweep; the rest wait for the next one, so a backlog drains a few at a time (each re-fire is an agent run)."
}

variable "sweep_mode" {
  type        = string
  default     = "shadow"
  description = "shadow = sweeps only log what they would re-fire (a reconcile_refire row with mode shadow); enforce = they re-fire. The e2e sandbox always enforces."

  validation {
    condition     = contains(["shadow", "enforce"], var.sweep_mode)
    error_message = "sweep_mode must be \"shadow\" or \"enforce\"."
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

variable "github_app_client_id" {
  type        = string
  default     = ""
  description = "The GitHub App's Client ID (its settings page, under About), for the status dashboard's \"Sign in with GitHub\". Empty: sign-in is off and only the Bearer key reads /status."
}

variable "github_app_client_secret" {
  type        = string
  default     = ""
  sensitive   = true
  description = "A client secret for that App (App settings -> Client secrets -> Generate a new client secret). Needed whenever github_app_client_id is set."

  validation {
    condition     = var.github_app_client_id == "" || var.github_app_client_secret != ""
    error_message = "github_app_client_secret is needed when github_app_client_id is set."
  }
}

variable "sign_in_domains" {
  type        = string
  default     = "umbraco.com,umbraco.dk"
  description = "Comma-separated email domains let into the dashboard: a GitHub account needs a verified email at one of them."
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
