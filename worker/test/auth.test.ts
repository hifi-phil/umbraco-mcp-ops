import { describe, expect, it, vi } from "vitest";
import { allowedEmail, handleCallback, handleLogin, handleLogout, safeNext, signSession, verifySession } from "../src/auth";

const env = { GITHUB_OAUTH_CLIENT_ID: "Iv1.abc", GITHUB_OAUTH_CLIENT_SECRET: "cs", SESSION_SECRET: "sess-key" };
const DOMAINS = ["umbraco.com", "umbraco.dk"];

describe("the session cookie", () => {
  const now = Date.parse("2026-10-03T10:00:00Z");
  const exp = Math.floor(now / 1000) + 3600;

  it("round-trips when signed with the same key and not expired", async () => {
    const token = await signSession({ login: "octo", email: "octo@umbraco.com", exp }, "k");
    expect(await verifySession(token, "k", now)).toEqual({ login: "octo", email: "octo@umbraco.com", exp });
  });

  it("refuses another key, a changed payload, an expired one, and junk", async () => {
    const token = await signSession({ login: "octo", email: "octo@umbraco.com", exp }, "k");
    expect(await verifySession(token, "other", now)).toBeNull();
    const [, sig] = token.split(".");
    const forged = btoa(JSON.stringify({ login: "evil", email: "evil@umbraco.com", exp })).replace(/=+$/, "");
    expect(await verifySession(`${forged}.${sig}`, "k", now)).toBeNull();
    expect(await verifySession(token, "k", (exp + 1) * 1000)).toBeNull();
    for (const junk of ["", "a", "a.b", "a.b.c", "!!.!!"]) expect(await verifySession(junk, "k", now), junk).toBeNull();
  });
});

describe("allowedEmail — Umbraco domains only, verified, exact match", () => {
  it("takes the first verified email at an allowed domain", () => {
    expect(allowedEmail([{ email: "me@gmail.com", verified: true }, { email: "Me@Umbraco.dk", verified: true }], DOMAINS)).toBe("me@umbraco.dk");
  });

  it("refuses unverified ones and look-alike domains", () => {
    for (const email of ["me@umbraco.com.evil.io", "me@notumbraco.com", "me@sub.umbraco.com", "umbraco.com@gmail.com"]) {
      expect(allowedEmail([{ email, verified: true }], DOMAINS), email).toBeNull();
    }
    expect(allowedEmail([{ email: "me@umbraco.com", verified: false }], DOMAINS)).toBeNull();
  });
});

describe("safeNext — never off-site", () => {
  it("keeps a same-origin path, else /status", () => {
    expect(safeNext("/status?format=json")).toBe("/status?format=json");
    for (const bad of [null, "", "https://evil.io", "//evil.io", "/\\evil.io", "status"]) expect(safeNext(bad), String(bad)).toBe("/status");
  });
});

describe("GET /auth/login", () => {
  it("off (404) without the App's client ID, secret and a session key", () => {
    expect(handleLogin({}, new URL("https://w/auth/login")).status).toBe(404);
  });

  it("sends to GitHub with the client ID, this Worker's callback and a fresh state, kept in a short-lived cookie with where to go after", () => {
    const res = handleLogin(env, new URL("https://w.dev/auth/login?next=/status"));
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("Location")!);
    expect(to.origin + to.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(to.searchParams.get("client_id")).toBe("Iv1.abc");
    expect(to.searchParams.get("redirect_uri")).toBe("https://w.dev/auth/callback");
    const state = to.searchParams.get("state")!;
    expect(state.length).toBeGreaterThan(16);
    const cookie = res.headers.get("Set-Cookie")!;
    expect(cookie).toContain(`ao_oauth_state=${encodeURIComponent(`${state}|/status`)}`);
    expect(cookie).toMatch(/HttpOnly; Secure; SameSite=Lax; Max-Age=600/);
  });
});

describe("GET /auth/callback", () => {
  const callback = (state: string, cookieState: string | null, code = "the-code") =>
    new Request(`https://w.dev/auth/callback?code=${code}&state=${state}`, {
      headers: cookieState === null ? {} : { Cookie: `ao_oauth_state=${encodeURIComponent(cookieState)}` },
    });
  const github = (emails: { email: string; verified: boolean }[]) =>
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://github.com/login/oauth/access_token") {
        const body = JSON.parse(init!.body as string);
        expect(body).toMatchObject({ client_id: "Iv1.abc", client_secret: "cs", code: "the-code", redirect_uri: "https://w.dev/auth/callback" });
        return Response.json({ access_token: "ghu_x" });
      }
      expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer ghu_x");
      if (url === "https://api.github.com/user") return Response.json({ login: "octo" });
      if (url === "https://api.github.com/user/emails") return Response.json(emails);
      return new Response("?", { status: 404 });
    });

  it("a state that doesn't match its cookie (or none) -> 400, GitHub never asked", async () => {
    const fetchFn = github([]);
    for (const [state, saved] of [["abc", "xyz|/status"], ["abc", null], ["", "|/status"]] as const) {
      const res = await handleCallback(callback(state, saved), env, new URL(callback(state, saved).url), fetchFn as unknown as typeof fetch);
      expect(res.status, `${state} vs ${saved}`).toBe(400);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a verified Umbraco email -> a 7-day session cookie, back to where they were going", async () => {
    const req = callback("abc", "abc|/status?format=json");
    const res = await handleCallback(req, env, new URL(req.url), github([{ email: "octo@umbraco.dk", verified: true }]) as unknown as typeof fetch);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/status?format=json");
    const cookies = res.headers.get("Set-Cookie")!;
    expect(cookies).toMatch(/ao_session=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800/);
    const token = decodeURIComponent(cookies.match(/ao_session=([^;]+)/)![1]!);
    expect(await verifySession(token, "sess-key")).toMatchObject({ login: "octo", email: "octo@umbraco.dk" });
  });

  it("no verified Umbraco email -> 403, no session", async () => {
    const req = callback("abc", "abc|/status");
    for (const emails of [[{ email: "octo@gmail.com", verified: true }], [{ email: "octo@umbraco.com", verified: false }]]) {
      const res = await handleCallback(req, env, new URL(req.url), github(emails) as unknown as typeof fetch);
      expect(res.status).toBe(403);
      expect(res.headers.get("Set-Cookie")).toBeNull();
      expect(await res.text()).toContain("@umbraco.com or @umbraco.dk");
    }
  });

  it("GitHub refusing the code -> 502, no session", async () => {
    const req = callback("abc", "abc|/status");
    const res = await handleCallback(req, env, new URL(req.url), (async () => Response.json({ error: "bad_verification_code" })) as unknown as typeof fetch);
    expect(res.status).toBe(502);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });
});

describe("GET /auth/logout", () => {
  it("clears the session", () => {
    const res = handleLogout();
    expect(res.status).toBe(303);
    expect(res.headers.get("Set-Cookie")).toMatch(/^ao_session=; Path=\/; .*Max-Age=0/);
  });
});
