/**
 * GitHub App installation token minting via Web Crypto API.
 *
 * Mints a short-lived installation access token from GitHub App credentials.
 * Uses `crypto.subtle` only — no Node.js `crypto` module (Cloudflare Workers
 * compatible). No `process.env`; all credentials are passed as arguments.
 *
 * Flow:
 *   1. Build a JWT signed with RS256 using the app's RSA private key PEM.
 *   2. POST to the GitHub API to exchange the JWT for an installation token.
 *   3. Return the installation token string.
 *
 * Security / credential-exposure posture:
 *   - The private key PEM is accepted as a parameter and used only in memory
 *     during this call; it is never logged, stored, or included in error messages.
 *   - Error paths log only the HTTP status code and generic text from GitHub's
 *     response body — the JWT and the derived installation token are never emitted.
 *   - The returned installation token is short-lived (≤1 hour per GitHub's contract)
 *     and must be treated as a secret by the caller.
 *   - No hardcoded credentials exist in this file; all secrets arrive via Worker
 *     bindings (`env.FACTORY_APP_PRIVATE_KEY`, etc.) which are injected at runtime
 *     and never stored in `wrangler.jsonc` vars.
 */

const GITHUB_API = 'https://api.github.com';

// AbortSignal.timeout is used on every fetch call in this module (10 s).
// All outbound requests must have explicit timeouts in Cloudflare Workers
// to prevent hanging indefinitely and consuming the CPU budget.
const GITHUB_API_TIMEOUT_MS = 10_000;

/**
 * Decode a base64 string to a Uint8Array, handling both standard and
 * URL-safe base64 variants.
 */
function base64ToUint8Array(b64: string): Uint8Array {
  // Normalize URL-safe base64 to standard base64
  const standard = b64.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(standard);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encode a Uint8Array to URL-safe base64 without padding — the format
 * required for JWT components.
 */
function uint8ArrayToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * JSON-encode an object and base64url-encode the UTF-8 bytes — standard
 * JWT segment encoding.
 */
function encodeJwtSegment(obj: Record<string, unknown>): string {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  return uint8ArrayToBase64Url(bytes);
}

/**
 * Strip PEM armor and whitespace, returning the raw base64 DER body of the
 * private key so it can be imported by `crypto.subtle`.
 */
function pemToDer(pem: string): Uint8Array {
  const lines = pem
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('-----'));
  return base64ToUint8Array(lines.join(''));
}

/**
 * Import an RSA private key PEM string as a `CryptoKey` for RS256 signing.
 */
async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  const der = pemToDer(pem);
  // Copy into a plain ArrayBuffer so the strict Workers type constraint
  // (BufferSource requires ArrayBuffer, not ArrayBufferLike) is satisfied.
  const buf = der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer;
  return crypto.subtle.importKey(
    'pkcs8',
    buf,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/**
 * Build and sign a GitHub App JWT.
 *
 * Per GitHub docs the payload must be:
 *   - `iat`: current time minus 60 seconds (clock-skew buffer)
 *   - `exp`: current time plus 540 seconds (9 minutes; max is 10 minutes)
 *   - `iss`: the numeric GitHub App ID
 *
 * @param appId - The numeric GitHub App ID (as a string).
 * @param privateKeyPem - The RSA private key PEM string.
 * @returns A signed JWT string.
 */
async function buildAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = encodeJwtSegment({ alg: 'RS256', typ: 'JWT' });
  const payload = encodeJwtSegment({ iat: now - 60, exp: now + 540, iss: appId });

  const signingInput = `${header}.${payload}`;
  const signingBytes = new TextEncoder().encode(signingInput);

  const key = await importRsaPrivateKey(privateKeyPem);
  const signatureBuffer = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    signingBytes,
  );

  const signature = uint8ArrayToBase64Url(new Uint8Array(signatureBuffer));
  return `${signingInput}.${signature}`;
}

/**
 * Mint a short-lived GitHub App installation access token.
 *
 * The returned token is valid for up to 1 hour and carries the permissions
 * configured for the installation. Pass it as a Bearer token in subsequent
 * GitHub API calls.
 *
 * @param appId - The numeric GitHub App ID (e.g. `"123456"`).
 * @param privateKeyPem - The RSA private key PEM from the app credentials.
 * @param installationId - The installation ID for the target org/repo.
 * @returns A short-lived installation access token string.
 * @throws If JWT signing fails or the GitHub API returns a non-2xx status.
 */
export async function getInstallationToken(
  appId: string,
  privateKeyPem: string,
  installationId: string,
): Promise<string> {
  const jwt = await buildAppJwt(appId, privateKeyPem);

  const url = `${GITHUB_API}/app/installations/${installationId}/access_tokens`;
  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS), // prevents indefinite hang
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
        'User-Agent': 'factory-supervisor',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    // Truncate the GitHub response body to 200 chars before including it in the
    // error message. GitHub error bodies are typically safe (e.g. "Bad credentials"),
    // but we truncate to bound any unexpected response size and avoid inadvertently
    // propagating internal details. The JWT and private key are never logged here.
    const text = await res.text().catch(() => '(no body)');
    throw new Error(
      `getInstallationToken: GitHub API error ${res.status} for installation ${installationId}: ${text.slice(0, 200)}`,
    );
  }

  const data = (await res.json()) as { token: string };
  if (!data.token) {
    throw new Error('getInstallationToken: response missing token field');
  }
  return data.token;
}
