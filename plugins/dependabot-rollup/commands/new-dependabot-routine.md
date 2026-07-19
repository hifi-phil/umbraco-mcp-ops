---
description: Generate a ready-to-set-up Dependabot security-rollup CLOUD ROUTINE for one GitHub repo, and print step-by-step manual setup instructions for the claude.ai routines UI. It does NOT create the routine programmatically — GitHub connector + plugin attachment are UI-only on many accounts, and the routine API silently drops those fields. Produces the config + a checklist you follow yourself.
argument-hint: "<owner/repo> [base-branch] [--cron '0 8 * * 1']"
---

# /new-dependabot-routine

Produce everything needed to set up a **per-repo Dependabot security-rollup cloud routine** — the full routine config plus a copy-paste setup checklist for the claude.ai routines UI. 

**Why generate-and-instruct instead of auto-create:** attaching a GitHub MCP connector and enabling a marketplace plugin on a routine are **UI-only** operations on restricted accounts, and the routine API accepts but silently drops `enabled_plugins`/`extra_marketplaces`. So this command hands you a ready config and clear steps rather than pretending to upload it. (If your account *can* create routines via the API and you've confirmed GitHub access works, you can still paste the generated body into `RemoteTrigger` yourself — but the reliable path is the UI.)

**One routine per repo** by design — the `/dependabot-rollup` drive-to-green-CI loop is inherently per-PR, so per-repo routines give failure isolation, repo-scoped auth, and independent cadence.

ARGUMENTS: $ARGUMENTS
- `<owner/repo>` — **required**, e.g. `umbraco/Umbraco-CMS-MCP-Editor`.
- `[base-branch]` — optional. Default: `dev` if it exists on the target repo, else the repo's default branch.
- `--cron '<expr>'` — optional 5-field UTC cron. Default `0 8 * * 1` (Mon 09:00 Europe/London = 08:00 UTC). Min interval 1 hour.

## Procedure

### 1. Resolve inputs
- Parse `<owner/repo>`; fail early if missing.
- **Base branch:** if not given, check `gh api repos/<owner/repo>/branches/dev` — if it exists use `dev`, else `gh repo view <owner/repo> --json defaultBranchRef --jq .defaultBranchRef.name`.
- **Cron:** default `0 8 * * 1` unless `--cron` given. Compute the human-readable local time (Europe/London) for the summary.

### 2. Build the self-contained routine prompt
Read the sibling command file `commands/dependabot-rollup.md` (same plugin) and **inline its full procedure** into the routine prompt, substituting the resolved base branch for `<base>`. This makes the generated routine **self-contained** — it does not depend on the plugin being resolvable inside the cloud worker. Prepend one line: "You are running UNATTENDED as a weekly routine for `<owner/repo>`." and keep all guardrails verbatim.

> Alternative (plugin-delivered) prompt — only if the target account can enable plugins on routines via the UI: use the one-liner `Run /dependabot-rollup <base> for <owner/repo>; follow that plugin command exactly.` and add "enable the `dependabot-rollup` plugin" to the setup checklist. Default to the self-contained prompt unless the user asks for this.

### 3. Emit the routine config block
Print a clearly-formatted spec the user can transcribe (and the raw JSON body for the API path):
- **Name:** `Dependabot security rollup → <owner/repo> (<base>)`
- **Schedule:** `<cron>` (= `<human-readable local time>`)
- **Model:** `claude-sonnet-5`
- **Environment:** recommend one with network + the repo's toolchain (e.g. a .NET/Node env). Note the user picks this in the UI.
- **Source repo:** `https://github.com/<owner/repo>`
- **Allowed tools:** `Bash, Read, Write, Edit, Glob, Grep, Skill`
- **Prompt:** the self-contained prompt from step 2 (in a fenced block for easy copy).

### 4. Emit the manual setup checklist
Print numbered steps for **https://claude.ai/code/routines**:
1. New routine → set the name and schedule above.
2. Pick the cloud environment; set model `claude-sonnet-5`; add source repo `<owner/repo>`.
3. Paste the prompt from step 3.
4. **Attach GitHub access** (the critical step — see §5).
5. (Plugin variant only) enable the `dependabot-rollup` plugin from the `umbraco-mcp-ops` marketplace.
6. Save; note the routine URL `https://claude.ai/code/routines/<id>`.
7. Do a **supervised first run** ("Run now") before trusting the schedule — it acts for real (opens a PR; closes superseded PRs once CI is green).

### 5. Emit the GitHub-access requirement
The worker needs authenticated GitHub access or every run no-ops. State the options:
- **Preferred:** attach the **GitHub MCP connector** to the routine, authorized for `<owner/repo>` with **Dependabot alerts: read**, **Contents: read/write**, **Pull requests: read/write**, **Actions/Checks: read**. (If connectors are org-blocked, request they be enabled — endpoint `https://api.githubcopilot.com/mcp/`.)
- **Fallback:** a fine-grained **PAT** with the same permissions, set as a `GH_TOKEN` secret on the cloud environment so the `gh`/`git` CLI authenticates.
Warn: **Dependabot alerts: read** is the scope whose absence silently turns every run into a no-op.

## Notes
- **No CI on the target repo:** `/dependabot-rollup`'s green-CI goal is vacuously met when a repo runs no PR checks — the rollup then ships unverified. Only schedule repos you're comfortable with, or ensure they run PR CI.
- Keep the rollup logic in `commands/dependabot-rollup.md` as the single source of truth; this generator inlines it so cloud routines stay self-contained.
