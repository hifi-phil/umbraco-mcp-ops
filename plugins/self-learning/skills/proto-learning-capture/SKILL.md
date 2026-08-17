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

Read [`references/proto-learning-schema.md`](references/proto-learning-schema.md)
for the actual contract: when the analyzer should and shouldn't capture, the
exact canvas row fields, and the `Guessed Home` heuristic. `capture-proto-learning.sh`
reads this same file, so it's the single source of truth for both the hook and this skill.
