#!/usr/bin/env node
// Usage: node bump.mjs <release-version> [--repo <dir>] [--dry-run]
// Sets the marketplace version and bumps each changed component. See ../SKILL.md.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const repoIdx = args.indexOf("--repo");
const repo = repoIdx >= 0 ? args[repoIdx + 1] : process.cwd();
const dry = flag("--dry-run");
const version = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--repo");

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const parse = (v) => {
  const m = SEMVER.exec(v ?? "");
  if (!m) throw new Error(`not a plain x.y.z version: ${v}`);
  return m.slice(1).map(Number);
};
const cmp = (a, b) => {
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};
const bump = (v, size) => {
  const [maj, min, pat] = parse(v);
  if (size === "major") return `${maj + 1}.0.0`;
  if (size === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
};

const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const readJson = (rel) => JSON.parse(readFileSync(join(repo, rel), "utf8"));
const writeJson = (rel, data) => {
  if (!dry) writeFileSync(join(repo, rel), JSON.stringify(data, null, 2) + "\n");
};

if (!version) {
  console.error("usage: bump.mjs <release-version> [--repo <dir>] [--dry-run]");
  process.exit(2);
}
parse(version);

const marketplacePath = ".claude-plugin/marketplace.json";
const marketplace = readJson(marketplacePath);
const previous = marketplace.metadata.version;
if (cmp(version, previous) <= 0) {
  console.error(`release ${version} is not higher than current marketplace version ${previous}`);
  process.exit(1);
}

let tag = "";
try {
  tag = git("describe", "--tags", "--abbrev=0", "--match", "v*");
} catch {
  // no release tag yet
}

const [pMaj, pMin] = parse(previous);
const [nMaj, nMin] = parse(version);
const size = nMaj > pMaj ? "major" : nMin > pMin ? "minor" : "patch";

marketplace.metadata.version = version;
console.log(`marketplace: ${previous} -> ${version} (${size})`);

if (!tag) {
  console.log("no v* tag found: first release, only the marketplace version is set");
} else {
  const changed = (folder) => git("diff", "--name-only", tag, "--", folder) !== "";
  console.log(`last release tag: ${tag}`);

  for (const entry of marketplace.plugins) {
    const folder = entry.source.replace(/^\.\//, "");
    const manifestPath = `${folder}/.claude-plugin/plugin.json`;
    if (!changed(folder)) {
      console.log(`plugin ${entry.name}: unchanged`);
      continue;
    }
    const manifest = readJson(manifestPath);
    const base = cmp(manifest.version, entry.version) >= 0 ? manifest.version : entry.version;
    const next = bump(base, size);
    manifest.version = next;
    entry.version = next;
    writeJson(manifestPath, manifest);
    console.log(`plugin ${entry.name}: ${base} -> ${next}`);
  }

  if (changed("worker")) {
    const pkg = readJson("worker/package.json");
    const next = bump(pkg.version, size);
    console.log(`worker: ${pkg.version} -> ${next}`);
    pkg.version = next;
    writeJson("worker/package.json", pkg);
    if (existsSync(join(repo, "worker/package-lock.json"))) {
      const lock = readJson("worker/package-lock.json");
      lock.version = next;
      if (lock.packages?.[""]) lock.packages[""].version = next;
      writeJson("worker/package-lock.json", lock);
    }
  } else {
    console.log("worker: unchanged");
  }
}

writeJson(marketplacePath, marketplace);
