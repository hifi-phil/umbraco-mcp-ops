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

variable "mode" {
  type        = string
  default     = "shadow"
  description = "shadow = decide and log only. enforce = write labels and fire routines for real (Phase 4)."

  validation {
    condition     = contains(["shadow", "enforce"], var.mode)
    error_message = "mode must be \"shadow\" or \"enforce\"."
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
  description = "The Worker's GITHUB_APP_TOKEN. In shadow it only reads, so a fine-grained token with read access to Issues, Pull requests, Checks and Metadata is enough."
}

variable "claude_api_key" {
  type        = string
  sensitive   = true
  default     = "unused-in-shadow"
  description = "Only used to fire routines, which shadow never does. Leave the default until enforce."
}

variable "routine_ids_json" {
  type      = string
  sensitive = true
  default   = "{\"issue-build-loop\":\"unused\",\"auto-release-loop\":\"unused\",\"issue-discuss-loop\":\"unused\",\"rework-loop\":\"unused\",\"merge-flow\":\"unused\"}"
}
