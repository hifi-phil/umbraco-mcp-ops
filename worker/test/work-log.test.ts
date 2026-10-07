// The log_token and the export text (work-log.ts). The endpoints run
// against real SQLite in test/db/work-log.test.ts.
import { describe, expect, it } from "vitest";
import { exportComment, mintLogToken, verifyLogToken } from "../src/work-log";
import type { LogEntry } from "../src/db/log-entries";

const SECRET = "s3cret";
const claims = { owner: "Hifi-Phil", repo: "Umbraco-MCP-Ops", item: 412, routine: "issue-build-loop" };
const now = Date.parse("2026-10-07T10:00:00Z");

describe("the log_token", () => {
  it("round-trips its claims, owner and repo lowercased, with an expiry and its own id", async () => {
    const token = await mintLogToken(SECRET, claims, 120, now);
    expect(await verifyLogToken(SECRET, token, now)).toMatchObject({
      owner: "hifi-phil",
      repo: "umbraco-mcp-ops",
      item: 412,
      routine: "issue-build-loop",
      exp: now + 120 * 60_000,
      jti: expect.any(String),
    });
  });

  it("each fire's token has its own id (its 50-entry cap is its own)", async () => {
    const a = await verifyLogToken(SECRET, await mintLogToken(SECRET, claims, 60, now), now);
    const b = await verifyLogToken(SECRET, await mintLogToken(SECRET, claims, 60, now), now);
    expect(a!.jti).not.toBe(b!.jti);
  });

  it("refused once expired", async () => {
    const token = await mintLogToken(SECRET, claims, 60, now);
    expect(await verifyLogToken(SECRET, token, now + 60 * 60_000 + 1)).toBeNull();
  });

  it("refused under another secret, or with its claims edited (another item, say)", async () => {
    const token = await mintLogToken(SECRET, claims, 60, now);
    expect(await verifyLogToken("other", token, now)).toBeNull();
    const [, sig] = token.split(".");
    const forged = btoa(JSON.stringify({ ...claims, owner: "hifi-phil", repo: "umbraco-mcp-ops", item: 1, exp: now + 1e6, jti: "x" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await verifyLogToken(SECRET, `${forged}.${sig}`, now)).toBeNull();
  });

  it("refused when malformed", async () => {
    for (const bad of ["", "abc", "a.b.c", "!!!.???", "e30.e30"]) expect(await verifyLogToken(SECRET, bad, now), bad).toBeNull();
  });
});

describe("the export a merged PR gets", () => {
  const entry = (over: Partial<LogEntry>): LogEntry => ({
    id: 1,
    item: 412,
    kind: "journal",
    category: "judgment-call",
    refs: [],
    routine: "issue-build-loop",
    body: "Decided: cursors.\nWhy: thousands of rows.",
    created_at: "2026-10-07 10:00:00",
    ...over,
  });

  it("nothing logged: no comment", () => {
    expect(exportComment(500, [])).toBeNull();
  });

  it("the decision list first (one line each, pointing at its journal), then the build log, then the journal, quoted", () => {
    const text = exportComment(500, [
      entry({}),
      entry({ id: 2, item: 500, kind: "build", category: null, routine: "review-loop", body: "Commit: abc1234" }),
      entry({ id: 3, kind: "decision", refs: [1], body: "Cursors, not offsets — offset callers need changing" }),
    ])!;
    expect(text).toContain("📒 **Work log**");
    expect(text).toContain(
      "### Decisions (1)\n\n- **judgment-call** · Cursors, not offsets — offset callers need changing _(issue-build-loop, #412 · from journal #1)_",
    );
    expect(text).toContain("### Build log (1)");
    expect(text).toContain("**build** · review-loop · this PR ·");
    expect(text).toContain("### Journal (1)");
    expect(text).toContain("**#1 judgment-call** · issue-build-loop · #412 · 2026-10-07 10:00:00 UTC\n\n> Decided: cursors.\n> Why: thousands of rows.");
    expect(text.indexOf("Decisions")).toBeLessThan(text.indexOf("Build log"));
    expect(text.indexOf("Build log")).toBeLessThan(text.indexOf("Journal"));
  });
});
