import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import { isEnvironment, isRole, type EnvJWTPayload } from '@latimer-woods-tech/studio-core';

const auth = new Hono<AppEnv>();
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

interface LoginRequest {
  email?: unknown;
  password?: unknown;
  env?: unknown;
  app?: unknown;
}

interface GoogleLoginRequest {
  credential?: unknown;
  env?: unknown;
  app?: unknown;
}

interface GoogleIdTokenHeader {
  alg?: unknown;
  kid?: unknown;
  typ?: unknown;
}

interface GoogleIdTokenPayload {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  iat?: unknown;
  nbf?: unknown;
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
}

interface GoogleJwk extends JsonWebKey {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
}

interface GoogleJwksResponse {
  keys?: GoogleJwk[];
}

/**
 * POST /auth/login
 *
 * Body: { email, password, env, app? }
 *
 * Returns a JWT carrying the env claim. The client must pick env *before*
 * authenticating — Studio refuses to issue a token without it.
 *
 * Phase A: bootstrap credentials check against Worker secrets. Phase B replaces
 * this with `studio_users` and per-user password hashes / session controls.
 */
auth.post('/login', async (c) => {
  const body = await c.req.json<LoginRequest>();

  if (typeof body.email !== 'string' || typeof body.password !== 'string') {
    return c.json({ error: 'Missing credentials' }, 400);
  }
  if (!isEnvironment(body.env)) {
    return c.json({ error: 'Invalid env — must be local | staging | production' }, 400);
  }
  if (body.env !== c.env.STUDIO_ENV) {
    return c.json(
      {
        error: `This studio worker only issues tokens for env '${c.env.STUDIO_ENV}'`,
      },
      400,
    );
  }

  if (!c.env.STUDIO_ADMIN_EMAIL || !c.env.STUDIO_ADMIN_PASSWORD_SHA256) {
    return c.json({ error: 'Studio bootstrap credentials are not configured' }, 503);
  }

  const email = body.email.trim().toLowerCase();
  const configuredEmail = c.env.STUDIO_ADMIN_EMAIL.trim().toLowerCase();
  const passwordHash = await sha256Hex(body.password);
  const configuredPasswordHash = c.env.STUDIO_ADMIN_PASSWORD_SHA256.trim().toLowerCase();
  const validCredentials = email === configuredEmail
    && constantTimeEqualHex(passwordHash, configuredPasswordHash);

  if (!validCredentials) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const stubRole = 'owner'; // bootstrap operator
  if (!isRole(stubRole)) {
    return c.json({ error: 'Misconfigured role' }, 500);
  }

  const now = Math.floor(Date.now() / 1000);
  const exp = now + (body.env === 'production' ? 4 * 3600 : 24 * 3600);

  const payload: EnvJWTPayload = {
    iat: now,
    exp,
    iss: 'factory-admin-studio',
    sub: email,
    env: body.env,
    app: typeof body.app === 'string' ? body.app : undefined,
    sessionId: crypto.randomUUID(),
    userId: email, // bootstrap: email-as-id; replace with UUID in Phase B
    userEmail: email,
    role: stubRole,
    envLockedAt: Date.now(),
  };

  const jwt = await signJwt(payload, c.env.JWT_SECRET);
  return c.json({ token: jwt, expiresAt: exp * 1000 });
});

/**
 * POST /auth/google
 *
 * Body: { credential: "<Google ID token>", env: "production" | "staging" | "local" }
 *
 * Verifies the Google ID token against Google's public keys (JWKS),
 * then issues a Factory JWT with env lock-in. The client must still pick env
 * before submitting the Google credential.
 */
auth.post('/google', async (c) => {
  const body = await c.req.json<GoogleLoginRequest>();

  if (typeof body.credential !== 'string' || body.credential.trim().length === 0) {
    return c.json({ error: 'Missing Google credential' }, 400);
  }
  if (!isEnvironment(body.env)) {
    return c.json({ error: 'Invalid env — must be local | staging | production' }, 400);
  }
  if (body.env !== c.env.STUDIO_ENV) {
    return c.json(
      {
        error: `This studio worker only issues tokens for env '${c.env.STUDIO_ENV}'`,
      },
      400,
    );
  }

  const googleClientId = c.env.GOOGLE_CLIENT_ID;
  if (!googleClientId) {
    return c.json({ error: 'Google sign-in is not configured' }, 503);
  }

  let verifiedEmail: string;
  try {
    verifiedEmail = await verifyGoogleIdToken(body.credential, googleClientId, fetch);
  } catch (error) {
    return c.json({ error: 'Invalid Google credential', detail: (error as Error).message }, 401);
  }

  // Extract allowed users from env, fall back to empty list if not configured
  const allowedUsersJson = c.env.STUDIO_ALLOWED_USERS_JSON || '{}';
  let allowedUsers: Record<string, { role: string }>;
  try {
    allowedUsers = JSON.parse(allowedUsersJson) as Record<string, { role: string }>;
  } catch {
    allowedUsers = {};
  }

  const userConfig = allowedUsers[verifiedEmail];
  if (!userConfig || !userConfig.role) {
    return c.json(
      {
        error: 'Access denied',
        detail: `Email '${verifiedEmail}' is not in the allowlisted users for this environment`,
      },
      403,
    );
  }

  if (!isRole(userConfig.role)) {
    return c.json({ error: 'Misconfigured role', detail: `Invalid role '${userConfig.role}'` }, 500);
  }

  const now = Math.floor(Date.now() / 1000);
  const exp = now + (body.env === 'production' ? 4 * 3600 : 24 * 3600);

  const payload: EnvJWTPayload = {
    iat: now,
    exp,
    iss: 'factory-admin-studio',
    sub: verifiedEmail,
    env: body.env,
    app: typeof body.app === 'string' ? body.app : undefined,
    sessionId: crypto.randomUUID(),
    userId: verifiedEmail, // TODO: Phase B — replace with UUID
    userEmail: verifiedEmail,
    role: userConfig.role,
    envLockedAt: Date.now(),
  };

  const jwt = await signJwt(payload, c.env.JWT_SECRET);
  return c.json({ token: jwt, expiresAt: exp * 1000 });
});

