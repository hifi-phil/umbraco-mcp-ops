// The issues a PR's description closes: GitHub's closing keywords followed
// by `#N` (close, closes, closed, fix, fixes, fixed, resolve, resolves,
// resolved, any case, an optional colon). Read here, not from GitHub's own
// linked-issues field, which GitHub only fills for PRs into the default
// branch; ours merge into dev. Same-repo references only: `owner/repo#N`
// names another repo's issue and is left alone.

const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s+(?<![\w/])#(\d+)\b/gi;

export function closingIssues(body: string | null | undefined): number[] {
  if (!body) return [];
  const found = new Set<number>();
  for (const m of body.matchAll(CLOSING)) found.add(Number(m[1]));
  return [...found];
}
