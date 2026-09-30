#!/usr/bin/env bash
#
# Deterministic tests for route-event.sh — the loop-dispatch routing decision.
# Hermetic: bash + jq only, no network, no gh, no claude. Runs in a few ms.
#
# Usage: bash run.sh   (exits non-zero if any case fails)
set -uo pipefail

# Isolate from any ambient GitHub-event env (GitHub Actions sets these to the
# workflow's OWN event, which would otherwise shadow the stdin payloads we feed in).
unset GITHUB_EVENT_PATH GITHUB_EVENT_NAME

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$(cd "$HERE/.." && pwd)/route-event.sh"
[ -f "$SCRIPT" ] || { echo "FATAL: route-event.sh not found at $SCRIPT"; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "FATAL: jq required"; exit 2; }

pass=0 fail=0

# expect_route <name> <expected-route> -- <args...>   (args after -- go to route-event.sh)
expect_route() {
  local name="$1" want="$2"; shift 2; [ "$1" = "--" ] && shift
  local out; out="$(bash "$SCRIPT" "$@" </dev/null)"
  local got="${out#route=}"; got="${got%% *}"
  if [ "$got" = "$want" ]; then pass=$((pass+1)); # echo "ok: $name"
  else fail=$((fail+1)); echo "FAIL: $name — want route=$want, got: $out"; fi
}

# expect_line <name> <expected-full-line> < stdin-json ... (via here-string)
expect_json() {
  local name="$1" want="$2" json="$3" evt="$4"
  local out; out="$(printf '%s' "$json" | bash "$SCRIPT" --event "$evt")"
  if [ "$out" = "$want" ]; then pass=$((pass+1));
  else fail=$((fail+1)); echo "FAIL: $name — want [$want], got [$out]"; fi
}

# --- flag-driven cases -----------------------------------------------------
expect_route "pr auto-merge → merge-flow"          merge-flow        -- --event pull_request --action labeled --label auto-merge --number 42 --repo o/r
expect_route "pr auto-rework → rework-loop"        rework-loop       -- --event pull_request --action labeled --label auto-rework --number 50 --repo o/r
# The live caller fires `pull_request_target` (runs from default branch w/ secrets, so it
# reaches dev-based PRs); route-event normalises it to pull_request.
expect_route "pr_target auto-merge → merge-flow"   merge-flow        -- --event pull_request_target --action labeled --label auto-merge --number 42 --repo o/r
expect_route "pr_target auto-rework → rework-loop" rework-loop       -- --event pull_request_target --action labeled --label auto-rework --number 50 --repo o/r
expect_route "pr_target dependencies → none"       none              -- --event pull_request_target --action labeled --label dependencies --number 269 --repo o/r
expect_route "pr dependencies → none (the 4x bug)" none              -- --event pull_request --action labeled --label dependencies --number 269 --repo o/r
expect_route "pr javascript → none"                none              -- --event pull_request --action labeled --label javascript --number 7 --repo o/r
expect_route "pr opened → none"                    none              -- --event pull_request --action opened --number 42 --repo o/r
expect_route "issue ready-for-ai → issue-build-loop" issue-build-loop -- --event issues --action labeled --label ready-for-ai --number 5 --repo o/r
expect_route "issue auto-release → auto-release"   auto-release-loop -- --event issues --action labeled --label auto-release --number 9 --repo o/r
expect_route "issue bug → none"                    none              -- --event issues --action labeled --label bug --number 3 --repo o/r
expect_route "issue ai-discuss → discuss loop"     issue-discuss-loop -- --event issues --action labeled --label ai-discuss --number 50 --repo o/r

