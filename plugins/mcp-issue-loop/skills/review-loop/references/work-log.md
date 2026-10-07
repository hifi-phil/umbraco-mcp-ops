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

## Decisions to check (Step 4, on a pass)

Add a **Decisions to check** section to the end of the PR's description (github-ops →
*Update a PR's body*; replace the section if one is already there). It's for the person who
reviews next, in the style of `decision-review`, built from the decision list (plus any
choice you noted that the list left out):
- Only what a person should look at: an `assumption` or `deviation` always, a `workaround`
  that leaves debt, a `judgment-call` with a real alternative. Not the rest.
- Ranked, most consequential first; at most five.
- Each item: the decision's line, its category, and a recommended action ("confirm the
  issue meant X", "accept", "open a follow-up for Y"); under it, its journal entries in a
  folded `<details>` (summarised, not quoted), and one checkbox: `- [ ] needed the journal
  to judge this`. The ticks are how the trial measures whether the journal earns its place
  (`16-work-log.md`, *Measuring the journal*): never tick them yourself.
- None worth a look: one line saying the logged decisions need no action.
