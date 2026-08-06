# Applying the bumps & verifying they landed

Detail for **step 4** (apply) and **step 5** (verify). Step 5 is not optional: a clean
merge and a successful install prove nothing.

## Apply the bumps — step 4

Capture exactly what Dependabot resolved (covers direct **and** transitive deps) by
merging each INCLUDE branch, then reconcile deterministically:

```bash
for BRANCH in <each INCLUDE headRefName>; do
  git merge --no-edit "origin/$BRANCH" || {
    # Lockfile conflicts are expected when several PRs touch the same lockfile.
    # Keep OURS — the accumulating side, which holds every bump merged so far —
    # then relock against the merged manifests. NEVER --theirs: each Dependabot
    # branch is cut from the base, so its lockfile contains only its own bump,
    # and taking it wholesale silently reverts every preceding merge.
    git checkout --ours <lockfile>
    git add <lockfile>
    npm install            # reconciles the lock to the merged manifests
    git add -A && git commit --no-edit
  }
done
```

> **This is the bug that shipped a PR "fixing" eight advisories while fixing one.** With
> `--theirs`, a six-branch rollup silently reverted `shell-quote`, `fast-uri`,
> `linkify-it`, `hono` and `body-parser` to their pre-bump versions — only the
> last-merged branch survived. `npm install` does **not** repair it: the targets are
> transitive deps already satisfied by the stale lockfile, so npm has no reason to touch
> them. There is no error and no warning. Hence `--ours` + relock, and step 5.

Then reconcile the dependency tree with the ecosystem's install command (`npm install`,
`pnpm install`, `yarn`, etc.). For **non-lockfile ecosystems** (NuGet `.csproj`, Go
modules, etc.), apply the version bump to the manifest directly instead of merging — again
only if non-major.

**Where a manifest range changed**, `--ours` + relock is not enough: npm keeps the pinned
lockfile entry when the new declared range already permits the installed version. That
produces impossible combinations (observed: `wrangler` pinned at 4.90.0 under a
freshly-merged `^4.104.0` range). Run `npm update <pkg>` for those packages to realise the
range.

**Never pipe an install or build into a filter** (`npm install | tail -3`,
`… | grep -E "^added"`) — the pipeline reports the *filter's* exit status, so a failed
install reads as success. An `ERESOLVE` failure was masked exactly this way and a broken
lockfile got committed. Redirect if output is noisy, and check the exit code.

## Sanity-check locally, and fix anything that breaks here

- Use the repo's **fullest fast build**, not the narrowest — e.g. `npm run build:all`
  where it exists, not `npm run build`. A partial build leaves a stale `dist/` that makes
  snapshot tests pass locally and fail in CI on a fresh build (a false green that cost a
  CI round-trip).
- Run the **cheap integration suite** if the repo has one (e.g.
  `npm run test:integration`) on top of the build. This is not "let CI own it" pedantry:
  the one genuine regression in the run that produced this guidance was a `wrangler` bump
  that changed npm hoisting so the package landed in `template/node_modules/` instead of
  the root. Every unit suite passed; only the integration suite caught it. The full/slow
  suite still belongs to CI.

If one package is irreconcilable, drop just that package from the rollup and report it
rather than blocking the whole batch.

## Verify the bumps actually landed — step 5, mandatory

Before committing the rollup:

- For **every** targeted package, assert the **resolved** version in the lockfile is the
  expected `to` version — not the declared range, the resolved entry.
- Diff the whole lockfile against the target branch. Every changed entry should be a
  target or a direct transitive companion of one; an entry that moved *backwards* is the
  `--theirs` failure mode resurfacing.
- If any target is missing or reverted, fix it (`npm update <pkg>`, or re-merge that
  branch) and re-verify. Do **not** proceed to the PR with an unverified lockfile, and
  never list a package in the PR body that you haven't asserted.
