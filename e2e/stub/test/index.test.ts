import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleFire,
  handleWebhook,
  outcomeComment,
  parseFire,
  parseHint,
  handleReview,
  stubGitHub,
  routineSignal,
  verifySignature,
  type Gh,
  type StubEnv,
} from "../src/index";
import { act, mergeIfGreen } from "../src/loops";
import { LABELS } from "@orchestrator/graph/constants/labels";

const env: StubEnv = {
  FIRE_TOKEN: "fire",
  HOOK_SECRET: "hook",
  E2E_REPO: "hifi-phil/mcp-ops-e2e-testing",
  ORCHESTRATOR: { fetch: async () => new Response("{}") },
  ROUTINE_SIGNAL_SECRET: "sig",
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: "unused in tests",
};
const R = "/repos/hifi-phil/mcp-ops-e2e-testing";
const fireFor = (route: string, number = 7) => ({ route, owner: "hifi-phil", repo: "mcp-ops-e2e-testing", number });
const text = (repo = "hifi-phil/mcp-ops-e2e-testing") =>
  `loop-dispatch (cloud worker). A GitHub loop event was routed at the edge: route=issue-build-loop repo=${repo} number=7. Run the loop-dispatch skill…`;
const fireRequest = (body: unknown, token = "fire") =>
  new Request("https://stub.example/", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** A fake GitHub: `routes` answers by "METHOD path" prefix; every call is recorded. */
function fakeGh(routes: Record<string, unknown> = {}) {
  return vi.fn<Gh>(async (method, path) => {
    const key = Object.keys(routes).find((k) => `${method} ${path}`.startsWith(k));
    if (key === undefined) return {};
    const answer = routes[key];
    if (answer instanceof Error) throw answer;
    return answer;
  });
}
const calls = (gh: ReturnType<typeof fakeGh>) => gh.mock.calls.map(([m, p]) => `${m} ${p}`);

async function sign(secret: string, body: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return "sha256=" + [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("parseFire / parseHint / outcomeComment", () => {
  it("reads the route line from the orchestrator's fire text", () => {
    expect(parseFire(text())).toEqual(fireFor("issue-build-loop"));
    expect(parseFire("no route here")).toBeNull();
  });

  it("reads the e2e hint from an HTML comment", () => {
    expect(parseHint("Do a thing.\n\n<!-- e2e: blocked -->")).toBe("blocked");
    expect(parseHint("no hint")).toBeNull();
    expect(parseHint(null)).toBeNull();
  });

  it("the marker + json shape from-github.ts parses", () => {
    const body = outcomeComment("issue-build-loop", { outcome: "build_blocked", reason: "x" });
    expect(body).toContain("<!-- agent-outcome:issue-build-loop -->");
    expect(body).toContain('```json\n{"outcome":"build_blocked","reason":"x"}\n```');
  });
});

describe("act — issue-build-loop", () => {
  it("blocked -> posts the build_blocked marker", async () => {
    const gh = fakeGh();
    expect(await act(gh, fireFor("issue-build-loop"), "blocked")).toBe("build_blocked");
    expect(gh).toHaveBeenCalledWith("POST", `${R}/issues/7/comments`, { body: expect.stringContaining('"outcome":"build_blocked"') });
  });

  it("success -> branch off dev, one commit, a PR into dev with a merge hint, then the build_succeeded marker", async () => {
    const gh = fakeGh({
      [`GET ${R}/git/ref/heads/dev`]: { object: { sha: "devsha" } },
      [`GET ${R}/contents/`]: new Error("GitHub GET … failed: 404"),
      [`POST ${R}/pulls`]: { number: 42 },
    });
    expect(await act(gh, fireFor("issue-build-loop"), "success")).toBe("build_succeeded");
    expect(gh).toHaveBeenCalledWith("POST", `${R}/git/refs`, { ref: expect.stringMatching(/^refs\/heads\/e2e\/build-7-/), sha: "devsha" });
    expect(gh).toHaveBeenCalledWith("POST", `${R}/pulls`, expect.objectContaining({ base: "dev", body: expect.stringContaining("<!-- e2e: merge -->") }));
    expect(gh).toHaveBeenCalledWith("POST", `${R}/pulls`, expect.objectContaining({ body: expect.stringContaining("Closes #7") }));
    expect(gh).toHaveBeenLastCalledWith("POST", `${R}/issues/7/comments`, {
      body: expect.stringContaining('{"outcome":"build_succeeded","pr":42}'),
    });
  });
});

describe("act — rework-loop", () => {
  const pr = { [`GET ${R}/pulls/7`]: { head: { ref: "feature" } } };

  it.each([
    ["rework", "rework/7.txt"],
    ["ci_never_fixed", "rework/7.txt"],
    ["ci_fail", "ci-state"],
    ["review_ci_fail", "ci-state"],
    ["review_findings_once", "rework/7.txt"],
    ["review_findings_always", "rework/7.txt"],
  ])("%s -> one push to the PR's branch (%s), labels untouched", async (hint, path) => {
    const gh = fakeGh({ ...pr, [`GET ${R}/contents/`]: { sha: "old" } });
    expect(await act(gh, fireFor("rework-loop"), hint)).toBe("pushed");
    expect(gh).toHaveBeenCalledWith("PUT", `${R}/contents/${path}`, expect.objectContaining({ branch: "feature", sha: "old" }));
    expect(calls(gh).some((c) => c.includes("/labels"))).toBe(false);
  });

  it("ci_fail writes ci-state = pass", async () => {
    const gh = fakeGh({ ...pr, [`GET ${R}/contents/`]: { sha: "old" } });
    await act(gh, fireFor("rework-loop"), "ci_fail");
    const put = gh.mock.calls.find(([m]) => m === "PUT")!;
    expect(atob((put[2] as { content: string }).content)).toBe("pass\n");
  });
});

describe("act — review-loop", () => {
  const verdictOf = (gh: ReturnType<typeof fakeGh>) => {
    const post = gh.mock.calls.find(([m, p]) => m === "POST" && p.endsWith("/comments"))!;
    return JSON.parse((post[2] as { body: string }).body.match(/```json\n(.*)\n```/)![1]!);
  };

  it.each([
    ["review_pass", { outcome: "review_passed" }],
    ["review_ci_fail", { outcome: "review_passed" }],
    ["review_block", { outcome: "review_blocked", reason: "e2e stub: scripted block" }],
    ["review_findings_always", { outcome: "review_findings", findings: 1 }],
  ])("%s -> its verdict as a review-loop outcome comment, labels untouched", async (hint, outcome) => {
    const gh = fakeGh();
    expect(await act(gh, fireFor("review-loop"), hint)).toBe(outcome.outcome);
    expect(verdictOf(gh)).toEqual(outcome);
    expect(calls(gh).some((c) => c.includes("/labels"))).toBe(false);
  });

  it("review_findings_once -> findings on the first round, a pass once it has asked", async () => {
    const first = fakeGh({ [`GET ${R}/issues/7/comments`]: [] });
    expect(await act(first, fireFor("review-loop"), "review_findings_once")).toBe("review_findings");
    const asked = outcomeComment("review-loop", { outcome: "review_findings", findings: 1 });
    const second = fakeGh({ [`GET ${R}/issues/7/comments`]: [{ body: asked }] });
    expect(await act(second, fireFor("review-loop"), "review_findings_once")).toBe("review_passed");
  });
});

describe("act — merge-flow (mergeIfGreen)", () => {
  const pull = (over: Record<string, unknown> = {}) => ({
    [`GET ${R}/pulls/7`]: { state: "open", mergeable: true, head: { sha: "h" }, labels: [{ name: LABELS.AUTO_MERGING }], ...over },
  });
  const runs = (...r: { status: string; conclusion: string | null }[]) => ({
    [`GET ${R}/commits/h/check-runs`]: { check_runs: r.map((x, i) => ({ name: `c${i}`, ...x })) },
  });

  it("CI green and mergeable -> squash-merges", async () => {
    const gh = fakeGh({ ...pull(), ...runs({ status: "completed", conclusion: "success" }) });
    expect(await mergeIfGreen(gh, fireFor("merge-flow"))).toBe("merged");
    expect(gh).toHaveBeenCalledWith("PUT", `${R}/pulls/7/merge`, { merge_method: "squash" });
  });

  it("CI still running, or no runs yet -> waits (the check_suite webhook comes back)", async () => {
    expect(await mergeIfGreen(fakeGh({ ...pull(), ...runs({ status: "in_progress", conclusion: null }) }), fireFor("merge-flow"))).toBe(
      "waiting_for_ci",
    );
    expect(await mergeIfGreen(fakeGh({ ...pull(), ...runs() }), fireFor("merge-flow"))).toBe("waiting_for_ci");
  });

  it("CI red -> comments and stops, never merges or touches labels", async () => {
    const gh = fakeGh({ ...pull(), ...runs({ status: "completed", conclusion: "failure" }) });
    expect(await mergeIfGreen(gh, fireFor("merge-flow"))).toBe("ci_red");
    expect(calls(gh).some((c) => c.includes("/merge") || c.includes("/labels"))).toBe(false);
  });

  it(`no ${LABELS.AUTO_MERGING} label, closed, or a conflict -> does nothing`, async () => {
    for (const over of [{ labels: [] }, { state: "closed" }, { mergeable: false }]) {
      const gh = fakeGh({ ...pull(over), ...runs({ status: "completed", conclusion: "success" }) });
      expect(await mergeIfGreen(gh, fireFor("merge-flow"))).toBe("none");
      expect(calls(gh).some((c) => c.startsWith("PUT"))).toBe(false);
    }
  });

  it("losing a merge race (405, and the PR is already merged) -> none, not an error", async () => {
    let reads = 0;
    const gh = vi.fn<Gh>(async (method, path) => {
      if (method === "PUT") throw new Error(`GitHub PUT ${path} failed: 405 Pull Request is not mergeable`);
      if (path.endsWith("/pulls/7")) {
        reads++;
        return reads === 1
          ? { state: "open", mergeable: true, head: { sha: "h" }, labels: [{ name: LABELS.AUTO_MERGING }] }
          : { state: "closed", merged: true };
      }
      if (path.endsWith("/check-runs")) return { check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] };
      return {};
    });
    expect(await mergeIfGreen(gh, fireFor("merge-flow"), 0)).toBe("none");
    expect(gh.mock.calls.filter(([m]) => m === "PUT")).toHaveLength(1);
  });

  it("a merge refused while dev settles (405, PR still open) -> retried, then merged (found by e2e: PR #167)", async () => {
    let puts = 0;
    const gh = vi.fn<Gh>(async (method, path) => {
      if (method === "PUT") {
        if (++puts === 1) throw new Error(`GitHub PUT ${path} failed: 405 Base branch was modified`);
        return {};
      }
      if (path.endsWith("/pulls/7")) return { state: "open", mergeable: true, head: { sha: "h" }, labels: [{ name: LABELS.AUTO_MERGING }] };
      if (path.endsWith("/check-runs")) return { check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] };
      return {};
    });
    expect(await mergeIfGreen(gh, fireFor("merge-flow"), 0)).toBe("merged");
    expect(puts).toBe(2);
  });
});

describe("act — issue-discuss-loop", () => {
  it("discuss -> one signed question, numbered by the rounds so far", async () => {
    const gh = fakeGh({ [`GET ${R}/issues/7/comments`]: [{ body: "<!-- issue-discuss-loop -->\nround 1" }, { body: "a human reply" }] });
    expect(await act(gh, fireFor("issue-discuss-loop"), "discuss")).toBe("discussed");
    expect(gh).toHaveBeenLastCalledWith("POST", `${R}/issues/7/comments`, {
      body: expect.stringMatching(/^<!-- issue-discuss-loop -->\n.*round 2/),
    });
  });
});

describe("routineSignal", () => {
  it("posts {owner, repo, signal} to /routine-signal over the service binding, with the bearer secret", async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => new Response('{"outcome":"heartbeat_extended"}'));
    const signal = routineSignal({ ...env, ORCHESTRATOR: { fetch } }, "hifi-phil", "mcp-ops-e2e-testing");
    expect(await signal({ kind: "process", routine: "issue-build-loop", issue: 7, step: "s" })).toContain("heartbeat_extended");
    const [url, init] = fetch.mock.calls[0]!;
    expect(new URL(url).pathname).toBe("/routine-signal");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer sig");
    expect(JSON.parse(init!.body as string)).toEqual({
      owner: "hifi-phil",
      repo: "mcp-ops-e2e-testing",
      signal: { kind: "process", routine: "issue-build-loop", issue: 7, step: "s" },
    });
  });

  it("a refused signal throws, so the stub's log says so", async () => {
    const signal = routineSignal({ ...env, ORCHESTRATOR: { fetch: async () => new Response("unauthorized", { status: 401 }) } }, "o", "r");
    await expect(signal({})).rejects.toThrow(/401/);
  });
});

