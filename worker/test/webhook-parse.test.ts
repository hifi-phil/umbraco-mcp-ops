import { describe, expect, it } from "vitest";
import {
  combineEventAction,
  extractItemMeta,
  extractRoutingInfo,
  toWebhookPayload,
  verifySignature,
} from "../src/webhook-parse";
import { LABELS } from "@orchestrator/graph/constants/labels";

describe("combineEventAction", () => {
  it("joins event type and action with a dot", () => {
    expect(combineEventAction("issues", "labeled")).toBe("issues.labeled");
    expect(combineEventAction("pull_request", "synchronize")).toBe("pull_request.synchronize");
  });

  it("falls back to the bare event type when action is missing", () => {
    expect(combineEventAction("check_suite", undefined)).toBe("check_suite");
  });
});

describe("extractRoutingInfo", () => {
  it("routes on issue.number for an issue event", () => {
    expect(
      extractRoutingInfo({
        repository: { name: "umbraco-mcp-ops", owner: { login: "hifi-phil" } },
        issue: { number: 412 },
      }),
    ).toEqual({ owner: "hifi-phil", repo: "umbraco-mcp-ops", issueNumbers: [412] });
  });

  it("routes on pull_request.number when there's no issue field", () => {
    expect(
      extractRoutingInfo({
        repository: { name: "umbraco-mcp-ops", owner: { login: "hifi-phil" } },
        pull_request: { number: 97 },
      }),
    ).toEqual({ owner: "hifi-phil", repo: "umbraco-mcp-ops", issueNumbers: [97] });
  });

  it("routes a check_suite on its pull_requests (it has no issue or pull_request key)", () => {
    expect(
      extractRoutingInfo({
        repository: { name: "umbraco-mcp-ops", owner: { login: "hifi-phil" } },
        check_suite: { status: "completed", pull_requests: [{ number: 163 }, { number: 170 }] },
      }),
    ).toEqual({ owner: "hifi-phil", repo: "umbraco-mcp-ops", issueNumbers: [163, 170] });
  });

  it("a check_suite with no PRs (a push to dev) -> null", () => {
    expect(
      extractRoutingInfo({
        repository: { name: "umbraco-mcp-ops", owner: { login: "hifi-phil" } },
        check_suite: { status: "completed", pull_requests: [] },
      }),
    ).toBeNull();
  });

  it("returns null when there's nothing to route on", () => {
    expect(extractRoutingInfo({ repository: { name: "x", owner: { login: "y" } } })).toBeNull();
  });

  it("returns null when the repository is missing entirely", () => {
    expect(extractRoutingInfo({ issue: { number: 412 } })).toBeNull();
  });
});

