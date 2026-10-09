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
  # Once deploys run from releases (.github/workflows/deploy.yml), the state
  # lives encrypted in a private state repo instead: see
  # docs/agent-orchestration/19-deploy.md.
  backend "local" {}
}

# Reads CLOUDFLARE_API_TOKEN from the environment.
provider "cloudflare" {}

# Reads GITHUB_TOKEN from the environment. Only the e2e stub's own
# check_suite webhook is a repo hook now (the orchestrator's come from its
# GitHub App), so it needs Webhooks: write on var.e2e_repo only.
provider "github" {
  owner = var.github_owner
}
