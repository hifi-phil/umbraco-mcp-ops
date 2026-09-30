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
  description = "shadow = decide and log only. enforce = write labels and fire routines for real for EVERY event. For Phase 4, leave this shadow and list individual events in enforce_events."

  validation {
    condition     = contains(["shadow", "enforce"], var.mode)
    error_message = "mode must be \"shadow\" or \"enforce\"."
  }
}

variable "enforce_events" {
  type        = list(string)
  default     = []
  description = "Events enforced while mode is shadow (Phase 4, one transition at a time), e.g. [\"labelled_auto_merging\"]. Each enforced event that fires a loop must also be in the repo's LOOP_DISPATCH_WORKER_ROUTES variable, or the loop fires twice (see worker/README.md)."

  # Mirrors graph/constants/events.ts. A typo here fails the plan instead of
  # silently staying in shadow.
  validation {
    condition = alltrue([for e in var.enforce_events : contains([
      "labelled_ai_ready", "build_succeeded", "build_blocked", "labelled_auto_releasing",
      "release_blocked", "release_published", "labelled_ai_discussing", "discussion_reply",
      "unlabelled_ai_ready", "unlabelled_auto_releasing", "issue_closed", "labelled_auto_reworking",
      "rework_pushed", "unlabelled_auto_reworking", "labelled_auto_merging", "merge_gate_failed_soft",
      "merge_gate_failed_hard", "unlabelled_auto_merging", "merged", "watchdog_expired",
    ], e)])
    error_message = "enforce_events has a name that isn't an event in graph/constants/events.ts."
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
