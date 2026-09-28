import { afterEach, describe, expect, it, vi } from "vitest";
import { fireRoutine } from "../src/routines-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

const env = {
  CLAUDE_API_KEY: "test-key",
  ROUTINE_IDS_JSON: JSON.stringify({ "issue-build-loop": "rt_abc123" }),
};

describe("fireRoutine", () => {
  it("POSTs to the configured routine id with the context as additional_context", async () => {
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) =>
      new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fireRoutine(env, "issue-build-loop", "Issue #412: do the thing");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.claude.com/routines/rt_abc123",
      expect.objectContaining({ method: "POST" }),
    );
    const [, options] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(options!.body as string)).toEqual({
      additional_context: "Issue #412: do the thing",
    });
  });

  it("throws if the routine has no configured id", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(fireRoutine(env, "rework-loop", "context")).rejects.toThrow(/No routine id/);
  });

  it("throws with the response body if the API call fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad request", { status: 400 })));
    await expect(fireRoutine(env, "issue-build-loop", "context")).rejects.toThrow(/400/);
  });

  it("throws a clear error if ROUTINE_IDS_JSON is malformed", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      fireRoutine({ ...env, ROUTINE_IDS_JSON: "not json" }, "issue-build-loop", "context"),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("uses CLAUDE_API_BASE_URL when set, instead of the real API", async () => {
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) =>
      new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fireRoutine(
      { ...env, CLAUDE_API_BASE_URL: "http://127.0.0.1:9999" },
      "issue-build-loop",
      "context",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/routines/rt_abc123",
      expect.anything(),
    );
  });
});
