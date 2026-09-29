# Marketplace

`.claude-plugin/marketplace.json` → `metadata.version` is the repo's release version. It is
always set to the version from the issue title and must be higher than the current one.

The size of that step (patch, minor or major, compared with the previous value) is the size
every changed component gets — see `plugins.md` and `worker.md`.

The release tag is `v<marketplace version>`.