describe("act — heartbeat and completion signals", () => {
  it("heartbeat -> one process signal for this routine and issue, no GitHub writes", async () => {
    const gh = fakeGh();
    const signal = vi.fn(async () => '{"outcome":"heartbeat_extended"}');
    expect(await act(gh, fireFor("issue-build-loop"), "heartbeat", signal)).toBe("heartbeat");
    expect(signal).toHaveBeenCalledWith({ routine: "issue-build-loop", issue: 7, kind: "process", step: "e2e-heartbeat" });
    expect(gh).not.toHaveBeenCalled();
  });

  it("complete -> one completion signal with a valid outcome, no GitHub writes", async () => {
    const gh = fakeGh();
    const signal = vi.fn(async () => '{"outcome":"completion_acknowledged"}');
    expect(await act(gh, fireFor("issue-build-loop"), "complete", signal)).toBe("completion");
    expect(signal).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "completion", outcome: expect.objectContaining({ outcome: "build_blocked" }) }),
    );
    expect(gh).not.toHaveBeenCalled();
  });
});

describe("act — auto-release-loop, and silent", () => {
  it("published -> tags dev's head v<version> (as release-tag.yml would), the release_published marker, then closes the issue", async () => {
    const gh = fakeGh({ [`GET ${R}/git/ref/heads/dev`]: { object: { sha: "dev-head" } } });
    expect(await act(gh, fireFor("auto-release-loop"), "published")).toBe("release_published");
    expect(calls(gh)).toEqual([`GET ${R}/git/ref/heads/dev`, `POST ${R}/git/refs`, `POST ${R}/issues/7/comments`, `PATCH ${R}/issues/7`]);
    expect(gh).toHaveBeenCalledWith("POST", `${R}/git/refs`, { ref: "refs/tags/v0.0.7", sha: "dev-head" });
  });

  it("approve (the release split, before) -> release/<version> PR into main (\"Part of\", not \"Closes\"), release_approved with its head and merge method", async () => {
    const gh = fakeGh({
      [`GET ${R}/git/ref/heads/dev`]: { object: { sha: "dev-head" } },
      [`POST ${R}/pulls`]: { number: 90, head: { sha: "rel-head" } },
      [`GET ${R}/contents/`]: new Error("404"),
    });
    expect(await act(gh, fireFor("auto-release-loop"), "approve")).toBe("release_approved");
    expect(gh).toHaveBeenCalledWith("POST", `${R}/git/refs`, { ref: "refs/heads/release/0.0.7", sha: "dev-head" });
    expect(gh).toHaveBeenCalledWith("POST", `${R}/pulls`, expect.objectContaining({ head: "release/0.0.7", base: "main", body: expect.stringContaining("Part of #7") }));
    const approval = gh.mock.calls.find(([m, p]) => m === "POST" && p.endsWith("/issues/7/comments"))!;
    expect((approval[2] as { body: string }).body).toContain('"outcome":"release_approved","pr":90,"sha":"rel-head","version":"0.0.7","merge_method":"merge"');
  });

  it("release-publish (the after part) -> tags the merged main v<version>, reports release_published with the tag", async () => {
    const gh = fakeGh({ [`GET ${R}/git/ref/heads/main`]: { object: { sha: "main-merge" } } });
    expect(await act(gh, fireFor("release-publish"), "approve")).toBe("release_published");
    expect(gh).toHaveBeenCalledWith("POST", `${R}/git/refs`, { ref: "refs/tags/v0.0.7", sha: "main-merge" });
    const published = gh.mock.calls.find(([m, p]) => m === "POST" && p.endsWith("/issues/7/comments"))!;
    expect((published[2] as { body: string }).body).toContain('"outcome":"release_published","version":"0.0.7","tag":"v0.0.7"');
  });

  it("blocked -> the release_blocked marker, issue left open", async () => {
    const gh = fakeGh();
    expect(await act(gh, fireFor("auto-release-loop"), "blocked")).toBe("release_blocked");
    expect(calls(gh)).toEqual([`POST ${R}/issues/7/comments`]);
  });

  it("silent, or anything not scripted -> does nothing", async () => {
    const gh = fakeGh();
    expect(await act(gh, fireFor("issue-build-loop"), "silent")).toBe("none");
    expect(await act(gh, fireFor("issue-discuss-loop"), "blocked")).toBe("none");
    expect(gh).not.toHaveBeenCalled();
  });
});

