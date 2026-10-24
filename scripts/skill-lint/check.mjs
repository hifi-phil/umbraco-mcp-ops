#!/usr/bin/env node
// Deterministic checks on skill text under plugins/, for what reviews keep finding:
// - a SKILL.md frontmatter `description` over 1024 characters (Claude Code's limit);
// - a relative Markdown link that points at a file that doesn't exist.
// Usage: node scripts/skill-lint/check.mjs [root]   (default: plugins). Exit 1 on any problem.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, normalize } from "node:path";

const root = process.argv[2] ?? "plugins";
const MAX_DESCRIPTION = 1024;

/** @param {string} dir @returns {string[]} */
function markdownFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "node_modules" ? [] : markdownFiles(p);
    return name.endsWith(".md") ? [p] : [];
  });
}

/** The frontmatter `description`, plain or a `>-`/`|` block, joined as YAML folds it.
 * @param {string} text @returns {string | null} */
function description(text) {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const lines = fm[1].split("\n");
  const i = lines.findIndex((l) => /^description:/.test(l));
  if (i < 0) return null;
  const first = lines[i].replace(/^description:\s*/, "");
  if (!/^[>|][-+]?$/.test(first)) return first.replace(/^["']|["']$/g, "");
  const block = [];
  for (const l of lines.slice(i + 1)) {
    if (!/^\s+\S/.test(l) && l.trim() !== "") break;
    block.push(l.trim());
  }
  return first.startsWith(">") ? block.join(" ").trim() : block.join("\n").trim();
}

const problems = [];
for (const file of markdownFiles(root)) {
  const text = readFileSync(file, "utf8");
  if (file.endsWith("SKILL.md")) {
    const d = description(text);
    if (d !== null && d.length > MAX_DESCRIPTION) {
      problems.push(`${file}: description is ${d.length} characters (max ${MAX_DESCRIPTION})`);
    }
  }
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const path = target.split("#")[0];
    if (!path) continue;
    if (!existsSync(normalize(join(dirname(file), path)))) problems.push(`${file}: link to ${target} doesn't resolve`);
  }
}

for (const p of problems) console.log(p);
if (problems.length) {
  console.log(`${problems.length} problem(s)`);
  process.exit(1);
}
console.log("skill lint: ok");