describe("toWebhookPayload", () => {
  it("maps a label webhook body into the WebhookPayload shape", () => {
    const payload = toWebhookPayload(
      {
        action: "labeled",
        sender: { login: "a-human", type: "User" },
        label: { name: LABELS.AI_READY },
      },
      "issues",
    );
    expect(payload).toEqual({
      action: "issues.labeled",
      sender: { login: "a-human", type: "User" },
      label: { name: LABELS.AI_READY },
      comment: undefined,
      review: undefined,
      pull_request: undefined,
      check_suite: undefined,
    });
  });

  it("maps a merged-PR webhook body, with its description and merge commit (for the issues it closes)", () => {
    const payload = toWebhookPayload(
      { action: "closed", pull_request: { merged: true, body: "Closes #12", merge_commit_sha: "abc123" } },
      "pull_request",
    );
    expect(payload.action).toBe("pull_request.closed");
    expect(payload.pull_request).toEqual({ merged: true, body: "Closes #12", merge_commit_sha: "abc123" });
  });

  it("maps GitHub's release event: the version from its tag (no leading v), and its page", () => {
    const payload = toWebhookPayload({ action: "published", release: { tag_name: "v2.1.0", html_url: "https://x/v2.1.0" } }, "release");
    expect(payload.action).toBe("release.published");
    expect(payload.release).toEqual({ version: "2.1.0", url: "https://x/v2.1.0" });
  });

  it("a PR with no description or merge commit -> null for each", () => {
    const payload = toWebhookPayload({ action: "closed", pull_request: { merged: false } }, "pull_request");
    expect(payload.pull_request).toEqual({ merged: false, body: null, merge_commit_sha: null });
  });

  it("maps a comment webhook body, including an empty-string body", () => {
    const payload = toWebhookPayload(
      { action: "created", comment: { body: "" } },
      "issue_comment",
    );
    expect(payload.comment).toEqual({ body: "" });
  });

  it("carries what the discussion-round gates need: author association and type, issue state, PR-or-not", () => {
    const issueComment = toWebhookPayload(
      {
        action: "created",
        comment: { body: "Option B", author_association: "OWNER", user: { type: "User" } },
        issue: { state: "open" },
      },
      "issue_comment",
    );
    expect(issueComment.comment).toEqual({ body: "Option B", author_association: "OWNER", user_type: "User" });
    expect(issueComment.issue).toEqual({ state: "open", is_pr: false });

    const prComment = toWebhookPayload(
      { action: "created", comment: { body: "x" }, issue: { state: "open", pull_request: { url: "…" } } },
      "issue_comment",
    );
    expect(prComment.issue).toEqual({ state: "open", is_pr: true });
  });
});

describe("verifySignature", () => {
  const secret = "test-webhook-secret";
  const body = '{"hello":"world"}';

  it("accepts a signature computed the same way GitHub computes it", async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const header =
      "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");

    expect(await verifySignature(secret, body, header)).toBe(true);
  });

  it("rejects a wrong signature", async () => {
    expect(await verifySignature(secret, body, "sha256=" + "0".repeat(64))).toBe(false);
  });

  it("rejects a missing signature header", async () => {
    expect(await verifySignature(secret, body, null)).toBe(false);
  });

  it("rejects a signature computed against different body text", async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("different body"));
    const header =
      "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");

    expect(await verifySignature(secret, body, header)).toBe(false);
  });
});

describe("extractItemMeta — what the dashboard's items table keeps", () => {
  it("an issue event: an issue, its title and state", () => {
    expect(extractItemMeta({ issue: { number: 7, title: "Add a thing", state: "open" } })).toEqual({ kind: "issue", title: "Add a thing", state: "open" });
  });

  it("a comment on a PR arrives as an issue with a pull_request key: a PR", () => {
    expect(extractItemMeta({ issue: { number: 7, title: "Fix", state: "open", pull_request: { url: "x" } } })).toMatchObject({ kind: "pr" });
  });

  it("a PR event: a PR; merged when it was", () => {
    expect(extractItemMeta({ pull_request: { number: 8, title: "Fix", state: "closed", merged: true } })).toEqual({ kind: "pr", title: "Fix", state: "merged" });
    expect(extractItemMeta({ pull_request: { number: 8, title: "Fix", state: "closed", merged_at: null } })).toEqual({ kind: "pr", title: "Fix", state: "closed" });
  });

  it("a merged PR seen through the issues API (a lookup, a comment): merged", () => {
    expect(extractItemMeta({ issue: { number: 7, title: "Fix", state: "closed", pull_request: { merged_at: "2026-10-03T10:00:00Z" } } })).toEqual({ kind: "pr", title: "Fix", state: "merged" });
    expect(extractItemMeta({ issue: { number: 7, title: "Fix", state: "closed", pull_request: { merged_at: null } } })).toEqual({ kind: "pr", title: "Fix", state: "closed" });
  });

  it("a check_suite names neither: nothing; an odd title or state is left out", () => {
    expect(extractItemMeta({ check_suite: { pull_requests: [{ number: 1 }] } })).toBeNull();
    expect(extractItemMeta({ issue: { number: 7, title: 42, state: "weird" } })).toEqual({ kind: "issue", title: null, state: null });
  });
});
