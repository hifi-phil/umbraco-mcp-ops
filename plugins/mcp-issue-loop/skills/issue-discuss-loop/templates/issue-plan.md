# {One-line title — the change, not the symptom}

## Problem

{What's actually wrong or actually missing. Who hits it, and when. If the stated problem is
a symptom, say what the underlying cause is and which one this issue fixes.}

## Requirements

- {Short, concrete, testable — checkable by a test or by looking at the thing, not a goal.}
- {Settle edge cases and failure behaviour here, not in the plan.}

**Out of scope:** {named explicitly — what this issue deliberately does not cover.}

## Plan

{The smallest, most surgical change. Follows the existing pattern; one concern per change.}

- **Files:** {the actual files/functions this touches — enough that work can start straight
  from this list.}
- **Approach:** {what changes and why this shape, in a sentence or two — not a walkthrough
  of the code.}
- **Tested by:** {which test proves it, and which existing test would have caught the bug if
  one exists.}

{Drop a line below only if it applies — don't pad the plan with "N/A":}

- **New dependency:** {name it and say why nothing already in the repo does the job.}
- **Convention conflict:** {a repo convention this plan can't follow, and why.}
