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
  description = "shadow = decide and log only. enforce = the Worker dispatches the repo's loops and writes labels for real (Phase 4); then disable the repo's loop-dispatch caller workflow, or loops fire twice (see worker/README.md)."

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
  description = "Owner of the repo whose webhooks feed the Worker."
}

variable "github_repo" {
  type        = string
  description = "Repo name (no owner) to install the webhook on. Use a test repo where the real loops run, with the usual labels (ready-for-ai, …)."
}

variable "github_read_token" {
  type        = string
  sensitive   = true
  description = "The Worker's GITHUB_APP_TOKEN. In shadow it only reads, so a fine-grained token with read access to Issues, Pull requests and Metadata is enough (fine-grained tokens have no Checks permission)."
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
