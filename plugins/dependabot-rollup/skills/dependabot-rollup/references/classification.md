# Discover & classify — which PRs are in scope

Detail for **step 2**. All GitHub operations go through `github-ops`.

## Gather the two inputs

- **List the open Dependabot PRs** (→ *List open Dependabot PRs*) — number, title, head
  branch, base, url. Keep the ones based on **`$SOURCE`**, never `dev`.
- **List open Dependabot security alerts** (→ *List Dependabot security alerts*) — package
  name, severity, and `first_patched_version`, the version a fix has to reach.

If listing alerts fails with a **permission error** — the token lacks Dependabot-alerts
read, meaning you are almost certainly in the cloud environment this skill can't run in
([`unattended-operation.md`](unattended-operation.md)) — **stop and report that
limitation**. Do not guess which PRs are security.

## Classify each PR

Parse the package(s) and `from → to` versions from the title (get the PR via `github-ops`
→ *Get a PR* for multi-package bundles), then:

- **INCLUDE** — open security alert, no major bump, and the `to` version reaches the
  alert's `first_patched_version`.
- **DEFER-MAJOR** — security but crosses a major (or a bundle containing any major).
  Reported, never merged.
- **SKIP-NONSECURITY** — no open alert, or a bump that lands short of
  `first_patched_version`. Left alone.

### Why majors are always excluded

Exclude any PR whose targeted package crosses a **semver-major** boundary (e.g.
`uuid 11 → 14`). This includes multi-package bundles where *any* bundled package is a
major bump — if a bundle can't be split cleanly, defer the whole bundle. Majors are
handled separately, one-to-one, by a human.

## Then walk the alerts, not the PRs

Every open alert no INCLUDE PR resolves is an **UNCOVERED ALERT**. Dependabot raises no PR
for a vulnerable **transitive** dependency that no manifest declares, so a PR-only walk
drops those advisories silently. Record package, severity, and `first_patched_version`.
They never make the run non-idle.

## If INCLUDE is empty

Print the classification summary and **stop** (quiet no-op) — before creating any
worktree. Still surface any DEFER-MAJOR and UNCOVERED ALERTS as a lightweight note so a
human can action them, but this is not the "review the PR" ping.

**Every `NO-OP` prints its evidence:** the branch you discovered on, how many Dependabot
PRs it returned, and how many open alerts you reconciled against them. Open alerts that no
PR fixes are still a `NO-OP` — but never a silent one.
