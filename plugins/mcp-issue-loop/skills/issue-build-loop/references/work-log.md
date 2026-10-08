# The build's work log

Only when the dispatch passed a `log_token`. Load the `work-log` skill: it has the
templates, the categories and the `log-entry.sh` calls. A failed write never stops the run.

1. **The build subagent's journal.** Add this to its prompt, after the playbook (the one
   place it's said, for both playbooks): "Load the `work-log` skill. `log_token=<the token>`.
   Write a **journal** entry each time you choose how to do something, as you choose, with
   the options and rationale, and report their ids when you return. Not the decision list or the
   build entry: the orchestrator writes those."
2. **Your own journal.** Write journal entries for the choices you make here too, as you make
   them (how you resolved an `mcp-review` finding the reviewers disagreed on, say).
3. **The decision list, by a fresh subagent.** Once `mcp-review` is done, spawn a
   decision-list subagent on `haiku` (not the build subagent, and not on its tier: it reads
   and judges, it doesn't code; the work-log eval passes on Haiku) with the `log_token`, the
   issue, and the PR's diff. It follows the `work-log` skill's *The decision list*: it reads
   the journal, writes one **decision** line for each choice a person should know about (with
   `--refs`), adds a `(not journalled)` decision for any such choice the diff shows that
   nobody wrote down, and returns what it wrote. Don't write the list yourself: you made the
   choices, so fresh eyes judge them better.
4. **The build entry**, before the outcome comment: the commit, the local tests and their
   counts, what `mcp-review` found and fixed, and what wasn't verified.
