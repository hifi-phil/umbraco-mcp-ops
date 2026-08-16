---
name: proto-learning-capture
description: >-
  The capture half of the self-learning system — reference for what the
  SubagentStop/SessionEnd hooks do and the proto-learning schema (row shape)
  they write to the shared "MCP Loop Learnings" Slack canvas. Capture is
  hook-driven and fully automatic, covering every loop in this repo (not
  named or enumerated — the hooks match on shared conventions like
  github-ops/`/goal`). Separate from `triage-learnings` (Loop B), which runs
  on a schedule to route what's captured — capture only ever writes rows,
  never routes or fixes anything. Trigger on "how does capture work", "what
  gets captured", "proto-learning schema", or when investigating the
  self-learning system's capture half specifically.
---

# proto-learning-capture

The **capture half** of the self-learning system. Not run on demand — it's
hook-driven — but worth understanding on its own, separate from
[`triage-learnings`](../triage-learnings/SKILL.md) (the **triage half**, run
on a schedule). The actual mechanism (hooks, analyzer prompts) lives in
[`../../hooks/`](../../hooks/); this skill is the reference for what it does
and the row shape it writes.

## What happens

After any loop run in this repo — any of them; the hooks match on shared
conventions (`github-ops`, `/goal`), not an enumerated list — an analyzer
reads the finished transcript and decides whether something's worth
recording: a CI failure diagnosed, a repeated mistake, a repo gotcha, a
cross-repo pattern, a blocker. If so, it appends one row to the shared **"MCP
Loop Learnings" Slack canvas** (`F0BQ31E4R8F`, in `#mcp-ops-learning`) — the
row shape is the [proto-learning schema](references/proto-learning-schema.md).

## Where this ends

Capture only ever writes rows; it never routes or fixes anything. Rows sit at
`Status = New` until `triage-learnings` (Loop B) — a **separate skill**, run
weekly — reads, dedupes, and routes them.
