// GitHub App auth, so the Worker reads and writes GitHub as its own bot
// (`<app-slug>[bot]`) instead of a person's token. A JWT signed with the
// App's private key (RS256) proves it's the App; GitHub swaps that, per
// repo, for an installation token (an hour's life). Tokens are cached per
// repo until five minutes before they expire, per Worker isolate.
//
// The key can be GitHub's download as-is (PKCS#1, "BEGIN RSA PRIVATE KEY"),
// or PKCS#8 ("BEGIN PRIVATE KEY"); pkcs8Der wraps the first into the second,
// which is all Web Crypto can import.

export type GitHubAppEnv = {
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_API_BASE_URL?: string;
};

export function appConfigured(env: GitHubAppEnv): boolean {
  return !!env.GITHUB_APP_ID && !!env.GITHUB_APP_PRIVATE_KEY;
}

const b64url = (data: Uint8Array | string): string => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** A DER length: short form under 128, else 0x8n and n big-endian bytes. */
function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

/**
 * The key as PKCS#8 DER, which is all Web Crypto imports. GitHub's download
 * is PKCS#1 ("BEGIN RSA PRIVATE KEY"), so that's wrapped here: PKCS#8 is the
 * PKCS#1 key in an OCTET STRING after version 0 and the rsaEncryption
 * algorithm identifier. A key already in PKCS#8 passes through.
 */
function pkcs8Der(pem: string): ArrayBuffer {
  const pkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
  const body = pem.replace(/-----(BEGIN|END) (RSA )?PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const der = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  if (!pkcs1) return der.buffer;

  const version = [0x02, 0x01, 0x00];
  const rsaEncryption = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octets = [0x04, ...derLength(der.length)];
  const contentLength = version.length + rsaEncryption.length + octets.length + der.length;
  const out = new Uint8Array([0x30, ...derLength(contentLength), ...version, ...rsaEncryption, ...octets, ...der]);
  return out.buffer;
}

/** The App's own JWT: 10 minutes at most, iat a minute back for clock drift. */
export async function appJwt(appId: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8Der(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signingInput = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
    JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId }),
  )}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput)));
  return `${signingInput}.${b64url(sig)}`;
}

let botLogin: Promise<string> | undefined;

/** The App's own login, `<slug>[bot]`, from GET /app (cached per isolate):
 * what the self-trigger guard drops label echoes from. */
export function appBotLogin(env: GitHubAppEnv): Promise<string> {
  botLogin ??= (async () => {
    const jwt = await appJwt(env.GITHUB_APP_ID!, env.GITHUB_APP_PRIVATE_KEY!);
    const res = await appFetch(env, "GET", "/app", jwt);
    if (!res.ok) throw new Error(`GitHub App lookup failed: ${res.status} ${await res.text()}`);
    const { slug } = (await res.json()) as { slug: string };
    return `${slug}[bot]`;
  })().catch((e) => {
    botLogin = undefined; // retry next time
    throw e;
  });
  return botLogin;
}

const cache = new Map<string, { token: string; expiresAt: number }>();
const REFRESH_MS = 5 * 60_000;

/** For tests. */
export function resetInstallationTokenCache(): void {
  cache.clear();
  botLogin = undefined;
}

async function appFetch(env: GitHubAppEnv, method: string, path: string, jwt: string): Promise<Response> {
  return fetch(`${env.GITHUB_API_BASE_URL ?? "https://api.github.com"}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agent-orchestration-worker",
    },
  });
}

/** A token for the App's installation on owner/repo. */
export async function installationToken(env: GitHubAppEnv, owner: string, repo: string, now = Date.now()): Promise<string> {
  const key = `${owner}/${repo}`.toLowerCase();
  const hit = cache.get(key);
  if (hit && hit.expiresAt - REFRESH_MS > now) return hit.token;

  const jwt = await appJwt(env.GITHUB_APP_ID!, env.GITHUB_APP_PRIVATE_KEY!, Math.floor(now / 1000));
  const installation = await appFetch(env, "GET", `/repos/${owner}/${repo}/installation`, jwt);
  if (installation.status === 404) throw new Error(`the GitHub App isn't installed on ${owner}/${repo}`);
  if (!installation.ok) throw new Error(`GitHub App installation lookup for ${owner}/${repo} failed: ${installation.status} ${await installation.text()}`);
  const { id } = (await installation.json()) as { id: number };

  const issued = await appFetch(env, "POST", `/app/installations/${id}/access_tokens`, jwt);
  if (!issued.ok) throw new Error(`GitHub App token for ${owner}/${repo} failed: ${issued.status} ${await issued.text()}`);
  const { token, expires_at } = (await issued.json()) as { token: string; expires_at: string };
  cache.set(key, { token, expiresAt: Date.parse(expires_at) });
  return token;
}
