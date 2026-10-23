---
name: plain-writing
description: >-
  How to write anything a loop posts for a human to read: issue comments (discussion,
  status, blockers), PR bodies, PR review comments, and Slack messages. Lead with the
  point, plain words, concise without losing the names/numbers/conditions a reader
  needs, and no restating what a label, diff, or table already shows. Use whenever a
  skill composes prose for a human on GitHub or Slack. Not for commit messages, code
  comments, or the machine-readable agent-outcome JSON trailer — see `agent-outcomes`
  for that.
---

# Plain writing

## Why

A maintainer following this repo's loops reads dozens of comments a week, across
several repos, almost always switching in cold from something else. They are not
reading your reasoning — they're deciding, in a few seconds, whether this item needs
them right now. A comment that takes twice as long to parse costs that on every
read, by every reader. A comment that's short but vague costs more: now they have to
go open the PR or the logs to find what it left out.

The goal is the shortest comment that still leaves the reader able to act without a
follow-up question.

## Lead with the point

- First sentence: the thing that matters — the blocker, the decision, the result.
  Not "I looked into this and..." — what happened.
- A comment should make sense to someone who reads only its first line and the bold
  bits. If the real content is in paragraph three, move it to the top.
- No preamble, no restating the issue/PR title back at the reader, no closing summary
  that repeats the comment above it.

## Plain words, short sentences

- Write it the way you'd explain it to the maintainer in Slack, not the way you'd
  write a design doc. Short sentences, active voice ("the gate blocked the merge
  because CI failed", not "the merge was blocked due to CI failure").
- A real name is fine — a check name, a label, a file path, an error string — but
  don't invent a label of your own (don't call something "a readiness issue" when
  you mean "CI is red").
- One idea per sentence, one topic per bullet.

## Concise is not vague

Cutting words must never cut what the reader needs to act. Keep:

- **Names**: the exact label, check, file, setting, or PR/issue number — not "the
  relevant check" or "that PR".
- **Numbers**: the count, the age, the attempt number — not "a few" or "recently".
- **Conditions**: what you checked and what you didn't ("CI green, not yet
  reviewed" — not "mostly ready").
- **The why** behind anything you decided not to do, so nobody re-litigates it from
  scratch.

Cut instead: hedging ("it might be worth considering"), restating what the loop's
own structure already shows (don't narrate a label swap you just made — the label
*is* the signal), and anything the reader could get faster from the diff or the
check run than from your prose.

## Let the artifact carry what it shows

Most loop comments sit next to something that already carries structured
information: a label, a diff, a check-run list, an `agent-outcome` JSON trailer, a
`decision-review`-style verdict. Don't re-describe it in prose — say only what it
can't show:

- **why**, when the artifact only shows **what** (a label swap doesn't say why; the
  comment does)
- what you checked and what you didn't, when a pass/fail list doesn't say that
- what happens next, and whether the reader needs to do anything

## Shape for scanning

- Bullets for parallel items (gates checked, files changed); prose for one idea that
  needs a sentence of context.
- Bold the one phrase a skimming reader must not miss — the verdict, the blocker,
  the number. Bold sparingly; everything bold is nothing bold.
- A multi-gate check (merge-flow, release checks) reads better as a short list of
  gate: status than as a paragraph.

## Templates

Two starting shapes live in `templates/` — a frame to adapt, not a form to fill in
blank-for-blank. Drop a section that doesn't apply rather than writing "N/A".

- **`templates/pr-body.md`** — for a skill opening or updating a PR with no
  format of its own already. Why / what changed / how to verify / risk.
- **`templates/loop-comment.md`** — for a status, blocker, or decision comment a
  loop posts on an issue or PR mid-run. One line that states the result, then only
  the detail that line didn't already cover.

If the skill calling this already owns a specific format — `open-work-report`'s
Slack digest, `agent-outcomes`'s JSON trailer, `pr-describe`-style diagrams a skill
defines for itself — follow that format's own rules for structure, and bring the
prose principles above to whatever free text sits inside it.

## Before posting

1. Could the reader act on this without opening anything else? If not, something
   specific — a name, a number, a next step — is missing.
2. Is there a sentence that, deleted, would lose nothing? Delete it.
3. Does anything here just restate a label, a diff, or a JSON trailer sitting next
   to it?
