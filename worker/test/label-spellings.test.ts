// A label's spelling lives in one place, graph/constants/labels.ts: code and
// tests use LABELS, comments write LABELS.AUTO_MERGING (doc comments
// {@link LABELS.AUTO_MERGING}). Then a rename is a change to that file (and the skills and docs, which can't import it), not
// a grep across the TypeScript. This keeps a spelled-out label from creeping
// back in.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_LABELS } from "@orchestrator/graph/constants/labels";

const ROOT = join(__dirname, "..", "..");
const DIRS = ["graph", "worker/src", "worker/test", "e2e/driver", "e2e/stub/src", "e2e/stub/test"];
const SKIP = new Set(["graph/constants/labels.ts"]);

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name === "dist") return [];
    if (statSync(path).isDirectory()) return tsFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

// The whole label only: auto-release-loop is a routine, not the label.
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const spelled = new RegExp(`(?<![\\w])(${ALL_LABELS.map(escape).join("|")})(?![\\w-])`);

describe("label spellings", () => {
  it("no TypeScript outside labels.ts spells out a tracked label", () => {
    const hits = DIRS.flatMap((d) => tsFiles(join(ROOT, d)))
      .map((path) => relative(ROOT, path))
      .filter((path) => !SKIP.has(path))
      .flatMap((path) =>
        readFileSync(join(ROOT, path), "utf8")
          .split("\n")
          .flatMap((line, i) => (spelled.test(line) ? [`${path}:${i + 1}: ${line.trim()}`] : [])),
      );
    expect(hits, "use LABELS (or its key, in a comment)").toEqual([]);
  });
});
