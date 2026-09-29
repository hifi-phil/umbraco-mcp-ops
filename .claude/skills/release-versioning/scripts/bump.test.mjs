// Run: node .claude/skills/release-versioning/scripts/bump.test.mjs
// Builds a throwaway git repo with a tag and checks bump.mjs against it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "bump.mjs");
const repo = mkdtempSync(join(tmpdir(), "bump-test-"));
const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
const put = (rel, data) => {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n");
};
const get = (rel) => JSON.parse(readFileSync(join(repo, rel), "utf8"));
const run = (v) => execFileSync("node", [script, v, "--repo", repo], { encoding: "utf8" });

const plugin = (name, mkt, own = mkt) => {
  put(`plugins/${name}/.claude-plugin/plugin.json`, { name, version: own });
  return { name, source: `./plugins/${name}`, version: mkt };
};
put(".claude-plugin/marketplace.json", {
  metadata: { version: "1.0.0" },
  plugins: [plugin("changed", "1.0.0"), plugin("still", "1.0.0"), plugin("drift", "1.2.0", "1.3.0"), plugin("drift-still", "1.2.0", "1.3.0")],
});
put("worker/package.json", { name: "worker", version: "0.1.0" });
git("init", "-q");
git("config", "user.email", "t@t");
git("config", "user.name", "t");
git("add", "-A");
git("commit", "-qm", "init");

// first release: no tag, only the marketplace changes
run("1.0.1");
assert.equal(get(".claude-plugin/marketplace.json").metadata.version, "1.0.1");
assert.equal(get("plugins/drift/.claude-plugin/plugin.json").version, "1.3.0");
assert.equal(get(".claude-plugin/marketplace.json").plugins[2].version, "1.2.0");
git("add", "-A");
git("commit", "-qm", "release 1.0.1");
// tag a commit that is not an ancestor of the release branch (as with main vs squash-merged dev)
const branch = git("rev-parse", "--abbrev-ref", "HEAD").trim();
git("checkout", "-q", "-b", "side");
git("commit", "-q", "--allow-empty", "-m", "tagged on main");
git("tag", "v1.0.1");
git("checkout", "-q", branch);

// change one plain plugin, one drifted plugin and worker/, then a minor release
put("plugins/changed/README.md", "x");
put("plugins/drift/README.md", "x");
put("worker/src.txt", "x");
git("add", "-A");
git("commit", "-qm", "changes");
run("1.1.0");

const mkt = get(".claude-plugin/marketplace.json");
const entry = (n) => mkt.plugins.find((p) => p.name === n).version;
const own = (n) => get(`plugins/${n}/.claude-plugin/plugin.json`).version;
assert.equal(mkt.metadata.version, "1.1.0");
assert.deepEqual([entry("changed"), own("changed")], ["1.1.0", "1.1.0"]);
assert.deepEqual([entry("still"), own("still")], ["1.0.0", "1.0.0"]);
assert.deepEqual([entry("drift"), own("drift")], ["1.4.0", "1.4.0"]);
assert.deepEqual([entry("drift-still"), own("drift-still")], ["1.2.0", "1.3.0"]);
assert.equal(get("worker/package.json").version, "0.2.0");

// a lower version is rejected
assert.throws(() => run("1.0.0"));
console.log("ok");