describe("handleFire", () => {
  it("wrong token -> 401, nothing deferred", async () => {
    const defer = vi.fn();
    expect((await handleFire(fireRequest({ text: text() }, "nope"), env, defer)).status).toBe(401);
    expect(defer).not.toHaveBeenCalled();
  });

  it("a repo other than the sandbox -> 403, never acted on", async () => {
    const defer = vi.fn();
    expect((await handleFire(fireRequest({ text: text("hifi-phil/umbraco-mcp-ops") }), env, defer)).status).toBe(403);
    expect(defer).not.toHaveBeenCalled();
  });

  it("fail_fire -> the fire itself is refused (500), nothing deferred", async () => {
    const defer = vi.fn();
    const gh = fakeGh({ [`GET ${R}/issues/7`]: { body: "<!-- e2e: fail_fire -->" } });
    expect((await handleFire(fireRequest({ text: text() }), env, defer, gh, 0)).status).toBe(500);
    expect(defer).not.toHaveBeenCalled();
  });

  it("no route line -> 400", async () => {
    expect((await handleFire(fireRequest({ text: "hello" }), env, vi.fn())).status).toBe(400);
  });

  it("a good fire -> 200 at once; the work reads the hint and acts after the delay", async () => {
    let work: Promise<unknown> | undefined;
    const gh = fakeGh({ [`GET ${R}/issues/7`]: { body: "<!-- e2e: blocked -->" } });
    const res = await handleFire(fireRequest({ text: text() }), env, (w) => (work = w), gh, 0);
    expect(res.status).toBe(200);
    await work;
    expect(gh).toHaveBeenCalledWith("POST", `${R}/issues/7/comments`, expect.anything());
  });
});

