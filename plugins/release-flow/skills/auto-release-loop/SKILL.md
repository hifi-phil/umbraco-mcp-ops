---
name: auto-release-loop
description: >-
  Event-triggered release preparation with NO mid-flow human approval, guarded by two
  automated gates: green CI, then an Opus pre-publish review against a growing checklist.
  When an issue titled `release <version>` is labelled `auto-releasing`, this cuts the
  release branch, bumps version files + changelog, opens the PR to main, drives CI green,
  runs the review (a BLOCK finding stops it), then reports `release_approved` (or
  `release_blocked`) and stops. Merging, tagging and the release note are the
  orchestrator's and `release-publish`'s. For gitflow repos. Requires the github-ops and
  agent-outcomes skills. Trigger: an issue labelled `auto-releasing`.
---

# auto-release-loop

The release loop: **issue-triggered and CI-gated, with no mid-flow human approval.** Two
deliberate signals are the go-ahead: (1) a maintainer opened an issue naming the version
and applied the **`auto-releasing`** label, and (2) **CI on the release PR is green**.
That's it — no approval pause — by design, for fast beta/pre-release cycles.

> **Publishing is irreversible.** Once CI is green and the review passes, the orchestrator
> merges and publishes with no further human look, and a published package version can't be cleanly un-published (you'd ship a
> follow-up). Use this only where **CI-green is a sufficient gate** — the deliberate
> `auto-releasing` label is the one human decision.

## Trigger & input

- **Version** = parsed from the triggering issue's **title** (e.g.
  `release 18.0.0-beta3` → `18.0.0-beta3`). If the title has no clear
  `release <version>`, **comment on the issue asking for one and stop** — never guess a
  version.
- **Branch model** via the `release-and-branching` skill — this skill is for
  **gitflow**. A release is on one **line**, a pair of branches, written in this skill as:
  - **`<dev>`**: where work merges and the release is cut from.
  - **`<main>`**: where the release merges and is tagged.
- **Which line.** The current line is `dev` + `main`. An older major is released from its
  own pair, `v<major>/dev` + `v<major>/main` (e.g. `v17/dev` + `v17/main`): use that pair
  when `v<major>/dev` exists for `<version>`'s major, else `dev` + `main`. The repo's
  `CLAUDE.md` overrides this when it lists its lines differently. A version that fits no
  line, or more than one: **comment on the issue and stop**, never guess. Start from an
  up-to-date `<dev>` (use the `sync-dev` skill).
- All GitHub actions go through the **`github-ops`** skill.

## The `/goal`

```
/goal auto-releasing <version> of <repo>: release/<version> cut from <dev>; version files + changelog bumped; PR to <main> is green; pre-publish review checklist passed with no BLOCK; release_approved reported on the triggering issue
```

## Step 1 — prepare (autonomous)

**Re-run (the branch and its PR already exist).** If `release/<version>` and its open PR to
`<main>` exist (a person re-labelled after a block), reuse both unchanged: in this step, don't
cut, merge `<dev>`, bump, push or open anything. Count a PR as "its open PR" only if it is not
cross-repository, its head SHA equals origin's `release/<version>` tip, and it is the only open
PR from that branch; otherwise comment and stop (as in the one-of-two case below). Work out what `<dev>` has that the branch lacks:
commits on `origin/<dev>` that aren't on `origin/release/<version>` (locally
`git log origin/release/<version>..origin/<dev>` after a fetch; on the MCP path, `list_commits` with `sha: <dev>` and again with
`sha: release/<version>`, paged back to their common ancestor, then take the `<dev>` SHAs absent from
the release list), named by the `(#n)` suffix
of their squash subject (a commit with no suffix is counted, not named). Commits on the branch itself aren't checked here: Step 2.5 reviews its full head. Then:

- **None missing** → comment "re-run: reused `release/<version>` and PR #<pr> unchanged. Up
  to date with `<dev>`.", then carry on to Step 2.
