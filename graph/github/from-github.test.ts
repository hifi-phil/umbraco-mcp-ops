import { describe, expect, it } from "vitest";
import { ROUTINES } from "../constants/routines";
import { EVENTS } from "../constants/events";
import { LABELS } from "../constants/labels";
import { BOT_LOGIN, COMMENT_SIGNATURE, translate, type WebhookPayload } from "./from-github";

function payload(overrides: Partial<WebhookPayload>): WebhookPayload {
  return { action: "unknown", sender: { login: "a-human", type: "User" }, ...overrides };
}

function outcomeComment(routine: string, json: unknown): string {
  return `Update.\n\n<!-- agent-outcome:${routine} -->\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``;
}

describe("translate — issue labels", () => {
  it("issues.labeled ai-ready -> labelled_ai_ready", () => {
    expect(
      translate(payload({ action: "issues.labeled", label: { name: LABELS.AI_READY } })),
    ).toBe(EVENTS.LABELLED_AI_READY);
  });

  it("issues.labeled auto-releasing -> labelled_auto_releasing", () => {
    expect(
      translate(payload({ action: "issues.labeled", label: { name: LABELS.AUTO_RELEASING } })),
    ).toBe(EVENTS.LABELLED_AUTO_RELEASING);
  });

  it("issues.labeled ai-discussing -> labelled_ai_discussing", () => {
    expect(
      translate(payload({ action: "issues.labeled", label: { name: LABELS.AI_DISCUSSING } })),
    ).toBe(EVENTS.LABELLED_AI_DISCUSSING);
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
          label: { name: LABELS.AI_READY },
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

  it("a plain comment with no marker still yields no event — 'ai-discussing' has no reducer rules", () => {
    expect(
      translate(payload({ action: "issue_comment.created", comment: { body: "just a reply" } })),
    ).toBeNull();
  });
});

describe("translate — outcome artifacts (any loop, any marker)", () => {
  it("issue-build-loop's build_succeeded artifact -> build_succeeded", () => {
    expect(
      translate(
        payload({
          action: "issue_comment.created",
          comment: {
            body: outcomeComment(ROUTINES.ISSUE_BUILD_LOOP, {
              outcome: "build_succeeded",
              pr: 123,
            }),
          },
        }),
      ),
    ).toBe(EVENTS.BUILD_SUCCEEDED);
  });

  it("issue-build-loop's build_blocked artifact -> build_blocked", () => {
    expect(
      translate(
        payload({
          action: "issue_comment.created",
          comment: {
            body: outcomeComment(ROUTINES.ISSUE_BUILD_LOOP, {
              outcome: "build_blocked",
              reason: "CI-green cap tripped",
            }),
          },
        }),
      ),
    ).toBe(EVENTS.BUILD_BLOCKED);
  });

  it("auto-release-loop's release_blocked artifact -> release_blocked", () => {
    expect(
      translate(
        payload({
          action: "issue_comment.created",
          comment: {
            body: outcomeComment(ROUTINES.AUTO_RELEASE_LOOP, {
              outcome: "release_blocked",
              reason: "BLOCK: missing changelog entry",
            }),
          },
        }),
      ),
    ).toBe(EVENTS.RELEASE_BLOCKED);
  });

  it("auto-release-loop's release_published artifact -> release_published", () => {
    expect(
      translate(
        payload({
          action: "issue_comment.created",
          comment: {
            body: outcomeComment(ROUTINES.AUTO_RELEASE_LOOP, {
              outcome: "release_published",
              version: "18.0.0-beta3",
            }),
          },
        }),
      ),
    ).toBe(EVENTS.RELEASE_PUBLISHED);
  });

  it("is read even when posted under our own bot identity — this is not a self-trigger", () => {
    expect(
      translate(
        payload({
          action: "issue_comment.created",
          sender: { login: BOT_LOGIN, type: "Bot" },
          comment: {
            body: outcomeComment(ROUTINES.ISSUE_BUILD_LOOP, {
              outcome: "build_succeeded",
              pr: 123,
            }),
          },
        }),
      ),
    ).toBe(EVENTS.BUILD_SUCCEEDED);
  });

  it("marker present but malformed JSON -> null, not a throw", () => {
    expect(
      translate(
        payload({
          action: "issue_comment.created",
          comment: {
            body: `<!-- agent-outcome:${ROUTINES.ISSUE_BUILD_LOOP} -->\n\`\`\`json\nnot json\n\`\`\``,
          },
        }),
      ),
    ).toBeNull();
  });

  it("marker present but an unrecognised outcome shape -> null", () => {
    expect(
      translate(
        payload({
          action: "issue_comment.created",
          comment: {
            body: outcomeComment(ROUTINES.ISSUE_BUILD_LOOP, { outcome: "something_else" }),
          },
        }),
      ),
    ).toBeNull();
  });

  it("valid JSON but no marker at all -> null — this is just a normal comment", () => {
    expect(
      translate(
        payload({
          action: "issue_comment.created",
          comment: { body: '```json\n{"outcome":"build_succeeded","pr":123}\n```' },
        }),
      ),
    ).toBeNull();
  });
});

describe("translate — PR labels", () => {
  it("pull_request.labeled auto-reworking -> labelled_auto_reworking", () => {
    expect(
      translate(
        payload({ action: "pull_request.labeled", label: { name: LABELS.AUTO_REWORKING } }),
      ),
    ).toBe(EVENTS.LABELLED_AUTO_REWORKING);
  });

  it("pull_request.labeled auto-merging -> labelled_auto_merging", () => {
    expect(
      translate(
        payload({ action: "pull_request.labeled", label: { name: LABELS.AUTO_MERGING } }),
      ),
    ).toBe(EVENTS.LABELLED_AUTO_MERGING);
  });
});

describe("translate — rework push (native signal, not an outcome artifact)", () => {
  it("pull_request.synchronize -> rework_pushed unconditionally", () => {
    expect(translate(payload({ action: "pull_request.synchronize" }))).toBe(
      EVENTS.REWORK_PUSHED,
    );
  });

  it("is not identity-guarded — a push webhook can't be a self-authored write", () => {
    expect(
      translate(
        payload({ action: "pull_request.synchronize", sender: { login: BOT_LOGIN, type: "Bot" } }),
      ),
    ).toBe(EVENTS.REWORK_PUSHED);
  });
});

describe("translate — merge", () => {
  it("pull_request.closed with merged:true -> merged", () => {
    expect(
      translate(payload({ action: "pull_request.closed", pull_request: { merged: true } })),
    ).toBe(EVENTS.MERGED);
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
