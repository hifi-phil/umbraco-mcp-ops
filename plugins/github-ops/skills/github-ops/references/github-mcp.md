# GitHub operations — web / routines (GitHub MCP server)

Use these when `gh` is **not** available (Claude web, scheduled routines). All
GitHub work goes through the **GitHub MCP server** tools, prefixed `mcp__github__`.
Auth is the MCP server's connected GitHub App — no token to paste. Mirror of
[`gh-cli.md`](gh-cli.md) — keep both in sync.

> **Tool names are from the current `github/github-mcp-server`.** Server versions
> vary — if a name below isn't in your live `mcp__github__*` list, use whichever tool
> performs the operation. Several ops are consolidated tools with a `method`
> parameter (e.g. `pull_request_read` with `method: "get_check_runs"`).

## Issues

| Operation | Tool |
|-----------|------|
| List by label / state | `list_issues` (filter by `labels`, `state`) |
| Get / read | `issue_read` (`method: "get"`; also `get_comments`, `get_labels`) |
| Create | `issue_write` (`method: "create"`) — older servers: `create_issue` |
| Comment | `add_issue_comment` |
| Add / remove label | `issue_write` (`method: "update"`, set the `labels` array). `label_write` manages label *definitions*, not application. |
| Close | `issue_write` (`method: "update"`, `state: "closed"`) |
| Search | `search_issues` |

## Pull requests

| Operation | Tool |
|-----------|------|
| List by label / state | `list_pull_requests` |
| Get (review decision, mergeable, base) | `pull_request_read` (`method: "get"`) |
| Get reviews | `pull_request_read` (`method: "get_reviews"`) |
| **CI / check-run status** | `pull_request_read` (`method: "get_check_runs"`; also `get_status`) — poll until non-pending |
| Create | `create_pull_request` |
| **Merge** | `merge_pull_request` (pass the merge method; branch deletion may not be exposed — see Notes) |
| Update branch (bring up to date) | `update_pull_request_branch` |
| Re-request / add review | `pull_request_review_write` |

## Branches & files (for a content PR — no clone)

On the web there's **no working tree** — create the branch and push file contents
straight through the API:

| Operation | Tool |
|-----------|------|
| Create branch | `create_branch` |
| Create / update one file | `create_or_update_file` |
| Push multiple files at once | `push_files` |
| Get file contents | `get_file_contents` |
| Then open the PR | `create_pull_request` (base = detected base) |

## Base branch

Defer to `release-and-branching` for gitflow vs main-only. To inspect: `list_branches`
(does a `dev` exist?), or read repo metadata via the server's repository/search tools.

## Notes

- **Merge gate:** poll `pull_request_read` (`get_check_runs` / `get_status`) until all
  checks are non-pending and passing, and confirm the review decision, **before**
  `merge_pull_request`. There is no `--auto` equivalent to lean on — the gate is
  yours to enforce.
- **Branch deletion after merge:** the server may not expose a delete-branch tool. If
  not, leave the merged branch for the weekly `branch-housekeeping` routine to reap.
- **No `git`/`gh` fallback:** don't shell out to `gh` or `git push` here — they're not
  installed / not authenticated. Everything is `mcp__github__*`.