- **Any missing** → **stop**; don't go on to Step 2. Comment "re-run: reused
  `release/<version>` and PR #<pr> unchanged. Not included from `<dev>`: #312, #313, #314"
  (at most 20, then "and N more", plus "M commits without a PR number" if any), and offer
  two ways on: **include them** (close PR #<pr>, delete `release/<version>`, re-label: the
  loop cuts fresh from `<dev>`), or **ship as is** (merge the release PR yourself
  **with a merge commit**, the repo's release convention, never squash; make sure
  `v<version>` is tagged and released and `<main>` is merged back into `<dev>`; post the Slack
  note only if one is due; and close this issue). Before commenting, work out and state in the
  comment whether a Slack note is due (by `release-publish` step 2's rules) and to which channel, and whether the repo's own
  automation tags and releases on merge; don't cite skill steps or `CLAUDE.md` in it. Append the required
  `release_blocked` artifact (`reason` = the comment's first line). No `release_published` fires after a manual ship, so the orchestrator never
  closes the open `ready-for-release` issues: say in the comment that a manual ship needs those
  closed by hand.

The final comment (the `release_approved` one) repeats the
re-run line in one line. If only one of the branch and its open PR exists, comment on the
issue and stop (post the `release_blocked` artifact as in the "Any
missing" case), never guess. With neither, do items 1-3 below as written.

1. From up-to-date `<dev>`, cut `release/<version>`.
2. Bump the repo's **version-file list** (from its `CLAUDE.md`) and the changelog — use
   the repo's own release skill if it has one (e.g. `umbraco-mcp-skills:release`).
3. Push and open a PR **`release/<version>` → `<main>`**, referencing the triggering issue
   (`Part of #<n>`, not `Closes`: on the default branch
   `Closes` would close the issue at the merge, before `release-publish` has run).

## Step 2 — drive CI green

Poll the PR's check-run status (github-ops → *Get PR CI / check-run status*) until it
settles, then require **every** check to pass. Fix failures on the release branch (the
issue loop's **8-attempt** cap applies). **CI-green is required** — there is no human
approval step, but the Step 2.5 review is a second, automated gate. If CI can't be made
green, **stop**, comment the blocker on the issue, and leave the PR open. **Never publish
on red**, never trust a bypassing auto-merge.

**Record the head SHA that CI went green on** — checks belong to a specific commit, so note
which one you confirmed. Step 2.5 step 4 compares the freshly re-fetched head SHA against
this recorded SHA to detect a mid-flight push, and re-enters this step to re-green the new
commit.

## Step 2.5 — pre-publish review (second gate)

Once CI is green, and before anything irreversible, the loop gathers the review material
itself and then runs the dedicated **`release-reviewer` agent** (defined in this plugin —
Opus; what it checks and how it judges live in its own definition, which checks this skill's
`references/release-review-checklist.md`).

**`release-reviewer` fetches nothing.** It has no `Bash`, no git access, and no GitHub tool
of its own — by design, since it ingests attacker-influenceable text (PR body, commit
messages, changelog, issue title) and having no execution capability removes any path from
"hostile text" to "runs a command". **This loop** does all the fetching and pinning, and
hands the agent already-materialized content as plain text. Do this sequence
**immediately before invoking the agent**, in order:

1. **Re-fetch the PR's facts fresh.** Never reuse facts gathered earlier in the run — the
   branch may have moved (e.g. a mid-flight human push). Re-get the PR to read its
   **current head commit SHA**, base, mergeability, and diff (github-ops → *Get*): locally
   `gh pr view <n> --repo <repo> --json headRefOid,baseRefName,headRefName,mergeable,files,title,body`;
   on the MCP/web path `pull_request_read` with **`method: "get"`** → `head.sha`, base, and
   mergeability, **plus `pull_request_read` with `method: "get_files"`** for the changed-file
   list (or **`method: "get_diff"`** for the diff text itself) — `method: "get"` returns no
   file list, and checklist row 4 ("PR scope is release-only", judged on changed files + size)
   can't be evaluated without it, so the cloud/routine path must make both calls. Re-read CI too
   (github-ops → *Get PR CI / check-run status*). For a PR reviewed **retrospectively after
   merge and branch deletion**, the PR object still carries its final `head.sha` from
   GitHub's records — deleting the branch ref doesn't remove it — so use that; there's no
   need for the branch to still exist.
2. **Fetch the file contents the reviewer must judge, pinned to that verified head SHA** —
   the version files bumped in Step 1 (per the repo's `CLAUDE.md` version-file list) and the
   changelog. **Never read these from a local working tree**, which can be stale, on another
   branch, or (on the MCP/web path) absent entirely.
   - MCP/web: `get_file_contents` with `owner`, `repo`, `path`, and **`sha: <head-sha>`** —
     that parameter takes precedence over `ref`, so it's the one to pin with.
   - Locally: `gh api "repos/<owner>/<repo>/contents/<path>?ref=<head-sha>"` — the contents
     API's `ref` accepts a commit SHA, so this reads the blob at that exact commit
     regardless of what the clone has checked out. Add
     `-H "Accept: application/vnd.github.raw"` for the raw text instead of base64.

   Also carry over **the repo's `CLAUDE.md` version-file list itself** — the literal list of
   paths Step 1 already had to read in order to do the bump — as its own field, separate from
   the file contents. Without it the reviewer only sees the files the loop *chose* to fetch,
   so it cannot tell that an expected version file was **missed entirely** (checklist row 1,
   and row 4's "files outside the expected set" in the missed-file direction). Pass the list
   even when every file in it was bumped.
3. **Write all of it to one input file, verbatim, and pass the reviewer its path.** Use
   `/tmp/release-review-<version>.md`, with one section per fact: PR number, **PR title**,
   **PR body**, head branch, head SHA, base, version, triggering issue title, **changed
   files**, **CI**, **mergeability**, **the repo's `CLAUDE.md` version-file list**, **and the
   pinned file contents from step 2** (plus any `could not fetch` notes). Copy what the API
   returned; never summarise, abbreviate or recount it:
   - **Changed files:** one line per entry from the file list (`get_files` / `files`):
     status, path, `+additions −deletions`. Every entry, no patch text. Then the PR's own
     `changed_files`, `additions` and `deletions`.
   - **CI:** one line per check run on the head SHA: name, status, conclusion.
   - **Mergeability:** `mergeable` and the literal `mergeable_state` from the PR object.

   **Check the file before handing it over:** the changed-file lines must number
   `changed_files`, and their additions and deletions must sum to the PR's totals. If they
   don't, page through the file list again (it pages at 30 on the MCP path) and rewrite the
   section. Then invoke `release-reviewer` with the file's path. (See its "What you're given"
   section — it must match this list.) It returns **VERDICT: PASS**, **VERDICT: BLOCK +
   findings**, or **VERDICT: INCOMPLETE + the missing facts**; the loop acts on the verdict
   (the agent can't publish anything itself).
4. **If the branch moved, go back to Step 2, then re-do steps 1–2.** Compare the head SHA
   from step 1's fresh re-fetch against **the SHA Step 2 last confirmed CI green on**. If
   they differ, someone pushed mid-flight, so the recorded green CI belongs to the old
   commit: **return to Step 2 and drive CI green on the new head SHA** (poll the new SHA's
   checks to green exactly as Step 2's normal flow does, still bounded by Step 2's own
   **8-attempt** cap; if it can't be greened, Step 2's stop-and-comment behaviour applies).
   Only once the new SHA is green, discard the older material and redo steps 1–2 against it
   before invoking the reviewer — never invoke the reviewer on a SHA whose CI is still
   pending, which would make it BLOCK on the checklist's "CI genuinely green" row and fire
   the blocked-issue protocol for what should be a transparent automatic recovery. Cap this
   re-green-and-refetch cycle at **3 attempts** in case of a flapping branch; if it still
   hasn't settled, treat it as a blocker — stop, comment on the triggering issue, and leave
   the PR open. There is no post-hoc staleness-detection path to build: the loop fetches
   fresh immediately before use, so the reviewer never has to notice staleness after the
   fact.
5. **If a pinned-content fetch fails for a file that should exist** (a genuine 404 or
   unreachable at that SHA), **don't silently omit it** — pass the reviewer a note
   `could not fetch <path> at <sha>: <error>` alongside everything else, and let it decide
   whether that's BLOCK-worthy.

> The routine's `allowed_tools` must include the Agent/Task tool so `release-reviewer`
> can be spawned. If it can't be spawned in the environment, do the review inline on the
> loop's model and **note in the outcome comment that it wasn't the Opus `release-reviewer`**.
> An inline review is held to the same bar: it must still do the fetch-and-pin sequence above
> (steps 1–2 — plain `github-ops` calls, no git plumbing) before judging any check, satisfying
> the **preconditions** at the top of `references/release-review-checklist.md`, and **BLOCK**
> if it can't.

- **INCOMPLETE** → a gap in this loop's hand-off, not a verdict on the release. Fetch exactly
  the facts it names (github-ops), correct those sections of the input file, and invoke the
  reviewer again. At most **2 re-runs**; if it still says INCOMPLETE, treat it as a BLOCK
  below, and say in the blocked issue that it's an evidence gap with no defect found, listing
  the facts that couldn't be supplied.
- Any **BLOCK** finding → **do not merge/tag/publish.** Leave the release PR open, then:
  1. **Create a new issue** in the repo titled `Release <version> blocked by pre-publish
     review`, detailing the reviewer's BLOCK findings plus links to the release PR and
     the triggering issue.
  2. **Comment on the triggering issue** pointing to the blocked issue + PR, with the
     required `release_blocked` artifact (load `agent-outcomes` for the marker and shape).
- **WARN** findings → proceed, but include them in the `release_approved` comment.
- Report `release_approved` **only** when the checklist passes with no BLOCK.

**Stop here on a pass.** The
orchestrator merges the PR as its GitHub App, the way you say, pinned to the commit you
reviewed; the repo's own workflow tags it; then `release-publish` (a separate, small run)
posts the release note, merges `<main>` back into `<dev>` and reports, and the orchestrator
closes this issue. So on a pass, post one comment on the triggering issue with the
**required** `release_approved` artifact (load `agent-outcomes` for the marker and shape),
and **stop**: don't merge, tag, create a Release, post to Slack, sync, or close anything.
- `pr`: the release PR's number; `sha`: the **head SHA the review judged** (Step 2.5's
  re-fetched one). A push after the review makes the merge refuse, which is the point.
- `version`: `<version>`; `merge_method`: how this repo merges a release into `<main>`
  (`merge`, `squash` or `rebase`, from its conventions: `release-and-branching`, or its
  `CLAUDE.md`). For a gitflow repo that's `merge`: the release tooling keys off the
  merge commit.
- Include any WARN findings in that comment.

## Guardrails

- **Never force-push.** **Never cross lines**: a release only touches its own
  `<dev>` and `<main>`.
- **One release per triggering issue.**

## Running as a routine

The Worker fires this through `loop-dispatch` (route `auto-release-loop`) when an issue
is labelled `auto-releasing`, on an environment that has this skill (+ `github-ops`, `agent-outcomes`,
`release-and-branching`, `sync-dev`) — firing is instant, so labelling a
`release <version>` issue kicks it off immediately. The version comes from the issue, so
nothing else needs configuring per run. *(The `auto-releasing` label must exist on the
target repo.)*
