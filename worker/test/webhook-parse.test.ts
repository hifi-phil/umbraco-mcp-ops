import { describe, expect, it } from "vitest";
import {
  combineEventAction,
  extractRoutingInfo,
  toWebhookPayload,
  verifySignature,
} from "../src/webhook-parse";

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
    ).toEqual({ owner: "hifi-phil", repo: "umbraco-mcp-ops", issueNumber: 412 });
  });

  it("routes on pull_request.number when there's no issue field", () => {
    expect(
      extractRoutingInfo({
        repository: { name: "umbraco-mcp-ops", owner: { login: "hifi-phil" } },
        pull_request: { number: 97 },
      }),
    ).toEqual({ owner: "hifi-phil", repo: "umbraco-mcp-ops", issueNumber: 97 });
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
        label: { name: "ai-ready" },
      },
      "issues",
    );
    expect(payload).toEqual({
      action: "issues.labeled",
      sender: { login: "a-human", type: "User" },
      label: { name: "ai-ready" },
      comment: undefined,
      review: undefined,
      pull_request: undefined,
      check_suite: undefined,
    });
  });

  it("maps a merged-PR webhook body", () => {
    const payload = toWebhookPayload(
      { action: "closed", pull_request: { merged: true } },
      "pull_request",
    );
    expect(payload.action).toBe("pull_request.closed");
    expect(payload.pull_request).toEqual({ merged: true });
  });

  it("maps a comment webhook body, including an empty-string body", () => {
    const payload = toWebhookPayload(
      { action: "created", comment: { body: "" } },
      "issue_comment",
    );
    expect(payload.comment).toEqual({ body: "" });
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
