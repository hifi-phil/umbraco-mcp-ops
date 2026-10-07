# The review's work log

Only when the dispatch passed a `log_token`. Load the `work-log` skill: it has the
`read` and `add` calls. A failed read or write never stops the run.

## Reading it (Step 2, after your findings are formed)

Read the work log for the issue the PR closes and for the PR: the journal, and the decision
list derived from it. Your findings are already formed, so the log can't talk you out of
seeing something. Check each finding against the journal:
- A finding that contradicts a journal entry becomes a **challenge** to it: say so in its
  comment ("challenges journal #7 (judgment-call): …"), weighing its reason and the path
  behind it. It still counts as a finding: `rework-loop` decides, with the reason in front
  of it.
- A journal entry whose reason doesn't hold up is a finding too, even with no line to point
  at.
- A journal entry that answers a finding (its reason covers it) drops that finding.
- A choice the journal shows that the decision list leaves out, and a person should know
  about: note it for *Decisions to check*.

## The build entry (Step 4, before the verdict comment)

The head SHA reviewed, the reviewers that ran, the verdict, how many findings, which journal
entries were challenged, and which you relied on to drop or shape a finding
(`Journal used: #7, #9`, or `none`).
