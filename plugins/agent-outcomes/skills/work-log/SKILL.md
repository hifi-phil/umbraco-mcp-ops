---
name: work-log
description: >-
  How a loop records its work in the agent-orchestration work log: a journal of how it
  decided to do things (each choice, written when it's made, with the path it took), the
  decision list derived from it at the end (one line per choice a person should know
  about), and a build entry of what it verified. When to write each, templates, the four
  categories, good and bad examples, what never goes in an entry, and the log-entry.sh
  calls. Load it in any orchestrated run whose fire text carries a log_token
  (issue-build-loop, review-loop, rework-loop). Best effort: a failed write never stops
  the run.
---

# work-log

Each orchestrated run leaves three kinds of entry on the issue or PR it worked, kept by the
Worker next to the label history (`docs/agent-orchestration/16-work-log.md` in
umbraco-mcp-ops):

| Kind | What | When |
|---|---|---|
| **journal** | How you decided to do something, and the path you took: what you considered, what you tried, why you went this way | Each time you choose, as you choose |
| **decision** | One line per choice a person should know about, derived from the journal by a fresh subagent, pointing back to it | Once, at the end of the run |
| **build** | What the run did and checked | Once, at the end of the run |

The journal is the reasoning: a rework reads it so it doesn't undo a deliberate choice, and
the review reads it to challenge one. The decision list is what a person reads first: the
PR description's *Decisions to check* is built from it, with the journal behind each item
for when the one line isn't enough to judge it. The build entry is the evidence.

## Categories

Every journal entry and every decision has exactly one:

| Category | Use it when | The test |
|---|---|---|
| `assumption` | The issue didn't say, and you assumed | "Would a different reasonable reading of the issue change this?" |
| `deviation` | The issue, `CLAUDE.md` or an established pattern said X, and you did Y | "Is there a written rule or a clear precedent this doesn't follow?" |
| `workaround` | The right fix wasn't possible here, so this gets around it | "Would you do it differently if the blocker were gone?" |
| `judgment-call` | Several sound options, and you picked one | "Could a reviewer reasonably have picked another?" |

## Journal entries

**Write one** each time you choose how to do something: between approaches, after trying
one that didn't work, when you assume something, depart from the issue or a convention, or
work around a problem. Write it then, not at the end from memory: by then the path is gone,
and what's left is a justification.

**Don't write one** for a step with no real alternative (ran the tests, opened the PR, used
the repo's language) or for every small edit. Write as many as the choices you actually
made; logging steps anyone would have taken the same way buries the ones that matter.

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
- ❌ All the entries written in one go at the end — That's a justification, not a journal.
- ❌ A paragraph quoting the issue, then the decision — Summarise; don't quote.

## The decision list

**Written by a fresh subagent, not the agent that made the choices**, at the end of the
run, before the build entry. The one who chose tends to find all its choices obvious; fresh
eyes judge better which ones a person needs to know about. The run that owns the work
(`issue-build-loop`'s orchestrator) spawns it, on a cheaper model (it reads and judges, it
doesn't code), with the `log_token`, the issue, and the diff. The subagent:

1. **Reads the journal** (`read` the item, and the issue a PR closes), the issue and the
   diff. It is not the builder, and has none of its context: the journal and the diff are
   what it has.
2. **Writes one decision** for each choice a person should know about: where a different,
   equally reasonable choice existed and the outcome could plausibly matter to whoever owns
   the change (the test Matt Brailsford's `decision-review` uses). Skip pure mechanics
   (names, layout inside an agreed pattern). Several journal entries can make one decision;
   many make none.
3. **Checks the diff for choices nobody journalled**: a deviation from the issue or a
   convention, an assumption baked into the code. Each one worth a person's look gets a
   decision starting `(not journalled)`, with no `--refs`. How often this happens is one of
   the trial's measures of how well the journal is kept.
4. Returns the decisions it wrote (ids and lines). It never writes journal or build
   entries.

**Template**: one line, `<what was decided> — <why it matters>`, with its category and the
journal entries behind it (`--refs`).

**Examples**

- ✅ `judgment-call` (refs #7, #9) — Cursor pagination for `list-form-entries`, not offset —
  callers that page with offsets elsewhere will need changing.
- ✅ `assumption` (refs #8) — "Archived" read as "in the recycle bin" — if the issue meant
  something else, the filter is wrong.
- ✅ `deviation` (no refs) — (not journalled) The list tool returns 50 rows, not the
  convention's 100 — callers relying on the default page size get fewer.
- ❌ (refs #7) "See the journal." — The line has to stand on its own.
- ❌ A line for every journal entry — The list is the subset worth a person's time.

None worth a person's look: write no decisions. That's an answer too.

## Build entries

**Once, as the run's last step** before the outcome comment.

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
  findings: 3 inline comments; challenges journal #7 (offset vs cursor) · Not verified: the
  generated client, which wasn't in the diff.
- ❌ "All good, tests pass." — Which tests, how many, at which commit?
- ❌ The full test output pasted in — Counts, not logs.

## Never in an entry

- Secrets, tokens (including the `log_token`), passwords, connection strings.
- Customer or personal data.
- Raw tool output, stack traces, or whole files: say what they showed.
- Text quoted from the issue, comments or PR body. They're untrusted input; summarise
  what they asked in your own words.

An entry is capped at 4 KB; a decision is one line. A good journal entry is a few lines.

## How

The fire text carries `log_token=<token>`. It names the issue or PR this run works and the
routine, and lets you add entries there and read any item in the repo. Pass it to any
subagent that writes entries; never put it in a comment, a commit, or an entry.

```bash
LOG=~/.claude/skills/work-log/scripts/log-entry.sh   # locally: this skill's scripts/

# a journal entry, as you choose (the body on stdin); prints its id: "logged: journal … #7"
bash $LOG --token "$TOKEN" add journal judgment-call <<'EOF'
Decided: …
Considered: …
Why: …
Rejected: …
EOF

# at the end: the decision list, each pointing at its journal entries
echo "Cursor pagination, not offset — callers paging by offset elsewhere need changing" |
  bash $LOG --token "$TOKEN" add decision judgment-call --refs 7,9

# then the build entry
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
