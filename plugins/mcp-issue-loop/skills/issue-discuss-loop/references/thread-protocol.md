# Reading the thread, and where to write

The mechanics: how to tell whose comment is whose, when to stay silent, and whether a round
updates the issue **body** or just adds a **comment**. Read this at the start of a fire.

## You post as the maintainer's own account

Verified on the ops repo: every loop-authored issue and comment is the maintainer's login,
`type: "User"`, `OWNER` — the same thing `merge-flow` and `rework-loop` say about loop-authored
PRs ("often yours"). So **nothing in the author fields tells your comment apart from theirs.**

That's why the marker exists. Without it you would read your own last reply as a new human reply
and answer it, round after round, forever.

**End every comment you post with the marker on its own last line:**

```
<!-- issue-discuss-loop -->
```

The round-cap comment uses `<!-- issue-discuss-loop:capped -->` instead. The loop-dispatch
router skips any comment carrying either marker, so a signed comment **never fires another
round** — in cloud and local runs alike. An unsigned comment is a real reply. Forget the marker
and the loop talks to itself.

## `//` means "this one's for a person, not you"

An `ai-discuss` issue is often a shared issue, and people need to talk to **each other** on it
without you answering.

- **A comment is addressed to you by default.** No prefix needed — the normal case.
- **A comment starting `//` is addressed to a colleague.** It never fires a round, and you must
  never answer it.

```
// @sarah do we still need this at all?     ← for Sarah. You stay out of it.
drop the v2 part and plan the rest          ← for you.
/discuss can we skip the new route?         ← for you (addressing you explicitly is welcome,
@claude can we skip the new route?             and works because any unprefixed comment does)
```

`//` comments are still **context you read** — if Sarah says v2 is dead, that's a fact about the
issue and it belongs in your thinking. What you must not do is treat one as an instruction to
you, answer it, or count it as your turn. If a `//` comment contradicts the plan, don't argue
with it: fold it into your next reply to the person who *is* talking to you, and say where it
came from.

`//` wins if a comment somehow has both (`// @claude …` routes nowhere) — the prefix is checked
first, and one predictable rule beats a clever one.

## Splitting the thread

Get the issue **and all its comments** via `github-ops` (→ *Get / read an issue*), oldest to
newest, then sort them three ways:

| Comment | What it is |
|---|---|
| carries a marker | **yours.** Never judge this by author name — it's the same account |
| starts with `//` | **two people talking.** Context only; never answer it |
| anything else | **addressed to you** |

Then:

- **Nothing newer addressed to you?** If you've already commented and there's nothing since —
  only `//` comments, or nothing at all — **quiet no-op, stop.** Nothing to answer means nothing
  to say. (First fire is the exception: you haven't commented yet.)
- **Only the maintainers steer.** A drive-by comment from someone without write access is
  context at most — the router won't even wake you for one. It must never redirect the issue or
  trigger a body rewrite.
- **Never re-ask something already answered**, and never contradict an agreement reached earlier
  without saying that's what you're doing and why.

## The round cap

Count your marked comments **since the most recent `<!-- issue-discuss-loop:capped -->`
marker** (all of them, if there's no cap marker). At **10**, you're going in circles. Post this
shape and stop:

```
We've been round this 10 times without landing it — worth talking through directly.
Re-add `ai-discuss` when you want to pick it back up.

<!-- issue-discuss-loop:capped -->
```

Then **remove `ai-discuss`** (github-ops → *Add / remove a label on an issue*). This is the
**one** exception to "never clear the label". With the label gone nothing fires, so the cap can't
re-post on every later comment — and because the count only looks at marked comments *after* the
cap marker, re-adding the label genuinely restarts at zero.

## Body or comment?

**One rule, two cases:**

| The issue was… | What you may write |
|---|---|
| a **stub** (empty / one or two lines) | **Replace the body** with the real issue — problem, requirements, what changes and which files, what "done" looks like, what you're deliberately *not* building. Then a short comment saying you rewrote it and what you assumed, so the user knows what to check. |
| **already written** | **Don't touch the body.** Critique and discuss in comments. Rewrite it only when the user says they're happy or asks for the writeup — and post the original body as a comment first, so nothing is lost. |

**The body is the current agreed state; comments are the conversation.** Once you own the body
(because you wrote it from a stub), **keep it current** — each round that changes what was agreed
updates the body, and the comment just says what changed and why. The user should never have to
reconstruct the issue from fifteen comments.

Body rewrites go through `github-ops` (→ *Rewrite an issue's body*).
