# The rework's work log

Only when the dispatch passed a `log_token`. Load the `work-log` skill: it has the
templates, the categories and the `log-entry.sh` calls. A failed read or write never stops
the run.

## Before changing anything (Step 1)

Read the journal for the PR and the issue it closes. A finding that challenges a journal
entry is a choice between two reasoned positions: keep the choice (reply on the thread with
its reason) or change it. Either way, write a **journal** entry of your own with the path you
took, and a **decision** line for it with `--refs` to both entries: a challenged choice is
always one a person should know about.

## After pushing (Step 4)

- A **journal** entry for each choice you made fixing it, as you made it.
- A **decision** line for any a person should know about.
- One **build** entry: the commit, the tests and counts, which findings were fixed or
  answered, which journal entries you relied on (`Journal used: #7`, or `none`), and what
  wasn't verified.
