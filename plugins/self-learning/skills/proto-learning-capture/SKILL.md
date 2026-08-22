---
name: proto-learning-capture
description: >-
  The capture half of the self-learning system — reference for what gets
  captured and the proto-learning schema (row shape) written to the shared
  "MCP Loop Learnings" Slack canvas. Capture itself is hook-driven and fully
  automatic — this skill is the reference for how it works, not a way to
  file a learning by hand. Separate from `triage-learnings` (Loop B), which
  runs weekly to route what's captured. Trigger on "how does capture work",
  "what gets captured", "proto-learning schema", "why wasn't a learning
  captured", "the capture hook didn't fire", or any question about the
  SubagentStop/SessionEnd capture hooks or the "MCP Loop Learnings" canvas
  rows — including when the user is debugging a missing capture rather than
  asking about the schema by name.
---

# proto-learning-capture

The **capture half** of the self-learning system — hook-driven, not run on
demand. The mechanism (hooks, analyzer prompts) lives in
[`../../hooks/`](../../hooks/); see [`triage-learnings`](../triage-learnings/SKILL.md)
for the **triage half**, run weekly.

## What happens

After any loop run in this repo — any of them; the hooks match on shared
conventions (`github-ops`, `/goal`), not an enumerated list — an analyzer
reads the finished transcript and, per the
[proto-learning schema](references/proto-learning-schema.md)'s when-to-capture
categories, decides whether something's worth recording. If so, it appends
one row to the shared canvas per that same schema.

## The analyzer runs isolated from the loop

The analyzer is a nested `claude` invocation, so it would otherwise inherit the
env vars that bind a process to the invoking session's inbound message channel
(the runner's messaging socket + token, the session ingress token file, the
session ids). When it did, a live event meant for the loop — a CI webhook, or
the loop's own self-scheduled `send_later` check-in — could be delivered into
the analyzer's turn instead, once starving a loop's check-in and stalling a
release. `capture-proto-learning.sh` now strips those vars and spawns the
analyzer detached, in its own process session, so it is unaddressable and
outlives the loop session's teardown.

Debugging note: the hook returns before the analyzer does, so a capture appears
in `~/.cache/self-learning/capture.log` (or `$SELF_LEARNING_LOG`) some time
after the session ends, not at the moment the hook fires.

Read [`references/proto-learning-schema.md`](references/proto-learning-schema.md)
for the actual contract: when the analyzer should and shouldn't capture, the
exact canvas row fields, and the `Guessed Home` heuristic. `capture-proto-learning.sh`
reads this same file, so it's the single source of truth for both the hook and this skill.
