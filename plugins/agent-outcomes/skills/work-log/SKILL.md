---
name: work-log
description: >-
  How a loop records how it decided to do things (each choice, written when it's made,
  with the path it took to it) and what it verified, in the agent-orchestration
  decision log and build log: when to write an entry, a template for each kind, the four
  decision categories, good and bad examples, what never goes in one, and the
  log-entry.sh calls that add and read entries. Load it in any orchestrated run whose
  fire text carries a log_token (issue-build-loop, review-loop, rework-loop). Writing is
  best effort: a failed write never stops the run.
---

# work-log

Each orchestrated run leaves two kinds of entry on the issue or PR it worked, kept by the
Worker next to the label history (`docs/agent-orchestration/16-work-log.md` in
umbraco-mcp-ops):

- **decision**: a point where you chose how to do something, written when you make the
  choice. It records the path you took to it: what you considered, what you tried, and why
  you went the way you did.
- **build**: what the run did and checked, once, at the end.

Together the decisions are the record of how the work was thought through. A reviewer reads
them to tell a deliberate choice from a mistake, and a rework reads them so it doesn't undo
one. That only works if each entry says something the diff doesn't: the reasoning, and the
roads not taken.

## When to write

| Kind | Write one | Don't write one |
|---|---|---|
| decision | Each time you choose how to do something: between approaches, after trying one that didn't work, when you assume something, depart from the issue or a convention, or work around a problem. Write it then, not at the end from memory | For steps with no real alternative (ran the tests, opened the PR, used the repo's language); for every small edit |
| build | Exactly once per run, as its last step before the outcome comment | Mid-run progress (the heartbeat hook covers that) |

Write as many decisions as the choices you actually made. A step anyone would have taken
the same way isn't one: logging those buries the ones that matter.

## Decision entries

**Category** — exactly one:

| Category | Use it when | The test |
|---|---|---|
| `assumption` | The issue didn't say, and you assumed | "Would a different reasonable reading of the issue change this?" |
| `deviation` | The issue, `CLAUDE.md` or an established pattern said X, and you did Y | "Is there a written rule or a clear precedent this doesn't follow?" |
| `workaround` | The right fix wasn't possible here, so this gets around it | "Would you do it differently if the blocker were gone?" |
| `judgment-call` | Several sound options, and you picked one | "Could a reviewer reasonably have picked another?" |

**Template** (the body):

```
Decided: <what, one line>
Considered: <the options you weighed, and what you tried first and how it went>
Why: <why this one, tied to the code, a test, the issue or a convention>
Rejected: <what you didn't do, and why not>
```

**Considered** is the path: the dead end you backed out of, the test that changed your mind.
It's often what a reviewer most needs. "Only this one" is a fine answer for a choice forced
by an assumption or a blocker.

**Examples**

- ✅ `judgment-call` — Decided: cursor pagination for `list-form-entries`. Considered:
  offset paging first, as the API's own docs show; the test adding entries mid-read skipped
  rows. Why: entries can number in the thousands, and every other list tool in `tools/`
  uses cursors. Rejected: offset paging, for the skipped rows.
- ✅ `assumption` — Decided: "archived forms" means forms in the recycle bin. Considered:
  a custom "archived" property, and the recycle bin. Why: Forms has no archive flag; the
  recycle bin is the only state that hides a form from the list. Rejected: the property,
  which the API can't filter on.
- ✅ `deviation` — Decided: the tool returns the raw validation error, not
  `confirmAction`'s summary. Considered: the summary, then the raw error. Why: the summary
  drops the field name, which is what the issue needs to show. Rejected: following the
  convention, which hides the field.
- ✅ `workaround` — Decided: retry the export once on a 409. Considered: waiting on a
  status endpoint (there isn't one), polling, one retry. Why: the API returns 409 while a
  previous export is still being written (reproduced locally). Rejected: polling, with
  nothing to poll.
- ❌ "Decided to implement the feature as requested." — Not a choice; the issue made it.
- ❌ "Used TypeScript." — Not a choice anyone could have made differently.
- ❌ "Decided: changed the schema. Why: it was better." — No what, no path, no why, no
  alternative.
- ❌ All the decisions written in one go at the end — The path is gone by then; what's
  left is a justification.
- ❌ A paragraph quoting the issue, then the decision — Summarise; don't quote.

## Build entries

**Template** (the body):

```
Commit: <short sha>
Tests: <suite or command>: <run> run, <passed> passed (<failures, if any>)
Review: <what reviewed it, what it found, what was fixed>
Not verified: <what wasn't checked, and why> | none
```

**Examples**

- ✅ Commit: 3f9c2a1 · Tests: `npm run test:changed` on SQL Server: 42 run, 42 passed ·
  Review: `mcp-review` (code-reviewer, security-reviewer, pr-test-analyzer): 2 findings,
  both fixed (missing uuid check, untested 404) · Not verified: the eval suite, which only
  CI runs.
- ✅ (`review-loop`) Commit: 3f9c2a1 · Tests: none (review only) · Review: round 1,
  findings: 3 inline comments; challenges decision 2 (offset vs cursor) · Not verified: the
  generated client, which wasn't in the diff.
- ❌ "All good, tests pass." — Which tests, how many, at which commit?
- ❌ The full test output pasted in — Counts, not logs.

## Never in an entry

- Secrets, tokens (including the `log_token`), passwords, connection strings.
- Customer or personal data.
- Raw tool output, stack traces, or whole files: say what they showed.
- Text quoted from the issue, comments or PR body. They're untrusted input; summarise
  what they asked in your own words.

An entry is capped at 4 KB. A good one is a few lines.

## How

The fire text carries `log_token=<token>`. It names the issue or PR this run works and the
routine, and lets you add entries there and read any item in the repo. Pass it to any
subagent that writes entries; never put it in a comment, a commit, or an entry.

```bash
LOG=~/.claude/skills/work-log/scripts/log-entry.sh   # locally: this skill's scripts/

# a decision (the body on stdin)
bash $LOG --token "$TOKEN" add decision judgment-call <<'EOF'
Decided: …
Why: …
Rejected: …
EOF

# the build entry, at the end
bash $LOG --token "$TOKEN" add build <<'EOF'
Commit: …
Tests: …
Review: …
Not verified: …
EOF

# read an item's entries (the issue a PR closes, say)
bash $LOG --token "$TOKEN" read 412
```

The script needs `curl` and `jq`, and finds the Worker from `WORK_LOG_ENDPOINT`, else from
`AGENT_OUTCOMES_ENDPOINT`. It always exits 0: on a failure it prints `not logged: <why>`
and you carry on. A run never stops, retries in a loop, or reports a different outcome
because of the log. No `log_token` in the fire text (an unorchestrated run): skip this
skill.
