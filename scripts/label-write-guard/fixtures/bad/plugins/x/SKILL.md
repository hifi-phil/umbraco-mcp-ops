When the build is done, add `ai-reviewing` to the PR.
Run gh pr edit --remove-label ai-ready.
gh issue create --title t --label ai-ready
  labels: ["ai-blocked"],
gh pr create -l ai-reviewing
gh pr edit 1 --add-label foo
gh pr edit 1 --remove-label foo
call add_label
call remove_label
mcp__github__issue_write with labels set
