# The digest — the canonical format, and posting it

Two paths produce this digest — `sweep.sh` locally, you via MCP tools in a cloud routine — so
**this file is the format's single definition.** Both must emit the same thing, or a
week-to-week comparison breaks the moment a run happens somewhere else.

- **Local path:** `sweep.sh`'s stdout **is** the digest. **Relay it verbatim** — don't rewrite,
  re-summarise, or reformat. It already matches the template below.
- **Cloud path:** build it to the template below, exactly. Same sections, same order, same
  wording, even when a section is empty.

Print it to stdout as well as posting, always. If Slack isn't reachable, the printed digest
stands on its own — **say you couldn't post** rather than failing the run.

## Destination

The Slack channel named in [`sweep-config.md`](sweep-config.md). **One message per run** — not
one per repo. Sweeping every repo in one pass exists so there's a single thing to read.

## The template

The exact digest format — including the empty-section wording and the two
only-when-they-apply sections — lives in
[`assets/digest-template.txt`](../assets/digest-template.txt). Build the cloud-path
digest to match it exactly: same sections, same order, same wording, even when a
section is empty.

## Per-line rules

- **Merged lines:** `repo  ` + backticked branch + `  (PR #n)`. Two spaces between fields, as
  `sweep.sh` emits.
- **Review lines:** a Slack link whose text is `repo@branch`, then the reason, then
  `last commit YYYY-MM-DD`. Link target depends on the reason — compare view for a reused
  branch, the PR for a closed-unmerged one, the tree for a no-PR one.
- **A reused branch's reason must carry its divergence and the words `NOT deleted`.** It's the
  one line a reader could otherwise mistake for something disposable.
- **Dates are `YYYY-MM-DD`.** Unknown is `unknown`, never `null` or blank.
- **Keep each line to one screen line** where you can; a long branch name is more useful intact
  than truncated, so don't cut branch names.

## Sections that must never be dropped

The failure mode is tidying the digest, so don't:

- **Zero findings is a result, not silence.** Every empty section says so.
- **Every category and gap classification.md defines** — the settings-off finding, REUSED,
  coverage gaps, the open-PR count — keeps its line even when empty; don't collapse or drop
  one because it looks small this run.

## Naming the cleanup, without doing it

When the digest lists branches under *safe to delete*, you may say so and name the command —
`/clean-branches`, or `/clean-branches --dry-run` to preview — and then **stop**. Don't run it,
don't offer to as part of this run, and don't imply the report has dealt with anything.

Nothing in this digest describes an action taken, because the report never takes one. If you
find yourself writing "deleted" or "cleaned", something has gone wrong.

## Nothing beyond the template

No recommendations, no prioritisation, no commentary on what the branch names suggest. The
categories carry the signal, and prose is where week-to-week comparability dies.
