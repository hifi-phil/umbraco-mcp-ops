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
  it("issues.labeled ready-for-ai -> labelled_ai_ready", () => {
    expect(
      translate(payload({ action: "issues.labeled", label: { name: LABELS.AI_READY } })),
    ).toBe(EVENTS.LABELLED_AI_READY);
  });

  it("issues.labeled auto-release -> labelled_auto_releasing", () => {
    expect(
      translate(payload({ action: "issues.labeled", label: { name: LABELS.AUTO_RELEASING } })),
    ).toBe(EVENTS.LABELLED_AUTO_RELEASING);
  });

  it("issues.labeled ai-discuss -> labelled_ai_discussing", () => {
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

  it("a plain comment with no marker still yields no event — 'ai-discuss' has no reducer rules", () => {
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
  it("pull_request.labeled auto-rework -> labelled_auto_reworking", () => {
    expect(
      translate(
        payload({ action: "pull_request.labeled", label: { name: LABELS.AUTO_REWORKING } }),
      ),
    ).toBe(EVENTS.LABELLED_AUTO_REWORKING);
  });

  it("pull_request.labeled auto-merge -> labelled_auto_merging", () => {
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

describe("translate — a loop's own label swap (native completion signal)", () => {
  it("issues.labeled generated-by-ai / ai-blocked -> build_succeeded / build_blocked", () => {
    expect(translate(payload({ action: "issues.labeled", label: { name: LABELS.AI_GENERATED } }))).toBe(EVENTS.BUILD_SUCCEEDED);
    expect(translate(payload({ action: "issues.labeled", label: { name: LABELS.AI_BLOCKED } }))).toBe(EVENTS.BUILD_BLOCKED);
  });

  it("removing a trigger label -> unlabelled_*, issues and PRs", () => {
    expect(translate(payload({ action: "issues.unlabeled", label: { name: LABELS.AI_READY } }))).toBe(EVENTS.UNLABELLED_AI_READY);
    expect(translate(payload({ action: "issues.unlabeled", label: { name: LABELS.AUTO_RELEASING } }))).toBe(
      EVENTS.UNLABELLED_AUTO_RELEASING,
    );
    expect(translate(payload({ action: "pull_request.unlabeled", label: { name: LABELS.AUTO_REWORKING } }))).toBe(
      EVENTS.UNLABELLED_AUTO_REWORKING,
    );
    expect(translate(payload({ action: "pull_request.unlabeled", label: { name: LABELS.AUTO_MERGING } }))).toBe(
      EVENTS.UNLABELLED_AUTO_MERGING,
    );
    expect(translate(payload({ action: "issues.unlabeled", label: { name: "bug" } }))).toBeNull();
  });

  it("the guard uses the bot login it's given (the Worker's App), and only that one", () => {
    const added = (login: string) =>
      payload({ action: "pull_request.labeled", label: { name: LABELS.AUTO_REWORKING }, sender: { login, type: "Bot" } });
    const app = { botLogin: "hifi-agent-orchestrator[bot]" };
    expect(translate(added("hifi-agent-orchestrator[bot]"), app), "the App's own label add").toBeNull();
    expect(translate(added("someone-else[bot]"), app)).toBe(EVENTS.LABELLED_AUTO_REWORKING);
    expect(translate(added("hifi-agent-orchestrator[bot]")), "no login passed: not ours").toBe(EVENTS.LABELLED_AUTO_REWORKING);
  });

  it("our own bot removing a label is not an event (self-trigger guard)", () => {
    expect(
      translate(
        payload({ action: "issues.unlabeled", label: { name: LABELS.AI_READY }, sender: { login: BOT_LOGIN, type: "Bot" } }),
      ),
    ).toBeNull();
  });

  it("issues.closed -> issue_closed", () => {
    expect(translate(payload({ action: "issues.closed" }))).toBe(EVENTS.ISSUE_CLOSED);
  });
});

describe("translate — discussion rounds (loop-dispatch's gates 2–7)", () => {
  const reply = (
    over: Partial<WebhookPayload> = {},
    comment: Partial<NonNullable<WebhookPayload["comment"]>> = {},
  ) =>
    payload({
      action: "issue_comment.created",
      comment: { body: "Option B, please", author_association: "OWNER", user_type: "User", ...comment },
      issue: { state: "open", is_pr: false },
      ...over,
    });

  it("a trusted human's reply on an open issue -> discussion_reply", () => {
    expect(translate(reply())).toBe(EVENTS.DISCUSSION_REPLY);
    expect(translate(reply({}, { author_association: "MEMBER" }))).toBe(EVENTS.DISCUSSION_REPLY);
  });

  it("each gate fails closed", () => {
    expect(translate(reply({}, { body: `Round 2 ${COMMENT_SIGNATURE}` })), "loop-signed").toBeNull();
    expect(translate(reply({}, { body: "  // for a colleague, not the loop" })), "// prefix").toBeNull();
    expect(translate(reply({}, { author_association: "CONTRIBUTOR" })), "untrusted").toBeNull();
    expect(translate(reply({}, { author_association: undefined })), "no association").toBeNull();
    expect(translate(reply({}, { user_type: "Bot" })), "bot author").toBeNull();
    expect(translate(reply({ issue: { state: "closed", is_pr: false } })), "closed").toBeNull();
    expect(translate(reply({ issue: { state: "open", is_pr: true } })), "PR").toBeNull();
    expect(translate(reply({ issue: undefined })), "no issue").toBeNull();
  });

  it("an outcome artifact still wins over the reply check", () => {
    const body = outcomeComment(ROUTINES.ISSUE_BUILD_LOOP, { outcome: "build_succeeded", pr: 123 });
    expect(translate(reply({}, { body }))).toBe(EVENTS.BUILD_SUCCEEDED);
  });
});
