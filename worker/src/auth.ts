// Sign-in for the status dashboard: GitHub OAuth through the Worker's own
// GitHub App (its client ID and a client secret), limited to people with a
// verified email at an allowed domain (umbraco.com, umbraco.dk). The same
// shape as the Umbraco AI Academy's gate, with GitHub in place of Google:
// sign in, check the domain on the server, then a session cookie the
// Worker signs itself.
//
// - GET /auth/login?next=/status: off to GitHub, with a one-time `state`
//   in a short-lived cookie
// - GET /auth/callback: the state must match; the code is exchanged for a
//   user token, which reads the person's verified emails (the App needs
//   Account permissions -> Email addresses: Read-only) and is then dropped
// - GET /auth/logout: clears the session
//
// The session is `<payload>.<HMAC-SHA256>`, base64url, keyed with
// SESSION_SECRET; nothing is stored server-side.

import { MessagePage } from "./dashboard/views/repo";
import { htmlResponse } from "./dashboard/views/respond";

export type AuthEnv = {
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  // Comma-separated email domains allowed in (default umbraco.com,umbraco.dk).
  SIGN_IN_DOMAINS?: string;
};

export type Session = { login: string; email: string; exp: number };

const SESSION_COOKIE = "ao_session";
const STATE_COOKIE = "ao_oauth_state";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const STATE_TTL_SECONDS = 10 * 60;
const DEFAULT_DOMAINS = ["umbraco.com", "umbraco.dk"];

export const signInConfigured = (env: AuthEnv) =>
  !!(env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET && env.SESSION_SECRET);

export function allowedDomains(env: AuthEnv): string[] {
  const listed = (env.SIGN_IN_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  return listed.length > 0 ? listed : DEFAULT_DOMAINS;
}

/** The first verified email at an allowed domain, or null. The domain must
 * match exactly: "umbraco.com.evil.io" or "notumbraco.com" don't. */
export function allowedEmail(emails: { email: string; verified: boolean }[], domains: string[]): string | null {
  for (const e of emails) {
    const email = e.email.toLowerCase();
    const at = email.lastIndexOf("@");
    if (e.verified && at > 0 && domains.includes(email.slice(at + 1))) return email;
  }
  return null;
}

// --- signing ---------------------------------------------------------------

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const hmacKey = (secret: string) =>
  crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

export async function signSession(session: Session, secret: string): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(session)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(body)));
  return `${body}.${b64url(sig)}`;
}

export async function verifySession(token: string, secret: string, now = Date.now()): Promise<Session | null> {
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  try {
    // crypto.subtle.verify compares in constant time.
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(sig), new TextEncoder().encode(body));
    if (!ok) return null;
    const session = JSON.parse(new TextDecoder().decode(fromB64url(body))) as Session;
    if (typeof session.exp !== "number" || session.exp * 1000 <= now) return null;
    if (typeof session.login !== "string" || typeof session.email !== "string") return null;
    return session;
  } catch {
    return null;
  }
}

// --- cookies ---------------------------------------------------------------

export function getCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

const cookie = (name: string, value: string, maxAge: number, path = "/") =>
  `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

export async function readSession(request: Request, env: AuthEnv): Promise<Session | null> {
  if (!env.SESSION_SECRET) return null;
  const token = getCookie(request, SESSION_COOKIE);
  return token ? verifySession(token, env.SESSION_SECRET) : null;
}

/** Only a same-origin path, never an attacker's `next` off-site. Browsers
 * drop tabs and newlines from a URL and treat `\` as `/`, so "/\t/evil.io"
 * would read as "//evil.io": anything with those is refused, and what's
 * left must resolve to this origin. */
export function safeNext(raw: string | null): string {
  const fallback = "/status";
  if (!raw || !raw.startsWith("/") || /[\u0000-\u0020\u007f\\]/.test(raw)) return fallback;
  try {
    const base = "https://same-origin.invalid";
    const resolved = new URL(raw, base);
    return resolved.origin === base ? resolved.pathname + resolved.search : fallback;
  } catch {
    return fallback;
  }
}

// --- routes ----------------------------------------------------------------

const callbackUrl = (url: URL) => `${url.origin}/auth/callback`;

export function handleLogin(env: AuthEnv, url: URL): Response {
  if (!signInConfigured(env)) return new Response("not found", { status: 404 });
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const next = safeNext(url.searchParams.get("next"));
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.GITHUB_OAUTH_CLIENT_ID!);
  authorize.searchParams.set("redirect_uri", callbackUrl(url));
  authorize.searchParams.set("state", nonce);
  authorize.searchParams.set("allow_signup", "false");
  const headers = new Headers({ Location: authorize.toString() });
  // The state cookie carries where to go after, so `next` never rides on GitHub's URL.
  headers.append("Set-Cookie", cookie(STATE_COOKIE, `${nonce}|${next}`, STATE_TTL_SECONDS, "/auth"));
  return new Response(null, { status: 302, headers });
}

type Fetch = typeof fetch;

export async function handleCallback(request: Request, env: AuthEnv, url: URL, fetchFn: Fetch = fetch): Promise<Response> {
  if (!signInConfigured(env)) return new Response("not found", { status: 404 });
  const saved = getCookie(request, STATE_COOKIE) ?? "";
  const [nonce, next] = [saved.slice(0, saved.indexOf("|")), saved.slice(saved.indexOf("|") + 1)];
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!nonce || !state || state !== nonce || !code) {
    return page(400, "Sign-in expired or was interrupted. Try again.", true);
  }

  const tokenRes = await fetchFn("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl(url),
    }),
  });
  const token = ((await tokenRes.json().catch(() => ({}))) as { access_token?: string }).access_token;
  if (!tokenRes.ok || !token) return page(502, "GitHub didn't complete the sign-in. Try again.", true);

  const gh = (path: string) =>
    fetchFn(`https://api.github.com${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "agent-orchestration-worker" },
    });
  const [userRes, emailsRes] = await Promise.all([gh("/user"), gh("/user/emails")]);
  if (!userRes.ok || !emailsRes.ok) return page(502, "Couldn't read your GitHub account. Try again.", true);
  const { login } = (await userRes.json()) as { login: string };
  const emails = (await emailsRes.json()) as { email: string; verified: boolean }[];

  const domains = allowedDomains(env);
  const email = allowedEmail(Array.isArray(emails) ? emails : [], domains);
  if (!email) {
    return page(403, `Access is limited to GitHub accounts with a verified ${domains.map((d) => `@${d}`).join(" or ")} email.`, false);
  }

  const session = await signSession({ login, email, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS }, env.SESSION_SECRET!);
  const headers = new Headers({ Location: safeNext(next) });
  headers.append("Set-Cookie", cookie(SESSION_COOKIE, session, SESSION_TTL_SECONDS));
  headers.append("Set-Cookie", cookie(STATE_COOKIE, "", 0, "/auth"));
  return new Response(null, { status: 303, headers });
}

export function handleLogout(): Response {
  const headers = new Headers({ Location: "/auth/signed-out" });
  headers.append("Set-Cookie", cookie(SESSION_COOKIE, "", 0));
  return new Response(null, { status: 303, headers });
}

export const signedOut = () => page(200, "You're signed out.", true);

/** A sign-in outcome, as a dashboard page (no one signed in yet). */
function page(status: number, message: string, retry: boolean): Promise<Response> {
  const action = retry ? { href: "/auth/login?next=/status", label: "Sign in with GitHub" } : undefined;
  return htmlResponse(MessagePage({ title: "Orchestrator status", message, action }), status);
}
