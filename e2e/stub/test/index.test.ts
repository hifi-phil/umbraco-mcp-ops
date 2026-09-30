import { describe, expect, it, vi } from "vitest";
import { act, handleFire, outcomeComment, parseFire, parseHint, type Gh, type StubEnv } from "../src/index";

const env: StubEnv = { GITHUB_TOKEN: "gh", FIRE_TOKEN: "fire", E2E_REPO: "hifi-phil/mcp-ops-e2e-testing" };
const text = (repo = "hifi-phil/mcp-ops-e2e-testing") =>
  `loop-dispatch (cloud worker). A GitHub loop event was routed at the edge: route=issue-build-loop repo=${repo} number=7. Run the loop-dispatch skill…`;
const fireRequest = (body: unknown, token = "fire") =>
  new Request("https://stub.example/", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("parseFire / parseHint", () => {
  it("reads the route line from the orchestrator's fire text", () => {
    expect(parseFire(text())).toEqual({ route: "issue-build-loop", owner: "hifi-phil", repo: "mcp-ops-e2e-testing", number: 7 });
    expect(parseFire("no route here")).toBeNull();
  });

  it("reads the e2e hint from an HTML comment", () => {
    expect(parseHint("Do a thing.\n\n<!-- e2e: blocked -->")).toBe("blocked");
    expect(parseHint("no hint")).toBeNull();
    expect(parseHint(null)).toBeNull();
  });
});

describe("outcomeComment", () => {
  it("is the marker + json shape from-github.ts parses", () => {
    const body = outcomeComment("issue-build-loop", { outcome: "build_blocked", reason: "x" });
    expect(body).toContain("<!-- agent-outcome:issue-build-loop -->");
    expect(body).toContain('```json\n{"outcome":"build_blocked","reason":"x"}\n```');
  });
});

describe("act", () => {
  const fire = { route: "issue-build-loop", owner: "hifi-phil", repo: "mcp-ops-e2e-testing", number: 7 };

  it("issue-build-loop + blocked -> posts the build_blocked marker", async () => {
    const gh = vi.fn<Gh>(async () => ({}));
    expect(await act(gh, fire, "blocked")).toBe("build_blocked");
    expect(gh).toHaveBeenCalledWith("POST", "/repos/hifi-phil/mcp-ops-e2e-testing/issues/7/comments", {
      body: expect.stringContaining('"outcome":"build_blocked"'),
    });
  });

  it("silent, or anything not scripted yet -> does nothing", async () => {
    const gh = vi.fn<Gh>(async () => ({}));
    expect(await act(gh, fire, "silent")).toBe("none");
    expect(await act(gh, { ...fire, route: "rework-loop" }, "blocked")).toBe("none");
    expect(gh).not.toHaveBeenCalled();
  });
});

describe("handleFire", () => {
  it("wrong token -> 401, nothing deferred", async () => {
    const defer = vi.fn();
    const res = await handleFire(fireRequest({ text: text() }, "nope"), env, defer);
    expect(res.status).toBe(401);
    expect(defer).not.toHaveBeenCalled();
  });

  it("a repo other than the sandbox -> 403, never acted on", async () => {
    const defer = vi.fn();
    const res = await handleFire(fireRequest({ text: text("hifi-phil/umbraco-mcp-ops") }), env, defer);
    expect(res.status).toBe(403);
    expect(defer).not.toHaveBeenCalled();
  });

  it("no route line -> 400", async () => {
    const res = await handleFire(fireRequest({ text: "hello" }), env, vi.fn());
    expect(res.status).toBe(400);
  });

  it("a good fire -> 200 at once; the work reads the hint and acts after the delay", async () => {
    let work: Promise<unknown> | undefined;
    const gh = vi.fn<Gh>(async (method) => (method === "GET" ? { body: "<!-- e2e: blocked -->" } : {}));
    const res = await handleFire(fireRequest({ text: text() }), env, (w) => (work = w), gh, 0);
    expect(res.status).toBe(200);
    await work;
    expect(gh).toHaveBeenCalledWith("GET", "/repos/hifi-phil/mcp-ops-e2e-testing/issues/7");
    expect(gh).toHaveBeenCalledWith("POST", "/repos/hifi-phil/mcp-ops-e2e-testing/issues/7/comments", expect.anything());
  });
});