# --- discussion rounds (issue_comment) -------------------------------------
# A trusted human's comment on an open, `ai-discuss`-labelled issue. `OK` is that happy path;
# each case below flips exactly ONE gate off and must route nowhere.
OK=(--event issue_comment --action created --issue-labels ai-discuss --issue-state open --author-type User --author-assoc OWNER --number 50 --repo o/r)
expect_route "comment: trusted human on open issue"  issue-discuss-loop -- "${OK[@]}"
expect_route "comment: label among others"           issue-discuss-loop -- --event issue_comment --action created --issue-labels "bug,ai-discuss,enhancement" --issue-state open --author-type User --author-assoc MEMBER --number 50 --repo o/r
expect_route "comment: COLLABORATOR is trusted"      issue-discuss-loop -- --event issue_comment --action created --issue-labels ai-discuss --issue-state open --author-type User --author-assoc COLLABORATOR --number 50 --repo o/r
# THE critical negative: the loop posts as the maintainer's own account, so its own comment is
# indistinguishable by author. The marker it signs every comment with is the only guard.
expect_route "comment: signed by the loop → none"    none -- "${OK[@]}" --self-marked 1
# Opt-out: a comment starting `//` is aimed at a colleague, not the loop.
expect_route "comment: // human-only → none"         none -- "${OK[@]}" --human-only 1
# Untrusted commenters: these repos are public, so a stranger must not be able to fire a session.
expect_route "comment: assoc NONE → none"            none -- --event issue_comment --action created --issue-labels ai-discuss --issue-state open --author-type User --author-assoc NONE --number 50 --repo o/r
expect_route "comment: assoc CONTRIBUTOR → none"     none -- --event issue_comment --action created --issue-labels ai-discuss --issue-state open --author-type User --author-assoc CONTRIBUTOR --number 50 --repo o/r
# Fail-closed: an absent/unknown field must never route (the script's stated contract).
expect_route "comment: no assoc at all → none"       none -- --event issue_comment --action created --issue-labels ai-discuss --issue-state open --author-type User --number 50 --repo o/r
expect_route "comment: no author type → none"        none -- --event issue_comment --action created --issue-labels ai-discuss --issue-state open --author-assoc OWNER --number 50 --repo o/r
expect_route "comment: no issue state → none"        none -- --event issue_comment --action created --issue-labels ai-discuss --author-type User --author-assoc OWNER --number 50 --repo o/r
expect_route "comment: author type Organization → none" none -- --event issue_comment --action created --issue-labels ai-discuss --issue-state open --author-type Organization --author-assoc OWNER --number 50 --repo o/r
expect_route "comment: Bot author → none"            none -- --event issue_comment --action created --issue-labels ai-discuss --issue-state open --author-type Bot --author-assoc OWNER --number 50 --repo o/r
# The remaining gates.
expect_route "comment: no ai-discuss label → none"   none -- --event issue_comment --action created --issue-labels "bug,enhancement" --issue-state open --author-type User --author-assoc OWNER --number 50 --repo o/r
expect_route "comment: no labels at all → none"      none -- --event issue_comment --action created --issue-state open --author-type User --author-assoc OWNER --number 50 --repo o/r
expect_route "comment: ai-discussion substring → none" none -- --event issue_comment --action created --issue-labels ai-discussion --issue-state open --author-type User --author-assoc OWNER --number 50 --repo o/r
expect_route "comment: closed issue → none"          none -- --event issue_comment --action created --issue-labels ai-discuss --issue-state closed --author-type User --author-assoc OWNER --number 50 --repo o/r
expect_route "comment: on a PR → none"               none -- "${OK[@]}" --is-pr 1
# `--is-pr 0` must read as "not a PR" — emptiness-testing would get this backwards.
expect_route "comment: --is-pr 0 still routes"       issue-discuss-loop -- "${OK[@]}" --is-pr 0
expect_route "comment: deleted → none"               none -- --event issue_comment --action deleted --issue-labels ai-discuss --issue-state open --author-type User --author-assoc OWNER --number 50 --repo o/r
expect_route "comment: edited → none"                none -- --event issue_comment --action edited --issue-labels ai-discuss --issue-state open --author-type User --author-assoc OWNER --number 50 --repo o/r
expect_route "review changes → none (now label-driven)" none         -- --event pull_request_review --action submitted --state changes_requested --number 42 --repo o/r
expect_route "review approved → none"              none              -- --event pull_request_review --action submitted --state approved --number 42 --repo o/r
expect_route "unknown event → none"                none              -- --event release --action published --number 1 --repo o/r
expect_route "no input at all → none"              none              --

