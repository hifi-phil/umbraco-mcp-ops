import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchText, fireRoutine, routineTargetFor } from "../src/routines-client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const env = {
  REPO_ROUTINES_JSON: JSON.stringify({
    "hifi-phil/umbraco-mcp-ops": { fireUrl: "https://routines.example/fire/ops", token: "tok-ops" },
    "umbraco/Umbraco-CMS-MCP-Editor": { fireUrl: "https://routines.example/fire/editor", token: "tok-editor" },
  }),
};

describe("routineTargetFor", () => {
  it("picks the repo's own Fire URL and token", () => {
    expect(routineTargetFor(env, "hifi-phil", "umbraco-mcp-ops")).toEqual({
      fireUrl: "https://routines.example/fire/ops",
      token: "tok-ops",
    });
    expect(routineTargetFor(env, "umbraco", "Umbraco-CMS-MCP-Editor").token).toBe("tok-editor");
  });

  it("matches owner/repo case-insensitively, as GitHub does", () => {
    expect(routineTargetFor(env, "Hifi-Phil", "UMBRACO-MCP-OPS").token).toBe("tok-ops");
    expect(routineTargetFor(env, "umbraco", "umbraco-cms-mcp-editor").token).toBe("tok-editor");
  });

  it("an unconfigured repo, or an entry missing url/token, is a loud config error", () => {
    expect(() => routineTargetFor(env, "someone", "else")).toThrow(/No loop-dispatch routine.*someone\/else/);
    const partial = { REPO_ROUTINES_JSON: JSON.stringify({ "a/b": { fireUrl: "https://x" } }) };
    expect(() => routineTargetFor(partial, "a", "b")).toThrow(/No loop-dispatch routine/);
  });

  it("malformed JSON -> a clear error", () => {
    expect(() => routineTargetFor({ REPO_ROUTINES_JSON: "not json" }, "a", "b")).toThrow(/not valid JSON/);
  });
});

describe("dispatchText", () => {
  it("carries route-event.sh's result line, exactly as the workflow sends it", () => {
    const text = dispatchText("merge-flow", "hifi-phil", "umbraco-mcp-ops", 126);
    expect(text).toContain("routed at the edge: route=merge-flow repo=hifi-phil/umbraco-mcp-ops number=126.");
    expect(text).toContain("Run the loop-dispatch skill");
  });
});

describe("fireRoutine", () => {
  it("POSTs to the repo's Fire URL with its token, the routines beta headers and {text}", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await fireRoutine(env, "hifi-phil", "umbraco-mcp-ops", 126, "merge-flow");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://routines.example/fire/ops");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: "Bearer tok-ops",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "experimental-cc-routine-2026-04-01",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({ text: dispatchText("merge-flow", "hifi-phil", "umbraco-mcp-ops", 126) });
  });

  it("each repo fires its own routine", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await fireRoutine(env, "umbraco", "Umbraco-CMS-MCP-Editor", 7, "issue-build-loop");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://routines.example/fire/editor");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-editor");
  });

  it("retries a 5xx (like the workflow's curl --retry 3), then succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("bad gateway", { status: 520 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const done = fireRoutine(env, "hifi-phil", "umbraco-mcp-ops", 1, "merge-flow");
    await vi.runAllTimersAsync();
    await done;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after 3 attempts on persistent 5xx, with the status in the error", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("down", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const done = fireRoutine(env, "hifi-phil", "umbraco-mcp-ops", 1, "merge-flow");
    const assertion = expect(done).rejects.toThrow(/Routine fire failed for hifi-phil\/umbraco-mcp-ops.*503/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 4xx (a bad token won't fix itself)", async () => {
    const fetchMock = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fireRoutine(env, "hifi-phil", "umbraco-mcp-ops", 1, "merge-flow")).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an unconfigured repo throws before any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fireRoutine(env, "someone", "else", 1, "merge-flow")).rejects.toThrow(/No loop-dispatch routine/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
