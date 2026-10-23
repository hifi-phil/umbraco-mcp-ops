When the build is done, add `ai-reviewing` to the PR.
Run gh pr edit --remove-label ai-ready.
gh issue create --title t --label ai-ready
  labels: ["ai-blocked"],