/**
 * POST /auth/logout — client-side discards token; we just acknowledge.
 * In Phase B we add a session blocklist table for forced logouts.
 */
/**
 * GET /auth/config — public endpoint returning non-secret GSI config.
 * client_id is a public OAuth identifier (safe to expose in responses).
 */
auth.get('/config', (c) => {
  return c.json({
    googleClientId: c.env.GOOGLE_CLIENT_ID || null,
  });
});

auth.post('/logout', (c) => c.json({ ok: true }));

export default auth;

// ─── Google ID token verification (Web Crypto only, no crypto package) ──────
/**
 * Verify a Google ID token by:
 * 1. Decoding the JWT (no validation yet)
 * 2. Fetching Google's JWKS (cached externally)
 * 3. Verifying the signature against Google's key
 * 4. Validating required claims (aud, iss, exp, email_verified)
 * 5. Returning the verified email address
 */
async function verifyGoogleIdToken(
  token: string,
  expectedAudience: string,
  fetchFn: typeof fetch,
): Promise<string> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed Google ID token');
  }

  const headerB64 = parts[0]!;
  const payloadB64 = parts[1]!;
  const signatureB64 = parts[2]!;

  // Decode header to get the key ID (kid)
  let header: GoogleIdTokenHeader;
  try {
    const headerJson = new TextDecoder().decode(base64UrlToBytes(headerB64));
    header = JSON.parse(headerJson) as GoogleIdTokenHeader;
  } catch {
    throw new Error('Invalid header in Google ID token');
  }

  if (header.alg !== 'RS256') {
    throw new Error(`Unsupported algorithm: ${header.alg}`);
  }
  if (typeof header.kid !== 'string') {
    throw new Error('Missing kid in Google ID token header');
  }

  // Decode payload (unverified yet)
  let payload: GoogleIdTokenPayload;
  try {
    const payloadJson = new TextDecoder().decode(base64UrlToBytes(payloadB64));
    payload = JSON.parse(payloadJson) as GoogleIdTokenPayload;
  } catch {
    throw new Error('Invalid payload in Google ID token');
  }

  // Fetch Google's public keys
  const jwksRes = await fetchFn(GOOGLE_JWKS_URL);
  if (!jwksRes.ok) {
    throw new Error(`Failed to fetch Google JWKS: ${jwksRes.status}`);
  }
  const jwksData = (await jwksRes.json()) as GoogleJwksResponse;
  const keys = jwksData.keys || [];

  // Find the key matching the kid
  const key = keys.find((k) => k.kid === header.kid);
  if (!key) {
    throw new Error(`No matching key found for kid: ${header.kid}`);
  }

  // Verify the signature using Web Crypto
  if (key.kty !== 'RSA' || !key.n || !key.e) {
    throw new Error('Invalid key type or missing RSA parameters');
  }

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'RSA',
      n: key.n,
      e: key.e,
      alg: 'RS256',
      ext: true,
    },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const signatureBytes = base64UrlToBytes(signatureB64);
  const dataBytes = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const isValid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    signatureBytes as BufferSource,
    dataBytes as BufferSource,
  );

  if (!isValid) {
    throw new Error('Invalid signature');
  }

  // Validate required claims
  if (payload.iss !== 'https://accounts.google.com') {
    throw new Error(`Invalid issuer: ${payload.iss}`);
  }
  if (payload.aud !== expectedAudience) {
    throw new Error(`Audience mismatch: expected ${expectedAudience}, got ${payload.aud}`);
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) {
    throw new Error('Token expired');
  }
  if (typeof payload.iat !== 'number' || payload.iat > now) {
    throw new Error('Token not yet valid');
  }
  if (payload.email_verified !== true) {
    throw new Error('Email not verified by Google');
  }
  if (typeof payload.email !== 'string' || payload.email.trim().length === 0) {
    throw new Error('No email claim in Google ID token');
  }

  return payload.email;
}

// ─── HS256 signer (Web Crypto only) ─────────────────────────────────────────
async function signJwt(payload: EnvJWTPayload, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encode = (obj: unknown): string =>
    base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));

  const headerB64 = encode(header);
  const payloadB64 = encode(payload);
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, data);
  return `${headerB64}.${payloadB64}.${base64UrlEncode(new Uint8Array(sig))}`;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function constantTimeEqualHex(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    return false;
  }

  let diff = actual.length ^ expected.length;
  const maxLength = Math.max(actual.length, expected.length);
  for (let i = 0; i < maxLength; i++) {
    const actualCode = actual.charCodeAt(i) || 0;
    const expectedCode = expected.charCodeAt(i) || 0;
    diff |= actualCode ^ expectedCode;
  }
  return diff === 0;
}
