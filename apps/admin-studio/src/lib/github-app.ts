/**
 * GitHub API authentication for the admin-studio Worker.
 *
 * Prefers a **GitHub App installation token** minted on demand from the
 * long-lived `FACTORY_APP_*` credentials (App ID + PKCS#8 private key +
 * installation ID) — so there is no PAT to rotate every 90 days. Installation
 * tokens last ~1h and are cached in-isolation. Falls back to a static
 * `GITHUB_TOKEN` PAT when the App credentials aren't configured, so the worker
 * keeps working before and during the migration off PATs.
 *
 * Workers-safe: the App JWT is signed with the Web Crypto API
 * (`RSASSA-PKCS1-v1_5` / SHA-256) — no `node:crypto`, no `jsonwebtoken`.
 */
import type { Env } from '../env.js';

const TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;
/** Refresh this far ahead of the stated expiry to avoid using a token mid-expiry. */
const EXPIRY_SKEW_MS = 120_000;

/** Cached installation token. Module-scoped is safe: one installation per worker. */
let cachedToken: { token: string; expiresAtMs: number } | null = null;

/** Build a short-lived (5 min) GitHub App JWT, signed via Web Crypto (RS256). */
async function buildAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const b64u = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const signingInput = `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u({ iat: now - 30, exp: now + 300, iss: appId })}`;

  const pemBody = privateKeyPem.replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s/g, '');
  const der = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'pkcs8',
      der,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } catch {
    throw new Error('Failed to parse FACTORY_APP_PRIVATE_KEY: key must be a PKCS#8 PEM (RS256)');
  }
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${signingInput}.${sigB64}`;
}

/** Exchange the App JWT for a short-lived installation access token. */
async function mintInstallationToken(
  appId: string,
  privateKeyPem: string,
  installationId: string,
): Promise<{ token: string; expiresAtMs: number }> {
  const jwt = await buildAppJwt(appId, privateKeyPem);
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'factory-admin-studio',
      },
      signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    throw new Error(`GitHub App token exchange failed ${res.status}: ${await res.text()}`);
  }
  const json = await res.json<{ token: string; expires_at?: string }>();
  const expiresAtMs = json.expires_at ? Date.parse(json.expires_at) : Date.now() + 55 * 60_000;
  return { token: json.token, expiresAtMs };
}

/** True when any GitHub credential (App or PAT) is configured. */
export function hasGithubAuth(env: Env): boolean {
  return Boolean(
    (env.FACTORY_APP_ID && env.FACTORY_APP_PRIVATE_KEY && env.FACTORY_APP_INSTALLATION_ID) ||
      env.GITHUB_TOKEN,
  );
}

/**
 * Resolve a GitHub API token: a cached/minted **App installation token** when the
 * `FACTORY_APP_*` creds exist, else the static `GITHUB_TOKEN` PAT. Throws when
 * neither is configured (callers should guard with {@link hasGithubAuth}).
 */
export async function getGithubToken(env: Env): Promise<string> {
  const { FACTORY_APP_ID, FACTORY_APP_PRIVATE_KEY, FACTORY_APP_INSTALLATION_ID } = env;
  if (FACTORY_APP_ID && FACTORY_APP_PRIVATE_KEY && FACTORY_APP_INSTALLATION_ID) {
    if (cachedToken && cachedToken.expiresAtMs - Date.now() > EXPIRY_SKEW_MS) {
      return cachedToken.token;
    }
    cachedToken = await mintInstallationToken(
      FACTORY_APP_ID,
      FACTORY_APP_PRIVATE_KEY,
      FACTORY_APP_INSTALLATION_ID,
    );
    return cachedToken.token;
  }
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  throw new Error('No GitHub credentials configured (need FACTORY_APP_* or GITHUB_TOKEN)');
}
