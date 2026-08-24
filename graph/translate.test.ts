import { describe, expect, it } from "vitest";
import { BOT_LOGIN, COMMENT_SIGNATURE, translate, type WebhookPayload } from "./translate";

function payload(overrides: Partial<WebhookPayload>): WebhookPayload {
  return { action: "unknown", sender: { login: "a-human", type: "User" }, ...overrides };
}

describe("translate — issue labels", () => {
  it("issues.labeled ready-for-ai -> labelled_ready_for_ai", () => {
    expect(
      translate(payload({ action: "issues.labeled", label: { name: "ready-for-ai" } })),
    ).toBe("labelled_ready_for_ai");
  });

  it("issues.labeled auto-release -> labelled_auto_release", () => {
    expect(
      translate(payload({ action: "issues.labeled", label: { name: "auto-release" } })),
    ).toBe("labelled_auto_release");
  });

  it("issues.labeled ai-discuss -> labelled_ai_discuss", () => {
    expect(
      translate(payload({ action: "issues.labeled", label: { name: "ai-discuss" } })),
    ).toBe("labelled_ai_discuss");
  });

  it("issues.labeled with an unrelated label -> null", () => {
    expect(
      translate(payload({ action: "issues.labeled", label: { name: "dependencies" } })),
    ).toBeNull();
  });
});

describe("translate — self-trigger guard", () => {
  it("drops any event whose sender is our own bot identity", () => {
    expect(
      translate(
        payload({
          action: "issues.labeled",
          label: { name: "ready-for-ai" },
          sender: { login: BOT_LOGIN, type: "Bot" },
        }),
      ),
    ).toBeNull();
  });

  it("drops a comment carrying our own signature marker, even from a human-looking sender", () => {
    expect(
      translate(
        payload({
          action: "issue_comment.created",
          comment: { body: `discuss reply here\n${COMMENT_SIGNATURE}` },
        }),
      ),
    ).toBeNull();
  });

  it("a plain comment with no marker still yields no event — 'discussing' has no reducer rules", () => {
    expect(
      translate(payload({ action: "issue_comment.created", comment: { body: "just a reply" } })),
    ).toBeNull();
  });
});

describe("translate — PR labels", () => {
  it("pull_request.labeled auto-rework -> labelled_auto_rework", () => {
    expect(
      translate(payload({ action: "pull_request.labeled", label: { name: "auto-rework" } })),
    ).toBe("labelled_auto_rework");
  });

  it("pull_request.labeled auto-merge -> labelled_auto_merge", () => {
    expect(
      translate(payload({ action: "pull_request.labeled", label: { name: "auto-merge" } })),
    ).toBe("labelled_auto_merge");
  });
});

describe("translate — merge", () => {
  it("pull_request.closed with merged:true -> merged", () => {
    expect(
      translate(payload({ action: "pull_request.closed", pull_request: { merged: true } })),
    ).toBe("merged");
  });

  it("pull_request.closed with merged:false (just closed) -> null", () => {
    expect(
      translate(payload({ action: "pull_request.closed", pull_request: { merged: false } })),
    ).toBeNull();
  });
});

describe("translate — unmapped events", () => {
  it("an action with no case in the switch -> null, not a throw", () => {
    expect(translate(payload({ action: "pull_request.opened" }))).toBeNull();
  });
});
