# 16. The decision log and build log

[← Index](00-index.md)

---

**Status:** Plan agreed, not built. **Date:** 07-10-2026

Part 2 of the build/review split ([15-agent-splits.md](15-agent-splits.md)),
and part 4, what people see. Released with part 3 (the skills) as 2.2.0.

---


## What they are

This follows Matt Brailsford's
[umbraco-claude-playbook](https://github.com/mattbrailsford/umbraco-claude-playbook)
(`DECISION-LOG.md`, `BUILD-LOG.md` and `decision-review`, in use on
`umbraco/Umbraco.AI`). The difference is that the entries live in D1, not
in files.

Three kinds of entry (settled 07-10-2026):

| Kind | What | When | His equivalent |
|---|---|---|---|
| **Journal** | How the agent decided to do the work, and the path it took: what it decided, what it considered or tried first, why, what it rejected | Each time it chooses, as it chooses | None: his builder says this in its report, which is gone when the task ends |
| **Decision** (the decision list) | One line per choice a person should know about, derived from the journal at the end of the run, pointing back to the journal entries behind it | Once, at the end of a run | `DECISION-LOG.md`, already passed through `decision-review`'s test ("a different, equally reasonable choice existed and the outcome could plausibly matter") |
| **Build** | What each routine did and checked: the commit, the tests and counts, the review, what wasn't verified | Once, at the end of a run | `BUILD-LOG.md` |

Journal entries and decisions each carry one of his four categories:
*assumption*, *deviation*, *workaround* or *judgment call*.

**Why both a journal and a list.** The list is what a person reads; the
journal is the reasoning behind it, which a rework needs so it doesn't
undo a deliberate choice, and a reviewer needs when one line isn't enough
to judge. Whether the journal earns its cost is measured in the trial
(*Measuring the journal*, below), and if it doesn't, only the list stays.

## Why D1

- **One timeline.** `transitions` already records every label change and
  fire for an issue, with who caused it. With decisions and checks next to
  it, the dashboard can show the whole story: labelled → decided X because
  Y → tests 42/42 → review round 1 FAIL → rework → PASS.
- **No overwrites.** Every entry is its own row, so two writers can't
  overwrite each other.
- **Queryable.** "Every workaround this month" is a single query. That's
  the data Phase 10 says future splits should follow.
- **The reviewer can write.** Writing to D1 doesn't push a commit, so it
  doesn't restart CI and the review.
- **No lock-in.** It's our own schema, not something tied to GitHub.

## Who writes what

| Routine | Journal | Decision list | Build log |
|---|---|---|---|
| build | Writes as it chooses (its subagent too) | Derives it at the end | Writes its entry |
| `ai-reviewing` | Reads it, after forming its findings | Reads it; on a pass, turns it into *Decisions to check* | Writes its verdict, round and findings |
| `rework-loop` | Reads it before fixing; adds its own | Adds a line for a decision it kept or changed under challenge | Writes its entry |
| Worker | — | — | — (`transitions` is its log) |

## Measuring the journal

The Forms trial (Phase 11) decides whether the journal stays. On each PR:
- **Did you need the journal?** Each item in *Decisions to check* has its
  journal entries folded underneath, and a box: *needed the journal to
  judge this*. Ticked often: the journal earns its place.
- **Did the agents use it?** Each review and rework build entry names the
  journal entries it relied on (a challenge raised, a decision kept because
  of its reason).
- **Noise:** journal entries per build, against decisions derived from them.

Neither happening across the trial means the journal is overhead: keep the
decision list, written straight from the builder's report as Matt's loop
does, and drop the journal.

## How routines reach it

**Settled (07-10-2026): an HTTP endpoint on the Worker and a script**, not
an MCP endpoint. A cloud routine's MCP connectors are configured once per
environment, so a token issued per fire can't reach them. An HTTP call from
the session is the path the outcome hook already uses, and anything that can
make an HTTP call can write, whatever the agent harness.

- **The script**, `log-entry.sh`, ships with the `work-log` skill: `add` an
  entry, `read` an item's entries. The routine passes the token from its
  fire text.
- **Scoped tokens.** Each fire carries a short-lived token, issued by the
  Worker, for that one issue or PR and that one routine.
- **Add-only.** A token can add entries but not edit or delete them.
  Entries are capped at a few KB. A routine that has read hostile text in
  an issue or a PR comment can, at worst, add short entries to its own
  issue.
- **Best effort.** A routine never stops because the Worker can't be
  reached.

## What people see

- **Dashboard:** the merged timeline. It reads summaries, not the whole
  log, to stay within the D1 read budget.
- **PR description:** a short summary in the style of `decision-review`.
  It lists only the entries a person should look at, ranked, each with a
  recommended action.
- **Permanent copy:** when the PR merges, the Worker exports the issue's
  and the PR's entries as **one comment on the PR** (settled 07-10-2026). D1
  belongs to this deployment and `tofu destroy` removes it; a comment stays
  with the PR, and needs no commit into the repo.

Repos that already use the playbook, with a `docs/plans/<feature>/` folder,
keep their files. The routines read those as well as D1.

## The free plan is enough for now

- **Volume is small.** A few log rows per routine run is far inside the
  free plan's daily caps.
- **Size isn't the issue.** A busy issue is about 50 KB of log entries. A
  database holds 500 MB on the free plan, 10 GB on paid.
- **Watch the read cap.** Since 01-09-2026 the free plan fails D1 queries
  outright once a daily cap is hit, which would stop the orchestrator, not
  just the logs. The dashboard already reads summaries to stay well clear.
- **When to go paid:** if daily usage starts getting close to a cap, for
  example once the umbraco repos bring real traffic. Workers Paid is an
  account plan: it covers the Worker, the Durable Objects and D1 together.

## Plan (part 2, and part 4 after it)

Released together as 2.2.0, with part 3 (the skills), so the split ships
whole. Each step is its own PR, in this order.

**1. The guide: a `work-log` skill** (`plugins/agent-outcomes/skills/work-log/`,
shipped to routines by `cloud-skill-sync`). Written first: the review's
challenge step only works if journal entries are specific.
- **When to write:** a journal entry each time the agent chooses how to
  do something, written then, with the path it took (no entry for a step
  with no real alternative); the decision list and one build entry at the
  end of each run. Nothing else.
- **A template for each kind.**
  - *Journal:* category; **Decided** (one line); **Considered** (the
    options weighed, what was tried first and how it went); **Why** (tied to
    the code or the issue); **Rejected** (the alternative, and why not).
  - *Decision:* category; one line, "what was decided — why it matters";
    the journal entries behind it.
  - *Build:* routine; **Commit**; **Tests** (suite, run, passed);
    **Review** (what was found, what was fixed); **Not verified** (and why).
- **The four categories**, each with a one-line test for when it applies:
  *assumption* (the issue didn't say; this was assumed), *deviation* (the
  issue or a convention said X; this does Y), *workaround* (the right fix
  wasn't possible here; this gets around it), *judgment call* (several
  sound options; this one was picked).
- **Good and bad examples** for each category, for the decision list and
  for a build entry.
- **Never in an entry:** secrets, tokens, customer data, raw tool output,
  or text quoted from the issue or comments (untrusted: summarise it).
- **How:** the `log-entry.sh` calls, and that a failed write never stops
  the run.

**2. The Worker side.**
- **D1 migration `0010_log_entries`: one table**, `log_entries`: `id`,
  `owner`, `repo`, `item` (issue or PR number), `kind` (`journal`,
  `decision` or `build`), `category` (journal and decisions), `refs` (a
  decision's journal entries), `routine`, `body` (capped at 4 KB; a
  decision is one line), `created_at`. Indexed on (`owner`, `repo`,
  `item`, `created_at`).
  One table keeps an item's timeline a single query.
- **The token:** when the Worker fires a routine it adds `log_token=…` to
  the fire text: an HMAC over owner, repo, item, routine and an expiry
  (twice the routine's watchdog), signed with `ROUTINE_SIGNAL_SECRET`, so
  no new secret.
- **`POST /log`** (bearer: the token): adds one entry to the token's item
  only. At most 50 entries per token.
- **`GET /log?item=<n>`** (bearer: the token): an item's entries, for any
  item in the token's repo. The review reads the issue's journal and
  decisions with a token for the PR.
- **The export:** when a PR merges, the Worker posts its entries, and those
  of the issues it closes, as one comment on the PR: the decisions first,
  then the build log, then the journal.
- Unit tests for the token, both endpoints, the caps and the export.

**3. The skills use it.**
- `issue-build-loop`: a journal entry as it chooses (its build subagent
  too), then at the end the decision list and a build entry.
- `review-loop`: forms its findings first, then reads the issue's and the
  PR's journal, turns a contradicting finding into a challenge
  ("challenges journal #7: …"), and writes its build entry, naming the
  journal entries it relied on.
- `rework-loop`: reads the journal before fixing, writes its own journal
  entries, a decision for any challenged choice it kept or changed, and a
  build entry naming the journal entries it relied on.
- `cloud-skill-sync`: ships `work-log`; `VERSION` bump.

**4. e2e.** The stub writes a journal entry, a decision pointing at it and
a build entry on each build, and a scenario checks all three in the export
comment.

**5. Part 4, what people see.**
- **PR description:** on a pass, `review-loop` adds a short *Decisions to
  check* section to the PR's description, in the style of
  `decision-review`, from the decision list: ranked, each with a recommended
  action, its journal entries folded underneath, and a *needed the journal
  to judge this* box (*Measuring the journal*, above).
- **Dashboard:** each row shows its counts (decisions, journal entries,
  build entries); opening an item shows its log beside `transitions`. Only an opened item reads its log, to stay inside the D1 read
  budget.

Then release 2.2.0, re-save the cloud environment, and run the e2e suite.

---

[← Index](00-index.md)
