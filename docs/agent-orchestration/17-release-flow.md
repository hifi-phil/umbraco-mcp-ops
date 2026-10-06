# 17. The release flow

[← Index](00-index.md)

---

**Status:** Built, released in 2.1.0 (06-10-2026). **Date:** 06-10-2026

How an orchestrated release runs: before (an agent prepares and reviews),
the merge (the Worker, as its GitHub App), after (a small agent publishes).
The second split in [15-agent-splits.md](15-agent-splits.md), where the
reasoning for splitting is.

---


Most of `auto-release-loop` (229 lines, seven steps) is mechanical work
done by an agent, and the end of the run is where it loses track.

| Before (🤖 `auto-release-loop`) | Plain code | After (🤖 `release-publish`) |
|---|---|---|
| Prepare: cut `release/<version>`, bump the version, write the changelog, open the PR | Merge to `main` (the Worker, as the App) | Wait for the tag |
| Fix CI | Tag and GitHub Release (the repo's `release-tag.yml`) | Post the release note |
| Pre-publish review (`release-reviewer`, a read-only sub-agent; it can block) | Close the issue, hand off `released` (the Worker) | Merge `main` back into `dev` |

**Settled (06-10-2026): before, merge, after.** Project knowledge stays in
skills (composable and swappable, shared across the MCP repos rather than
copied into each one); the orchestrator holds no project conventions, and
only does what's the same for every project: the merge, as its GitHub App.

| Part | Who | What | Project-specific? |
|---|---|---|---|
| **Before** | 🤖 `auto-release-loop` | prepare, CI green, pre-publish review → `release_approved` (PR, reviewed commit, version, merge method) | yes, through the skills it composes |
| **Merge** | ⚙ the Worker, as the App | merges the way the approval says (`merge`, `squash` or `rebase`), pinned to the reviewed commit | no: the project's choice arrives as data |
| **After** | 🤖 `release-publish` (skinny) | waits for the repo's tag, posts the release note, merges `main` back into `dev` → `release_published` (version, tag) | yes: a repo's `CLAUDE.md` can name its own publish skill |

- **Tagging** (and the GitHub Release, and publishing packages) stays with
  each repo's own GitHub Actions; neither agent ever tags.
- **The Worker checks only what's universal:** the approval comes from its
  own App or someone with write access, and the merge is pinned to the
  reviewed commit (GitHub enforces it). No branch names, no tag format: the
  tag comes in `release_published`, as the repo named it.
- **A refused merge** is handled like a block (label off, with the reason);
  a PR already merged at the reviewed commit (a redelivery) counts as done.
- **The after part is fired by the Worker** straight after its own merge
  (`release_merged`), watched for 30 minutes. In orchestrated mode the
  release PR says "Part of #N", not "Closes #N": on the default branch
  "Closes" would close the issue at the merge, before `release-publish` ran.
- `release_published` closes the release issue and hands `released`, with
  the tag, to the issues waiting for it.

## The release, end to end

Two agents, each one Claude session (the 🤖 boxes): `auto-release-loop`
(before), which starts when the Worker fires it and ends when it reports
`release_approved` or `release_blocked`, with `release-reviewer`, a
read-only sub-agent inside it that only judges; and `release-publish`
(after), small, fired by the Worker once it has merged. Everything else is
deterministic: the Worker and the repo's own GitHub Actions. If either
session never reports, the watchdog moves the issue to `ai-stuck`.

```mermaid
flowchart TD
    P["👤 <b>Person</b><br/>opens <i>release 2.1.0</i>, adds the label<br/>🏷 auto-releasing"]
    W1["⚙ <b>Worker</b><br/>fires auto-release-loop,<br/>starts a 60-min watchdog<br/>🏷 auto-releasing"]

    subgraph BEFORE["🤖 BEFORE: auto-release-loop (one Claude session)"]
        A1["1. cut release/2.1.0 from dev"]
        A2["2. bump versions + changelog,<br/>open PR release/2.1.0 → main<br/>(Part of #N)"]
        A3["3. get CI green<br/>(fixes failures itself, up to 8 tries)"]
        A4{"4. pre-publish review<br/>release-reviewer<br/>(a read-only sub-agent)"}
        A1 --> A2 --> A3 --> A4
    end

    WS["⚙ <b>Worker</b> (watchdog)<br/>no report back in time<br/>🏷 ai-stuck"]
    WB["⚙ <b>Worker</b><br/>removes the label<br/>🏷 (none)"]
    W2["⚙ <b>Worker</b>, as the App<br/>checks: trusted author?<br/>merges the PR the way the approval says,<br/>pinned to the reviewed commit<br/>🏷 auto-releasing"]
    WR["⚙ <b>Worker</b><br/>label off, 🛑 comment why<br/>🏷 (none)"]
    W3["⚙ <b>Worker</b><br/>fires release-publish,<br/>starts a 30-min watchdog<br/>🏷 auto-releasing"]
    G["⚙ <b>GitHub Actions</b> (the repo's own)<br/>tags the merge, publishes the Release<br/>(packages publish from it)"]

    subgraph AFTER["🤖 AFTER: release-publish (small Claude session)"]
        B1["1. wait for the repo's tag"]
        B2["2. post the release note"]
        B3["3. merge main back into dev"]
        B1 --> B2 --> B3
    end

    W4["⚙ <b>Worker</b>, on release_published<br/>closes the release issue<br/>closes every ready-for-release issue<br/>whose merge is in the reported tag<br/>🏷 closed"]

    P --> W1 --> BEFORE
    A4 -- "BLOCK: posts release_blocked" --> WB
    A4 -- "PASS: posts release_approved<br/>(PR, commit, version, merge method)" --> W2
    BEFORE -. "never reports back" .-> WS
    W2 -- "refused (pushed to after the review)" --> WR
    W2 -- merged --> W3 --> AFTER
    W2 -. "push to main" .-> G -. "the tag" .-> B1
    B3 -- "posts release_published (version, tag)" --> W4
    AFTER -. "never reports back" .-> WS

    classDef agent fill:#ece8fb,stroke:#7b6fd6,color:#222
    classDef det fill:#eef6ee,stroke:#5a9a5a,color:#222
    classDef person fill:#fff6e0,stroke:#c9a227,color:#222
    class A1,A2,A3,A4,B1,B2,B3 agent
    class W1,WS,WB,W2,WR,W3,G,W4 det
    class P person
```

## The labels along the way

```mermaid
stateDiagram-v2
    direction LR

    state "Release issue" as Rel {
        [*] --> auto_releasing: a person adds the label
        auto_releasing --> ai_stuck: an agent never reports (watchdog)
        auto_releasing --> no_label: blocked, or the merge refused
        auto_releasing --> closed_r: release-publish reports
        closed_r --> [*]

        auto_releasing: auto-releasing
        ai_stuck: ai-stuck
        no_label: (no label)
        closed_r: closed
    }

    state "A feature issue it ships" as Feat {
        [*] --> ai_ready: a person adds the label
        ai_ready --> pr_open: the build opens its PR
        pr_open --> ready_for_release: the PR merges into dev
        ready_for_release --> closed_f: a release containing the merge
        closed_f --> [*]

        ai_ready: ai-ready
        pr_open: pr-open
        ready_for_release: ready-for-release
        closed_f: closed
    }
```

The release PR itself carries no tracked label: the Worker merges it
directly.

---

[← Index](00-index.md)