describe("stubGitHub", () => {
  afterEach(() => vi.unstubAllGlobals());
  const auth = async (gh: Gh, method: string, path: string) => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      void init;
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    await gh(method, path);
    return (fetch.mock.calls[0]![1]!.headers as Record<string, string>).Authorization;
  };
  const withApp = () => stubGitHub(env, async () => "inst-token");

  it("a 403 is retried once on a fresh token (one cached before a permission was granted)", async () => {
    const fetch = vi
      .fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("Resource not accessible by integration", { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    const tokens = ["stale", "fresh"];
    const forget = vi.fn();
    await stubGitHub(env, async () => tokens.shift()!, forget)("PUT", `${R}/contents/ci-state`);
    expect(forget).toHaveBeenCalledOnce();
    expect((fetch.mock.calls[1]![1]!.headers as Record<string, string>).Authorization).toBe("Bearer fresh");
  });

  it("every call goes as the App: check-runs, commits, merges, issues (no personal token)", async () => {
    for (const [method, path] of [
      ["GET", `${R}/commits/h/check-runs`],
      ["PUT", `${R}/contents/ci-state`],
      ["PUT", `${R}/pulls/7/merge`],
      ["GET", `${R}/issues/7`],
    ] as const) {
      expect(await auth(withApp(), method, path), `${method} ${path}`).toBe("Bearer inst-token");
    }
  });
});

describe("handleReview (POST /review, as the App's bot)", () => {
  const review = (body: unknown, token = "fire") =>
    new Request("https://stub.example/review", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("submits the review on the sandbox PR with the App's installation token", async () => {
    const calls: [string, string, string, unknown][] = [];
    const gh = (token: string): Gh => async (method, path, body) => {
      calls.push([token, method, path, body]);
      return { id: 9, state: "CHANGES_REQUESTED", user: { login: "umbraco-agent-orchestrator[bot]" } };
    };
    const res = await handleReview(review({ number: 7, event: "REQUEST_CHANGES" }), env, gh, async () => "inst-token");
    expect(await res.json()).toEqual({ id: 9, state: "CHANGES_REQUESTED", by: "umbraco-agent-orchestrator[bot]" });
    expect(calls).toEqual([
      ["inst-token", "POST", `${R}/pulls/7/reviews`, { event: "REQUEST_CHANGES", body: "e2e stub: changes requested." }],
    ]);
  });

  it("wrong token -> 401; a bad event -> 400; never reviews", async () => {
    const appToken = vi.fn(async () => "t");
    expect((await handleReview(review({ number: 7, event: "REQUEST_CHANGES" }, "nope"), env, undefined, appToken)).status).toBe(401);
    expect((await handleReview(review({ number: 7, event: "COMMENT" }), env, undefined, appToken)).status).toBe(400);
    expect(appToken).not.toHaveBeenCalled();
  });
});

describe("handleWebhook (the stub's own check_suite webhook)", () => {
  const suite = (repo = "mcp-ops-e2e-testing") =>
    JSON.stringify({
      action: "completed",
      repository: { name: repo, owner: { login: "hifi-phil" } },
      check_suite: { pull_requests: [{ number: 7 }] },
    });
  const hook = async (body: string, signature?: string, event = "check_suite") =>
    new Request("https://stub.example/webhook", {
      method: "POST",
      headers: { "X-GitHub-Event": event, "X-Hub-Signature-256": signature ?? (await sign("hook", body)) },
      body,
    });

  it("verifySignature accepts GitHub's HMAC and rejects anything else", async () => {
    expect(await verifySignature("hook", "x", await sign("hook", "x"))).toBe(true);
    expect(await verifySignature("hook", "x", await sign("other", "x"))).toBe(false);
    expect(await verifySignature("hook", "x", null)).toBe(false);
  });

  it("bad signature -> 401", async () => {
    expect((await handleWebhook(await hook(suite(), "sha256=00"), env)).status).toBe(401);
  });

  it("a completed suite -> ignored, nothing merged: the orchestrator re-fires merge-flow on green CI itself", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const res = await handleWebhook(await hook(suite()), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: expect.any(String) });
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
