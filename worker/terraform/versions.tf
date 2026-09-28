terraform {
  required_version = ">= 1.6"

  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 5.26" }
    github     = { source = "integrations/github", version = "~> 6.13" }
    random     = { source = "hashicorp/random", version = "~> 3.6" }
  }

  # Local state, but outside the repo: checkouts here are often worktrees
  # that get deleted, and losing the state means `tofu destroy` can't clean
  # up. The path is supplied at init so no one's home directory is committed:
  #   tofu init -backend-config="path=$HOME/.local/state/umbraco-mcp-ops/agent-orchestration-worker.tfstate"
  # The state holds every secret in plain text. Never commit it (.gitignore
  # here still catches a stray in-repo copy).
  backend "local" {}
}

# Reads CLOUDFLARE_API_TOKEN from the environment.
provider "cloudflare" {}

# Reads GITHUB_TOKEN from the environment. Needs admin:repo_hook (or a
# fine-grained token with Webhooks: write) on var.github_repo only.
provider "github" {
  owner = var.github_owner
}
