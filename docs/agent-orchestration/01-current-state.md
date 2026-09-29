# 1. Where we are

[← Index](00-index.md) | [Next: Design principles →](02-design-principles.md)

---

We have a set of loops around the development lifecycle — create issue,
create feature from issue, rework from review, merge, release. Each one
works.

We also already have dispatch. A GitHub event fires and calls the Claude Code
routines API endpoint. That path works and is not what needs replacing.

What's missing is structure. Right now an event fires a routine whenever it
arrives, with no check on whether the issue was in a state where that made
sense. The plumbing has no opinion.

That produces three symptoms:

**Routines appear not to wake on a CI pass.** An event arrives at a moment
when nothing is listening for it, or a routine is already mid-run on that
issue. Nothing happens, and it looks like a failed trigger.

**Agents don't always add the label back.** The agent is responsible for
recording its own outcome as state. When a session ends early, or the model
just doesn't do it, the issue stalls with no signal.

**Agents don't always finish.** A dead session looks identical to a slow one.
Nothing knows a run was expected, so nothing notices when it doesn't come
back.

These aren't three separate faults. They're one cause: **nothing owns the
transitions.** The decision about what happens next is spread across trigger
wiring, prompt instructions and agent behaviour. When it fails there's no
single place to look.

The fix is small in surface area. Put the graph in one file, in code, and
make it the only thing that decides whether to fire.

```
GitHub event → [existing dispatch] → reduce(state, event) → fire or drop
```

One function in front of the fire call. Not a rebuild.

---

[Next: 02 — Design principles →](02-design-principles.md)
