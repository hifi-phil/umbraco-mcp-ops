// The decision log and build log over HTTP (docs/agent-orchestration/16-work-log.md):
// the token a fire carries, POST /log and GET /log, and the export a merged
// PR gets. The routines call these through the work-log skill's
// log-entry.sh; nothing else writes the log.
//
// The token is the fire's own: owner, repo, item (the issue or PR fired
// for), routine, an expiry and a random id, signed with HMAC-SHA256 under
// ROUTINE_SIGNAL_SECRET (no new secret). It lets its holder add entries to
// that one item (at most MAX_ENTRIES_PER_TOKEN) and read any item in the
// same repo, so a review on a PR can read the issue's decisions. A routine
// that read hostile text can at worst add short entries to its own item.

import * as logEntries from "./db/log-entries";
import { LOG_CATEGORIES, type LogCategory, type LogEntry } from "./db/log-entries";

export const MAX_BODY_BYTES = 4096;
export const MAX_ENTRIES_PER_TOKEN = 50;

export type LogClaims = { owner: string; repo: string; item: number; routine: string; exp: number; jti: string };

const enc = new TextEncoder();

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/** A token for one fire: valid for `ttlMinutes` from `now`. */
export async function mintLogToken(
  secret: string,
  claims: { owner: string; repo: string; item: number; routine: string },
  ttlMinutes: number,
  now = Date.now(),
): Promise<string> {
  const jti = b64url(crypto.getRandomValues(new Uint8Array(9)));
  const full: LogClaims = { ...claims, owner: claims.owner.toLowerCase(), repo: claims.repo.toLowerCase(), exp: now + ttlMinutes * 60_000, jti };
  const payload = b64url(enc.encode(JSON.stringify(full)));
  return `${payload}.${b64url(await hmac(secret, payload))}`;
}

/** The token's claims, or null if it's malformed, forged or expired. */
export async function verifyLogToken(secret: string, token: string, now = Date.now()): Promise<LogClaims | null> {
  const [payload, sig, ...rest] = token.split(".");
  if (!payload || !sig || rest.length > 0) return null;
  let expected: Uint8Array;
  let given: Uint8Array;
  try {
    expected = await hmac(secret, payload);
    given = fromB64url(sig);
  } catch {
    return null;
  }
  if (given.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given[i]! ^ expected[i]!;
  if (diff !== 0) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as LogClaims;
    if (typeof claims.exp !== "number" || claims.exp < now) return null;
    if (!claims.owner || !claims.repo || !Number.isInteger(claims.item) || !claims.routine || !claims.jti) return null;
    return claims;
  } catch {
    return null;
  }
}

type WorkLogEnv = { DB: D1Database; ROUTINE_SIGNAL_SECRET?: string };

async function claimsFrom(request: Request, env: WorkLogEnv): Promise<LogClaims | Response> {
  // No secret, no tokens were minted: the log is off.
  if (!env.ROUTINE_SIGNAL_SECRET) return new Response("not found", { status: 404 });
  const auth = request.headers.get("Authorization") ?? "";
  const claims = auth.startsWith("Bearer ") ? await verifyLogToken(env.ROUTINE_SIGNAL_SECRET, auth.slice(7)) : null;
  return claims ?? new Response("unauthorized: a missing, forged or expired log_token", { status: 401 });
}

/** POST /log: one entry, on the token's own item. */
export async function handleLogAdd(request: Request, env: WorkLogEnv): Promise<Response> {
  const claims = await claimsFrom(request, env);
  if (claims instanceof Response) return claims;
  let input: { kind?: unknown; category?: unknown; body?: unknown };
  try {
    input = await request.json();
  } catch {
    return new Response("invalid JSON body", { status: 400 });
  }
  const { kind, category, body } = input;
  if (kind !== "decision" && kind !== "build") return new Response("kind must be decision or build", { status: 400 });
  if (kind === "decision" && !LOG_CATEGORIES.includes(category as LogCategory)) {
    return new Response(`a decision needs a category: ${LOG_CATEGORIES.join(", ")}`, { status: 400 });
  }
  if (typeof body !== "string" || body.trim() === "") return new Response("body is required", { status: 400 });
  if (enc.encode(body).length > MAX_BODY_BYTES) return new Response(`body over ${MAX_BODY_BYTES} bytes`, { status: 413 });
  if ((await logEntries.countForToken(env.DB, claims.jti)) >= MAX_ENTRIES_PER_TOKEN) {
    return new Response(`this run has added ${MAX_ENTRIES_PER_TOKEN} entries, the most it may`, { status: 429 });
  }
  const id = await logEntries.add(env.DB, {
    owner: claims.owner,
    repo: claims.repo,
    item: claims.item,
    kind,
    category: kind === "decision" ? (category as LogCategory) : null,
    routine: claims.routine,
    body,
    tokenId: claims.jti,
  });
  return Response.json({ id });
}

/** GET /log?item=<n>: an item's entries, any item in the token's repo. */
export async function handleLogRead(request: Request, env: WorkLogEnv, url: URL): Promise<Response> {
  const claims = await claimsFrom(request, env);
  if (claims instanceof Response) return claims;
  const item = Number(url.searchParams.get("item"));
  if (!Number.isInteger(item) || item <= 0) return new Response("item is required", { status: 400 });
  return Response.json({ entries: await logEntries.forItems(env.DB, claims.owner, claims.repo, [item]) });
}

/** The comment a merged PR gets: its entries and those of the issues it
 * closes, as a permanent copy (D1 goes with the deployment). Null when
 * there's nothing to export. */
export function exportComment(pr: number, entries: LogEntry[]): string | null {
  if (entries.length === 0) return null;
  const decisions = entries.filter((e) => e.kind === "decision");
  const builds = entries.filter((e) => e.kind === "build");
  const where = (e: LogEntry) => (e.item === pr ? "this PR" : `#${e.item}`);
  const block = (e: LogEntry) =>
    `**${e.kind === "decision" ? e.category : "build"}** · ${e.routine} · ${where(e)} · ${e.created_at} UTC\n\n` +
    e.body
      .trim()
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
  const section = (title: string, list: LogEntry[]) => (list.length === 0 ? [] : [`### ${title} (${list.length})`, ...list.map(block)]);
  return [
    `📒 **Work log** for this PR and the issues it closes, as the routines recorded it. (Automatic, from the orchestrator.)`,
    ...section("Decisions", decisions),
    ...section("Build log", builds),
  ].join("\n\n");
}
