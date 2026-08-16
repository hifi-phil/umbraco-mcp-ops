---
name: issue-discuss-loop
description: >-
  Label-triggered loop that thinks an issue through *before* anyone builds it. Label an issue
  `ai-discuss` and it reads the whole thread, then does one of three things: writes the issue
  properly when it's a stub, asks questions when it can't yet, or pulls an already-written
  issue apart antagonistically. Each fire posts one comment and stops; your reply fires the
  next round, so it's a real back-and-forth. The aim is consensus on the simplest, most
  surgical change that solves the problem — problem first, then testable requirements, then a
  plan that follows the code already there. Writes issues only: never code, never a PR, never
  `ready-for-ai`. Repo-agnostic; github-ops required. Trigger: an issue labelled `ai-discuss`,
  a new comment on one, or "discuss issue #N".
---

# issue-discuss-loop

The **step before `ready-for-ai`.** Every other loop assumes the issue is already good. Often it
isn't — it's a title and one line, or it's long but vague, or the direction changed halfway down
the comments. This loop fixes that by *talking*, then writes down what was agreed.

It **writes issues, not code.** No branches, no PRs, no `ready-for-ai`.

**Two references, read at the point you need them:**

| Reference | Read it when |
|---|---|
| [`references/thread-protocol.md`](references/thread-protocol.md) | Starting a fire: whose comment is whose, when to stay silent, the round cap, and whether to write the body or a comment |
| [`references/good-issues.md`](references/good-issues.md) | Composing anything: what "simplest change" means, problem → requirements → plan, writing style |

## Trigger & scope

- **The user removes `ai-discuss`, not you.** Unlike every other loop, the label here means
  *discussion is open*, not *work pending*, so it stays on until they're satisfied. The round cap
  is the only exception.
- Act on the **labelled issue only** — never wander to other issues or PRs.
- Works on **any repo**: code repos, shared-skill repos, docs, this ops repo. What changes is
  which code you read before you can say anything useful.

All GitHub work goes through the **`github-ops`** skill (required) — name the operation, never a
raw command.

## The two rules you cannot get wrong

Both are covered in full by [`thread-protocol.md`](references/thread-protocol.md); they're here
because missing either one breaks the loop rather than just degrading it.

1. **Sign every comment** with the marker on its own last line:

   ```
   <!-- issue-discuss-loop -->
   ```

   You post as the **maintainer's own account**, not as a bot, so nothing in the author fields
   tells your comment from theirs. The router skips signed comments — that's the *only* thing
   stopping you reading your own reply as a new one and answering it forever.

2. **Never answer a comment starting `//`.** That prefix means it's addressed to a colleague, not
   to you. Read it as context; stay out of it.

## Step 1 — read the thread, then the code

Follow [`thread-protocol.md`](references/thread-protocol.md): get the issue and every comment,
split them into yours / `//` / addressed-to-you, check the round count, and stop early if
there's nothing new aimed at you.

Then **read the code** the issue is about — see the "read the code before writing any of it" rule
in [`good-issues.md`](references/good-issues.md).

## Step 2 — pick one mode

One mode per fire, first match wins.

**Mode A — a new comment addressed to you → answer / change direction.** The common case once a
conversation is going. Answer the question, take the correction, or redo the plan if the direction
changed. If they've asked for something better than what's there, propose the better thing — don't
defend the old plan. Each round should end up **smaller or clearer** than the last; a growing plan
means the problem was misunderstood, so say so.

**Mode B — the issue is a stub (empty, or a title plus a line or two) → write it properly.** Two
honest outcomes:

- **Clear enough** → write the issue **into the body**. Nothing in a one-liner is worth
  preserving, so don't leave the good version buried in a comment.
- **Not clear, or there are real questions** → **ask first, write after.** Leave the body alone;
  put the questions in a comment. Write the body once the answers are settled.

**Mode C — the issue is already fully written → pull it apart.** Read it like someone who thinks
it's the wrong idea: gaps, contradictions with how the repo actually works, hidden assumptions,
crept scope, no clear "done", anything that would break something existing. Then ask the question
that matters most — **is there a smaller solution?** If there is, describe it and compare the two
honestly. Comment with the critique, **worst problem first**. If it survives cleanly, say so in a
sentence or two and stop; don't invent problems to look useful.

## Step 3 — compose it

Work in the order [`good-issues.md`](references/good-issues.md) sets out — **problem, then
testable requirements, then a plan** that names its files — in the style it describes. Argue for
the smallest change that solves the problem, every round.

## Step 4 — write it in the right place

Body or comment is [`thread-protocol.md`](references/thread-protocol.md)'s "one rule, two cases":
a **stub** gets its body replaced (nothing to lose); an **already-written** issue keeps its body
until the user asks, and the original is preserved as a comment when they do.

## Step 5 — notify, then stop

**One comment per fire** — signed — then a push notification (the `PushNotification` tool) so the
user knows it's their turn, then stop. Never sit and wait for a reply; their next comment fires
the next round.

```
#{N} discuss — 4 questions before I can plan this
#{N} discuss — critique posted, 3 gaps found (worst: no clear "done")
#{N} discuss — issue rewritten, check the two assumptions I flagged
```

Leave `ai-discuss` on the issue. The user removes it when satisfied, then adds `ready-for-ai` if
they want it built.

## Guardrails

The only writes are issue comments and the issue body (freely for a stub; on the user's
say-so when it was already written), plus the round cap's one-time label removal (see
`thread-protocol.md`). See the two rules above, `thread-protocol.md`, and `good-issues.md`
for everything else — the two guardrails below only add what those three sources don't
already cover:

- **Don't grow the issue.** Critique may say "cut this" and should flag scope creep; it must
  never bolt on features nobody asked for.
- **Re-check before acting.** If the label's gone or the issue is closed by the time you run,
  **quiet no-op**.

## Running as a routine

Both trigger paths route through the loop-dispatch Action. One issue per fire. It reads
and writes prose, so use a
capable model (Sonnet or better); the thinking is the product here. State cloud vs local in the
routine prompt. No local toolchain is needed — it never builds anything.

**Local and cloud runs are interchangeable**, because the anti-self-reply guard is the comment
marker, not the author. A hand-run session signs its comments the same way, so the edge skips them
the same way.

**The trigger only exists once the caller workflow is on the repo's default branch.** A repo
without it (plus the routine and its two secrets) can still use this skill by hand — "discuss
issue #N" — it just won't fire on its own.
