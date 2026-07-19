# GitHub operations — local (`gh` CLI + `git`)

Use these when `gh` is available (a dev machine). Auth is your `gh` login. `<repo>`
is `owner/name`. Mirror of [`github-mcp.md`](github-mcp.md) — keep both in sync.

## Issues

| Operation | Command |
|-----------|---------|
| List by label / state | `gh issue list --repo <repo> --label <label> --state open --json number,title,body,labels --limit 100` |
| Get / read | `gh issue view <n> --repo <repo> --json number,title,body,labels,state,comments` |
| Create | `gh issue create --repo <repo> --title "<t>" --body "<b>" --label <label>` |
| Comment | `gh issue comment <n> --repo <repo> --body "<text>"` |
| Add / remove label | `gh issue edit <n> --repo <repo> --add-label <l>` / `--remove-label <l>` |
| Close | `gh issue close <n> --repo <repo> --comment "<why>"` |

## Pull requests

| Operation | Command |
|-----------|---------|
| List by label / state | `gh pr list --repo <repo> --label <label> --state open --json number,title,baseRefName` |
| List open Dependabot PRs | `gh pr list --repo <repo> --state open --app dependabot --json number,title,headRefName,url --limit 100` |
| Get (review decision, mergeable, base) | `gh pr view <n> --repo <repo> --json reviewDecision,mergeable,mergeStateStatus,baseRefName,headRefName` |
| Get reviews + review comments | `gh pr view <n> --repo <repo> --json reviews,comments`; inline comments: `gh api repos/<repo>/pulls/<n>/comments` |
| **CI / check-run status** | `gh pr checks <n> --repo <repo>` (add `--watch` to block until done) |
| **Read a failing check's log** | `gh run view --repo <repo> --job <id> --log-failed` (get `<id>` from `gh pr checks`) |
| Create | `gh pr create --repo <repo> --base <base> --head <head> --title "<t>" --body "<b>"` |
| **Merge (+ delete branch)** | `gh pr merge <n> --repo <repo> --squash --delete-branch` (or `--merge` per convention) |
| Update a PR's body | `gh pr edit <n> --repo <repo> --body "<body>"` |
| **Close without merging (+ comment, delete branch)** | `gh pr close <n> --repo <repo> --comment "<why>" --delete-branch` |
| Re-request review | `gh pr edit <n> --repo <repo> --add-reviewer <user>` |
| List Dependabot security alerts | `gh api repos/<repo>/dependabot/alerts --paginate --jq '.[] \| select(.state=="open")'` (needs `security_events` scope) |

## Branches & files (for a content PR)

Locally you have a working tree — do it with `git`, then open the PR with `gh`:

```bash
git clone https://github.com/<repo> && cd <name>
git checkout -b chore/<slug>
# …edit files…
git commit -am "<msg>" && git push -u origin chore/<slug>
gh pr create --base <base> --head chore/<slug> --title "<t>" --body "<b>"
```

| Operation | Command |
|-----------|---------|
| Create branch | `git checkout -b <branch>` (then `git push -u origin <branch>`) |
| Create / update / push file(s) | edit in the working tree → `git add` → `git commit` → `git push` |
| Get file contents | `git show <ref>:<path>` (or just read the file in the clone) |

## Base branch

Defer to the `release-and-branching` skill to detect gitflow (`dev`+`main`) vs
main-only. Quick check: `gh api repos/<repo> --jq .default_branch`, and
`gh api repos/<repo>/branches --jq '.[].name'` to see if a `dev` exists.

## Notes

- `gh pr checks` exit status / output is the CI gate — **poll until all checks are
  non-pending and passing before merging**; never `gh pr merge --auto` (this org has
  no branch protection, so `--auto` would merge without the real gate).
