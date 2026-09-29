# worker/

Version file: `worker/package.json` (`version`), mirrored into `worker/package-lock.json`
(top-level `version` and `packages[""].version`) when the lock exists.

Same rule as a plugin: bumped only if a file under `worker/` differs from the last `v*`
release tag, by the same size as the marketplace bump. No tag of its own; the release tag
comes from the marketplace version. Before releasing run
`cd worker && npm test && npm run typecheck`.