# --- raw-JSON payload cases (event name passed separately, as GitHub does) --
expect_json "raw json auto-merge PR" \
  "route=merge-flow repo=a/b number=7" \
  '{"action":"labeled","label":{"name":"auto-merge"},"pull_request":{"number":7},"repository":{"full_name":"a/b"}}' \
  pull_request
expect_json "raw json dependencies PR → none" \
  "route=none repo=a/b number=269" \
  '{"action":"labeled","label":{"name":"dependencies"},"pull_request":{"number":269},"repository":{"full_name":"a/b"}}' \
  pull_request
expect_json "raw json ready-for-ai issue" \
  "route=issue-build-loop repo=a/b number=5" \
  '{"action":"labeled","label":{"name":"ready-for-ai"},"issue":{"number":5},"repository":{"full_name":"a/b"}}' \
  issues
expect_json "raw json auto-rework PR label" \
  "route=rework-loop repo=a/b number=8" \
  '{"action":"labeled","label":{"name":"auto-rework"},"pull_request":{"number":8},"repository":{"full_name":"a/b"}}' \
  pull_request
expect_json "raw json auto-rework via pull_request_target" \
  "route=rework-loop repo=a/b number=8" \
  '{"action":"labeled","label":{"name":"auto-rework"},"pull_request":{"number":8},"repository":{"full_name":"a/b"}}' \
  pull_request_target
expect_json "raw json review changes_requested → none (label-driven now)" \
  "route=none repo=a/b number=8" \
  '{"action":"submitted","review":{"state":"changes_requested"},"pull_request":{"number":8},"repository":{"full_name":"a/b"}}' \
  pull_request_review
expect_json "raw json ai-discuss issue label" \
  "route=issue-discuss-loop repo=a/b number=50" \
  '{"action":"labeled","label":{"name":"ai-discuss"},"issue":{"number":50},"repository":{"full_name":"a/b"}}' \
  issues
# The comment payload carries no `.label` — the decision comes from `.issue.labels[]`,
# `.issue.state`, `.comment.author_association`, `.comment.user.type` and `.comment.body`
# (the loop's marker), which is the only new payload shape in the router. These raw-JSON
# cases are what the live edge actually feeds it.
expect_json "raw json trusted human comment on ai-discuss issue" \
  "route=issue-discuss-loop repo=a/b number=50" \
  '{"action":"created","comment":{"user":{"type":"User"},"author_association":"OWNER","body":"simpler please"},"issue":{"number":50,"state":"open","labels":[{"name":"bug"},{"name":"ai-discuss"}]},"repository":{"full_name":"a/b"}}' \
  issue_comment
# The loop's own comment — same author as the human's (it posts as the maintainer), so ONLY the
# marker distinguishes it. If this ever routes, the loop answers itself round after round.
expect_json "raw json loop's own signed comment → none" \
  "route=none repo=a/b number=50" \
  '{"action":"created","comment":{"user":{"type":"User"},"author_association":"OWNER","body":"Here is the plan.\n\n<!-- issue-discuss-loop -->"},"issue":{"number":50,"state":"open","labels":[{"name":"ai-discuss"}]},"repository":{"full_name":"a/b"}}' \
  issue_comment
expect_json "raw json loop's capped comment → none" \
  "route=none repo=a/b number=50" \
  '{"action":"created","comment":{"user":{"type":"User"},"author_association":"OWNER","body":"Round cap.\n\n<!-- issue-discuss-loop:capped -->"},"issue":{"number":50,"state":"open","labels":[{"name":"ai-discuss"}]},"repository":{"full_name":"a/b"}}' \
  issue_comment
# Opt-out prefix: comments are for the loop by default, `//` addresses a colleague instead.
expect_json "raw json // comment to a colleague → none" \
  "route=none repo=a/b number=50" \
  '{"action":"created","comment":{"user":{"type":"User"},"author_association":"OWNER","body":"// @sarah do we still need this at all?"},"issue":{"number":50,"state":"open","labels":[{"name":"ai-discuss"}]},"repository":{"full_name":"a/b"}}' \
  issue_comment
