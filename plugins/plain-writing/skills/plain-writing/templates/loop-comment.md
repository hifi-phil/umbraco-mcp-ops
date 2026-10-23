{First line — the result, stated, not led up to. Pick the shape that fits:}

**Blocked:** {the specific gate that failed — a check name, a label, a conflict —
not "something went wrong".}

**Done:** {what now exists — a merged PR number, a published version, a pushed
fix.}

**Needs a decision:** {the thing only a human can call, and why the loop didn't
just pick one.}

{Then, only what that first line didn't already say — omit any bullet with
nothing to add:}

- {What was checked, and the result — e.g. "CI: 2 checks still failing
  (`build`, `lint`)". Skip anything a label on this item already shows.}
- {What happens next — the loop will retry, is waiting on the human, or this is
  terminal and needs a manual follow-up.}
- {A link only when it points somewhere the reader can't already see from here —
  a log, a diff, a related issue.}
