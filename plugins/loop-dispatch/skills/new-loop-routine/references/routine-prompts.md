# Loop routine prompts — LOCKED templates

The **authoritative, verbatim** text for every loop routine's prompt. Copy the relevant
block **exactly**, replace the single token **`{{OWNER_REPO}}`** (e.g.
`umbraco/Umbraco-CMS-MCP-Dev`) with `sed`/find-replace, and paste it into the routine —
**do not reword, summarise, or add anything.** This file is the single source of truth;
changing a routine's instructions means editing this file (in a PR), never hand-editing
a live routine's prompt. Substitution is the *only* per-repo change.

`[new-loop-routine](../SKILL.md)` points here; it does not restate these.

---

## Consolidated routine (default — one per repo)

Name: `loop-dispatch → {{OWNER_REPO}}`

```text
A GitHub loop event fired on {{OWNER_REPO}}. Run the loop-dispatch skill: read the <github-trigger-context> block, run route-event.sh with the parsed fields to get the route, and dispatch to the matching loop — mcp-issue-loop (cloud mode) / merge-flow / rework-loop / auto-release-loop — exactly as loop-dispatch specifies, or quiet no-op when route=none. Follow loop-dispatch's guardrails verbatim; add no policy of your own.
```

Events to attach (UI): Issue: Labeled `ready-for-ai` · Issue: Labeled `auto-release` · PR: Labeled `auto-merge` · PR review.

---

## Per-loop routines (fallback — only when a routine can't hold multiple event triggers)

### mcp-issue-loop (cloud) — Issue: Labeled `ready-for-ai`, model `sonnet`

```text
Triggered when an issue is labelled ready-for-ai on {{OWNER_REPO}}. Identify the triggering issue — the open issue labelled ready-for-ai (if more than one, the oldest by creation date); none → quiet no-op. Run /mcp-issue-loop in CLOUD mode for it, following its Cloud mode section exactly: triage the issue and spawn one build subagent on the best-fit model; no EnterWorktree; NO local Umbraco and NO full local test suite (CI is the test gate); push, open a PR against the base branch (dev), and drive CI green (8-attempt cap); then mark the issue (remove ready-for-ai, add generated-by-ai; or ai-blocked on a tripped backstop) and STOP. Do NOT merge and do NOT self-review. This repo is TypeScript; local checks are npm run compile / npm run build.
```

### merge-flow — PR: Labeled `auto-merge`, model `haiku`, tools `["Bash","Read","Skill"]`

```text
Triggered when a PR is labelled auto-merge on {{OWNER_REPO}}. Run the merge-flow skill by invoking /merge-flow, following its guardrails exactly: merge a PR only if it has the auto-merge label AND CI is genuinely green (polled, never --auto) AND it is conflict-free AND on the correct base (dev) AND has no unresolved 'changes requested' review. Sweep every open auto-merge-labelled PR (cap 10 per run), not only the one that triggered this event. Be a QUIET NO-OP if nothing qualifies — do not notify unless you merged a PR or hit a real blocker on an auto-merge-labelled PR. For any labelled PR you could not merge, comment the specific blocker on it and move on.
```

### rework-loop — PR review, model `sonnet`

```text
Triggered by a GitHub PR review requesting changes on {{OWNER_REPO}}. Identify the triggering PR — a PR this bot identity authored whose latest review requests changes and whose requested changes are not yet addressed (if more than one qualifies, the oldest); none → quiet no-op. Run the rework-loop skill by invoking /rework-loop and follow it exactly: read the requested changes, address them in code, re-green CI, then re-request review and STOP. This loop NEVER merges and NEVER runs a full local test suite — CI is the test gate. This repo is TypeScript; local checks are npm run compile / npm run build only.
```

### auto-release-loop — Issue: Labeled `auto-release`, model `sonnet`

```text
An auto-release release has been requested on {{OWNER_REPO}}. Identify the triggering issue — the open issue labelled auto-release (if more than one, the oldest); none → quiet no-op. Run the auto-release-loop skill by invoking /auto-release-loop, taking the target version from the issue's title (e.g. release 18.0.0-beta3 → 18.0.0-beta3). Follow the auto-release-loop guardrails exactly as the skill defines them — it owns the CI gate, the Step 2.5 release-reviewer review (publish only on PASS; on BLOCK it files a release-blocked issue + push-notifies), prerelease handling, the main→dev sync, and the notifications. Just run the skill and let it gate; don't re-implement or relax any of it here.
```
