import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addLabel,
  closeIssue,
  commentOnIssue,
  getCheckRuns,
  getLabels,
  getLatestReviewState,
  getPull,
  openWithLabel,
  removeLabel,
} from "../src/github-client";

const env = { GITHUB_APP_TOKEN: "test-token" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("no GitHub access configured", () => {
  it("neither the App nor a local token: a call fails, naming what to set (a deployed Worker always has the App)", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(getLabels({}, "hifi-phil", "umbraco-mcp-ops", 412)).rejects.toThrow(/GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY/);
    expect(fetch).not.toHaveBeenCalled();
  });
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

  it("a 404 throws: GitHub also means 'this token can't see the repo' by it, not just 'no labels'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    await expect(getLabels(env, "hifi-phil", "umbraco-mcp-ops", 999)).rejects.toThrow(/404/);
  });

  it("a real error status throws with the response body included", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 403 })));
    await expect(getLabels(env, "hifi-phil", "umbraco-mcp-ops", 412)).rejects.toThrow(/403/);
  });
});

describe("openWithLabel", () => {
  it("follows every page, not just the first 100", async () => {
    const page = (n: number, count: number) => Array.from({ length: count }, (_, i) => ({ number: n * 1000 + i }));
    const fetchMock = vi.fn(async (url: string) => {
      const p = Number(new URL(url).searchParams.get("page"));
      return new Response(JSON.stringify(p === 1 ? page(1, 100) : p === 2 ? page(2, 100) : page(3, 7)), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const numbers = await openWithLabel(env, "hifi-phil", "umbraco-mcp-ops", "ai-ready");
    expect(numbers).toHaveLength(207);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("addLabel / removeLabel", () => {
  it("addLabel POSTs the label in a labels array", async () => {
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) =>
      new Response("[]", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await addLabel(env, "hifi-phil", "umbraco-mcp-ops", 412, "pr-open");
    const [, options] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(options!.body as string)).toEqual({ labels: ["pr-open"] });
  });

  it("addLabel throws on a 404 (e.g. no access to the repo) instead of silently doing nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    await expect(addLabel(env, "hifi-phil", "mcp-ops-e2e-testing", 4, "ai-blocked")).rejects.toThrow(/404/);
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

describe("getPull", () => {
  it("returns the head SHA and mergeable flag", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ head: { sha: "abc123" }, mergeable: true }), { status: 200 })),
    );
    expect(await getPull(env, "hifi-phil", "umbraco-mcp-ops", 412)).toEqual({
      headSha: "abc123",
      mergeable: true,
    });
  });

  it("passes through mergeable: null (GitHub still computing it)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ head: { sha: "abc123" }, mergeable: null }), { status: 200 })),
    );
    expect((await getPull(env, "hifi-phil", "umbraco-mcp-ops", 412)).mergeable).toBeNull();
  });
});

describe("getCheckRuns", () => {
  it("returns the check_runs array from the commit's check-runs endpoint", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ check_runs: [{ status: "completed", conclusion: "success" }] }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const runs = await getCheckRuns(env, "hifi-phil", "umbraco-mcp-ops", "abc123");
    expect(runs).toEqual([{ status: "completed", conclusion: "success" }]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/hifi-phil/umbraco-mcp-ops/commits/abc123/check-runs",
      expect.anything(),
    );
  });
});

describe("getLatestReviewState", () => {
  it("returns 'none' when there are no reviews", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    expect(await getLatestReviewState(env, "hifi-phil", "umbraco-mcp-ops", 412)).toBe("none");
  });

  it("returns the most recent review's state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([{ state: "APPROVED" }, { state: "CHANGES_REQUESTED" }]),
            { status: 200 },
          ),
      ),
    );
    expect(await getLatestReviewState(env, "hifi-phil", "umbraco-mcp-ops", 412)).toBe("changes_requested");
  });

  it("maps an unrecognized/non-blocking state (e.g. dismissed) to 'none'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ state: "DISMISSED" }]), { status: 200 })));
    expect(await getLatestReviewState(env, "hifi-phil", "umbraco-mcp-ops", 412)).toBe("none");
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
