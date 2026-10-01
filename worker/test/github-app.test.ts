import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { appBotLogin, appConfigured, appJwt, installationToken, resetInstallationTokenCache } from "../src/github-app";
import { getLabels } from "../src/github-client";

// A real RSA key, made and checked with Web Crypto (what the Worker itself uses).
const alg = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
let keys: CryptoKeyPair;
let privateKey: string;
beforeAll(async () => {
  keys = (await crypto.subtle.generateKey({ ...alg, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer);
  let bin = "";
  for (const b of der) bin += String.fromCharCode(b);
  privateKey = `-----BEGIN PRIVATE KEY-----\n${btoa(bin).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
});
const pkcs1 = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n";
const appEnv = () => ({ GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_APP_TOKEN: "personal" });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const b64urlDecode = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** GitHub's App endpoints plus one repo call, recorded. */
function fakeGitHub(expiresInMs = 60 * 60_000) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string>).Authorization;
    if (url.endsWith("/repos/hifi-phil/umbraco-mcp-ops/installation")) return json({ id: 42 });
    if (url.endsWith("/repos/hifi-phil/elsewhere/installation")) return new Response("Not Found", { status: 404 });
    if (url.endsWith("/app/installations/42/access_tokens")) {
      return json({ token: `inst-${Date.now()}`, expires_at: new Date(Date.now() + expiresInMs).toISOString() });
    }
    if (url.includes("/issues/7/labels")) return json([{ name: auth }]);
    if (url.endsWith("/app")) return json({ slug: "hifi-agent-orchestrator" });
    throw new Error(`unexpected ${url}`);
  });
}

beforeEach(() => resetInstallationTokenCache());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("appJwt", () => {
  it("an RS256 JWT for the App, signed with its key, valid for under 10 minutes", async () => {
    const jwt = await appJwt("123", privateKey, 1_000_000);
    const [header, payload, sig] = jwt.split(".");
    expect(JSON.parse(text(b64urlDecode(header!)))).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(text(b64urlDecode(payload!)))).toEqual({ iat: 999_940, exp: 1_000_540, iss: "123" });
    const ok = await crypto.subtle.verify(alg, keys.publicKey, b64urlDecode(sig!), new TextEncoder().encode(`${header}.${payload}`));
    expect(ok).toBe(true);
  });

  it("a PKCS#1 key (GitHub's download, unconverted) -> an error saying how to convert it", async () => {
    await expect(appJwt("123", pkcs1)).rejects.toThrow(/openssl pkcs8 -topk8/);
  });
});

describe("installationToken", () => {
  it("looks up the repo's installation with the JWT, then gets its token", async () => {
    const fetch = fakeGitHub();
    vi.stubGlobal("fetch", fetch);
    expect(await installationToken(appEnv(), "hifi-phil", "umbraco-mcp-ops")).toMatch(/^inst-/);
    const [lookup, issue] = fetch.mock.calls;
    expect((lookup![1]!.headers as Record<string, string>).Authorization).toMatch(/^Bearer ey/);
    expect(issue![1]!.method).toBe("POST");
  });

  it("caches per repo until 5 minutes before expiry, then refreshes", async () => {
    vi.useFakeTimers();
    const fetch = fakeGitHub(60 * 60_000);
    vi.stubGlobal("fetch", fetch);
    const first = await installationToken(appEnv(), "hifi-phil", "umbraco-mcp-ops");
    vi.advanceTimersByTime(54 * 60_000);
    expect(await installationToken(appEnv(), "Hifi-Phil", "Umbraco-MCP-Ops"), "cached, any case").toBe(first);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2 * 60_000);
    expect(await installationToken(appEnv(), "hifi-phil", "umbraco-mcp-ops")).not.toBe(first);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("a repo the App isn't installed on -> a clear error", async () => {
    vi.stubGlobal("fetch", fakeGitHub());
    await expect(installationToken(appEnv(), "hifi-phil", "elsewhere")).rejects.toThrow("the GitHub App isn't installed on hifi-phil/elsewhere");
  });
});

describe("appBotLogin", () => {
  it("the App's <slug>[bot], looked up once", async () => {
    const fetch = fakeGitHub();
    vi.stubGlobal("fetch", fetch);
    expect(await appBotLogin(appEnv())).toBe("hifi-agent-orchestrator[bot]");
    expect(await appBotLogin(appEnv())).toBe("hifi-agent-orchestrator[bot]");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("github-client with the App configured", () => {
  it("calls GitHub with the repo's installation token, not the personal one", async () => {
    vi.stubGlobal("fetch", fakeGitHub());
    const [auth] = await getLabels(appEnv(), "hifi-phil", "umbraco-mcp-ops", 7);
    expect(auth).toMatch(/^Bearer inst-/);
  });

  it("without the App (no id or key) -> the personal token, as before", async () => {
    vi.stubGlobal("fetch", fakeGitHub());
    expect(appConfigured({ GITHUB_APP_ID: "123" })).toBe(false);
    const [auth] = await getLabels({ GITHUB_APP_TOKEN: "personal" }, "hifi-phil", "umbraco-mcp-ops", 7);
    expect(auth).toBe("Bearer personal");
  });
});
