#!/usr/bin/env bash
#
# Pushes the current branch to the branch of the same name on origin, and nothing else:
# no force, no refspec, no deletion, no mirror, and never main or dev. It's the one push a
# loop needs (its own work branch), in a form a routine's settings can allow to run
# without asking: cloud-skill-sync allows this script and NOT `git push`, so every other
# push form still needs a person's approval, which an unattended run doesn't get.
#
#   push-branch.sh            push the current branch (sets its upstream)
#   push-branch.sh -C <dir>   the same, for the repo at <dir>
#
# On success, prints one line: the branch, the remote branch and the short SHA pushed.
# Exits non-zero, with the reason, on anything it won't do or when the push fails.
set -uo pipefail

DIR="."
if [ "${1:-}" = "-C" ]; then DIR="${2:-}"; shift 2 || true; fi
if [ "$#" -gt 0 ]; then
  echo "push-branch: takes no arguments besides -C <dir> (it pushes the current branch)" >&2
  exit 2
fi

BRANCH="$(git -C "$DIR" symbolic-ref --quiet --short HEAD 2>/dev/null)" || {
  echo "push-branch: not on a branch (detached HEAD?)" >&2
  exit 2
}
case "$BRANCH" in
  main | master | dev)
    echo "push-branch: won't push '$BRANCH': it's protected; work on a branch and open a PR" >&2
    exit 2
    ;;
esac

# Refuse rather than force: a branch that has diverged from its remote needs a person.
git -C "$DIR" push --no-force-with-lease --set-upstream origin "refs/heads/$BRANCH:refs/heads/$BRANCH" || exit $?

SHA="$(git -C "$DIR" rev-parse --short "refs/heads/$BRANCH")" || exit $?
echo "push-branch: pushed $BRANCH -> origin/$BRANCH at $SHA"
