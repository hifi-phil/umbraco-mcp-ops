// GitHub App auth, so the Worker reads and writes GitHub as its own bot
// (`<app-slug>[bot]`) instead of a person's token. A JWT signed with the
// App's private key (RS256) proves it's the App; GitHub swaps that, per
// repo, for an installation token (an hour's life). Tokens are cached per
// repo until five minutes before they expire, per Worker isolate.
//
// The key must be PKCS#8 ("BEGIN PRIVATE KEY"): Web Crypto can't import the
// PKCS#1 ("BEGIN RSA PRIVATE KEY") file GitHub downloads. Convert it once:
//   openssl pkcs8 -topk8 -nocrypt -in <downloaded>.pem -out app.pkcs8.pem

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

function pkcs8Der(pem: string): ArrayBuffer {
  if (pem.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY is PKCS#1; convert it to PKCS#8: openssl pkcs8 -topk8 -nocrypt -in <key>.pem -out app.pkcs8.pem",
    );
  }
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return der.buffer;
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