expect_json "raw json // with no space → none" \
  "route=none repo=a/b number=50" \
  '{"action":"created","comment":{"user":{"type":"User"},"author_association":"OWNER","body":"//parking this for now"},"issue":{"number":50,"state":"open","labels":[{"name":"ai-discuss"}]},"repository":{"full_name":"a/b"}}' \
  issue_comment
expect_json "raw json leading blank line then // → none" \
  "route=none repo=a/b number=50" \
  '{"action":"created","comment":{"user":{"type":"User"},"author_association":"OWNER","body":"\n  // @sarah thoughts?"},"issue":{"number":50,"state":"open","labels":[{"name":"ai-discuss"}]},"repository":{"full_name":"a/b"}}' \
  issue_comment
# A `//` that is not at the START is not the opt-out — a URL or a code snippet must still route.
expect_json "raw json url containing // still routes" \
  "route=issue-discuss-loop repo=a/b number=50" \
  '{"action":"created","comment":{"user":{"type":"User"},"author_association":"OWNER","body":"see https://example.com/docs — does that change the plan?"},"issue":{"number":50,"state":"open","labels":[{"name":"ai-discuss"}]},"repository":{"full_name":"a/b"}}' \
  issue_comment
# Addressing it explicitly is honoured because an unprefixed comment already routes.
expect_json "raw json /discuss prefix routes" \
  "route=issue-discuss-loop repo=a/b number=50" \
  '{"action":"created","comment":{"user":{"type":"User"},"author_association":"OWNER","body":"/discuss can we do this without a new route?"},"issue":{"number":50,"state":"open","labels":[{"name":"ai-discuss"}]},"repository":{"full_name":"a/b"}}' \
  issue_comment
expect_json "raw json @claude mention routes" \
  "route=issue-discuss-loop repo=a/b number=50" \
  '{"action":"created","comment":{"user":{"type":"User"},"author_association":"OWNER","body":"@claude can we do this without a new route?"},"issue":{"number":50,"state":"open","labels":[{"name":"ai-discuss"}]},"repository":{"full_name":"a/b"}}' \
  issue_comment
expect_json "raw json stranger comment → none" \
  "route=none repo=a/b number=50" \
  '{"action":"created","comment":{"user":{"type":"User"},"author_association":"NONE","body":"me too"},"issue":{"number":50,"state":"open","labels":[{"name":"ai-discuss"}]},"repository":{"full_name":"a/b"}}' \
  issue_comment
expect_json "raw json bot comment on ai-discuss issue → none" \
  "route=none repo=a/b number=50" \
  '{"action":"created","comment":{"user":{"type":"Bot"},"author_association":"OWNER","body":"beep"},"issue":{"number":50,"state":"open","labels":[{"name":"ai-discuss"}]},"repository":{"full_name":"a/b"}}' \
  issue_comment
expect_json "raw json comment on unlabelled issue → none" \
  "route=none repo=a/b number=51" \
  '{"action":"created","comment":{"user":{"type":"User"},"author_association":"OWNER","body":"hi"},"issue":{"number":51,"state":"open","labels":[{"name":"bug"}]},"repository":{"full_name":"a/b"}}' \
  issue_comment
expect_json "raw json comment on closed issue → none" \
  "route=none repo=a/b number=50" \
  '{"action":"created","comment":{"user":{"type":"User"},"author_association":"OWNER","body":"hi"},"issue":{"number":50,"state":"closed","labels":[{"name":"ai-discuss"}]},"repository":{"full_name":"a/b"}}' \
  issue_comment
expect_json "raw json comment on a PR → none" \
  "route=none repo=a/b number=9" \
  '{"action":"created","comment":{"user":{"type":"User"},"author_association":"OWNER","body":"hi"},"issue":{"number":9,"state":"open","labels":[{"name":"ai-discuss"}],"pull_request":{"url":"https://api.github.com/repos/a/b/pulls/9"}},"repository":{"full_name":"a/b"}}' \
  issue_comment

echo "----"
echo "route-event tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
