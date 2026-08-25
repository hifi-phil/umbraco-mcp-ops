import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addLabel,
  closeIssue,
  commentOnIssue,
  getLabels,
  removeLabel,
} from "../src/github-client";

const env = { GITHUB_APP_TOKEN: "test-token" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getLabels", () => {
  it("returns the label names from a successful response", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify([{ name: "ai-ready" }, { name: "dependencies" }]), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const labels = await getLabels(env, "hifi-phil", "umbraco-mcp-ops", 412);
    expect(labels).toEqual(["ai-ready", "dependencies"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/hifi-phil/umbraco-mcp-ops/issues/412/labels",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("a 404 (issue not found) -> empty array, not a throw", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    expect(await getLabels(env, "hifi-phil", "umbraco-mcp-ops", 999)).toEqual([]);
  });

  it("a real error status throws with the response body included", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 403 })));
    await expect(getLabels(env, "hifi-phil", "umbraco-mcp-ops", 412)).rejects.toThrow(/403/);
  });
});

describe("addLabel / removeLabel", () => {
  it("addLabel POSTs the label in a labels array", async () => {
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) =>
      new Response("[]", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await addLabel(env, "hifi-phil", "umbraco-mcp-ops", 412, "ai-generated");
    const [, options] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(options!.body as string)).toEqual({ labels: ["ai-generated"] });
  });

  it("removeLabel tolerates a 404 (already removed) without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    await expect(removeLabel(env, "hifi-phil", "umbraco-mcp-ops", 412, "ai-ready")).resolves.toBeUndefined();
  });

  it("removeLabel URL-encodes the label name", async () => {
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) =>
      new Response("", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await removeLabel(env, "hifi-phil", "umbraco-mcp-ops", 412, "needs: review");
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain(encodeURIComponent("needs: review"));
  });
});

describe("closeIssue / commentOnIssue", () => {
  it("closeIssue PATCHes state: closed", async () => {
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) =>
      new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await closeIssue(env, "hifi-phil", "umbraco-mcp-ops", 412);
    const [, options] = fetchMock.mock.calls[0]!;
    expect(options!.method).toBe("PATCH");
    expect(JSON.parse(options!.body as string)).toEqual({ state: "closed" });
  });

  it("commentOnIssue POSTs the body", async () => {
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) =>
      new Response("{}", { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await commentOnIssue(env, "hifi-phil", "umbraco-mcp-ops", 412, "hello");
    const [, options] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(options!.body as string)).toEqual({ body: "hello" });
  });
});

describe("GITHUB_API_BASE_URL override", () => {
  it("uses the configured base URL instead of the real API when set", async () => {
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) =>
      new Response("[]", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await getLabels({ ...env, GITHUB_API_BASE_URL: "http://127.0.0.1:9999" }, "hifi-phil", "umbraco-mcp-ops", 412);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/repos/hifi-phil/umbraco-mcp-ops/issues/412/labels",
      expect.anything(),
    );
  });
});
