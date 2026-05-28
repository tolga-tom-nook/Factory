/**
 * Operator auth routes for QA Tools.
 *
 * Mirrors the Admin Studio credential policy:
 * - Primary: Google Workspace sign-in with allowlisted users.
 * - Break-glass: shared bootstrap email/password from platform secrets.
 */

import { Hono } from 'hono';
import type { Env } from '../env.js';
import type { AppId, QaRole } from '../types.js';
import { VALID_APP_IDS } from '../types.js';
import { mintQaJwt } from '../middleware/auth.js';

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

interface LoginRequest {
  email?: unknown;
  password?: unknown;
}

interface GoogleLoginRequest {
  credential?: unknown;
}

interface AllowedUser {
  role?: unknown;
  app_ids?: unknown;
}

interface GoogleIdTokenHeader {
  alg?: unknown;
  kid?: unknown;
}

interface GoogleIdTokenPayload {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  iat?: unknown;
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  hd?: unknown;
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

interface VerifiedGoogleIdentity {
  email: string;
  hostedDomain: string | null;
}

const authRouter = new Hono<{ Bindings: Env }>();

authRouter.get('/config', (c) => {
  return c.json({
    googleClientId: c.env.GOOGLE_CLIENT_ID || null,
    hostedDomain: c.env.QA_TOOLS_GOOGLE_WORKSPACE_DOMAIN || null,
  });
});

authRouter.post('/login', async (c) => {
  const body = await c.req.json<LoginRequest>().catch((): LoginRequest => ({}));
  if (typeof body.email !== 'string' || typeof body.password !== 'string') {
    return c.json({ error: 'Missing credentials' }, 400);
  }

  if (!c.env.QA_TOOLS_ADMIN_EMAIL || !c.env.QA_TOOLS_ADMIN_PASSWORD_SHA256) {
    return c.json({ error: 'QA Tools bootstrap credentials are not configured' }, 503);
  }

  const email = body.email.trim().toLowerCase();
  const configuredEmail = c.env.QA_TOOLS_ADMIN_EMAIL.trim().toLowerCase();
  const passwordHash = await sha256Hex(body.password);
  const configuredPasswordHash = c.env.QA_TOOLS_ADMIN_PASSWORD_SHA256.trim().toLowerCase();

  if (email !== configuredEmail || !constantTimeEqualHex(passwordHash, configuredPasswordHash)) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  return c.json(await issueQaSession(c.env, {
    sub: email,
    email,
    role: 'qa_admin',
  }));
});

authRouter.post('/google', async (c) => {
  const body = await c.req.json<GoogleLoginRequest>().catch((): GoogleLoginRequest => ({}));
  if (typeof body.credential !== 'string' || body.credential.trim().length === 0) {
    return c.json({ error: 'Missing Google credential' }, 400);
  }

  if (!c.env.GOOGLE_CLIENT_ID) {
    return c.json({ error: 'Google sign-in is not configured' }, 503);
  }

  let identity: VerifiedGoogleIdentity;
  try {
    identity = await verifyGoogleIdToken(body.credential, c.env.GOOGLE_CLIENT_ID, fetch);
  } catch (error) {
    return c.json({ error: 'Invalid Google credential', detail: (error as Error).message }, 401);
  }

  const domainError = getWorkspaceDomainError(identity, c.env.QA_TOOLS_GOOGLE_WORKSPACE_DOMAIN);
  if (domainError) {
    return c.json({ error: 'Access denied', detail: domainError }, 403);
  }

  const allowedUsers = parseAllowedUsers(c.env.QA_TOOLS_ALLOWED_USERS_JSON);
  const user = allowedUsers[identity.email.toLowerCase()];
  if (!user) {
    return c.json(
      {
        error: 'Access denied',
        detail: `Email '${identity.email}' is not allowlisted for QA Tools`,
      },
      403,
    );
  }

  return c.json(await issueQaSession(c.env, {
    sub: identity.email,
    email: identity.email,
    role: user.role,
    app_ids: user.app_ids,
  }));
});

authRouter.post('/logout', (c) => c.json({ ok: true }));

async function issueQaSession(
  env: Env,
  claims: { sub: string; email: string; role: QaRole; app_ids?: AppId[] },
): Promise<{ token: string; expiresAt: number; user: { email: string; role: QaRole; app_ids?: AppId[] } }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 4 * 3600;
  const token = await mintQaJwt(
    {
      sub: claims.sub,
      email: claims.email,
      role: claims.role,
      app_ids: claims.app_ids,
      aud: 'qa-tools',
      exp,
      iat: now,
    },
    env.QA_TOOLS_JWT_SECRET,
  );

  return {
    token,
    expiresAt: exp * 1000,
    user: {
      email: claims.email,
      role: claims.role,
      app_ids: claims.app_ids,
    },
  };
}

function parseAllowedUsers(raw: string | undefined): Record<string, { role: QaRole; app_ids?: AppId[] }> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const result: Record<string, { role: QaRole; app_ids?: AppId[] }> = {};
  for (const [email, config] of Object.entries(parsed as Record<string, AllowedUser>)) {
    if (!isQaRole(config.role)) continue;
    const appIds = Array.isArray(config.app_ids)
      ? config.app_ids.filter((id): id is AppId => typeof id === 'string' && VALID_APP_IDS.includes(id as AppId))
      : undefined;
    result[email.trim().toLowerCase()] = {
      role: config.role,
      app_ids: config.role === 'qa_admin' ? undefined : appIds,
    };
  }
  return result;
}

function isQaRole(role: unknown): role is QaRole {
  return role === 'qa_viewer' || role === 'qa_runner' || role === 'qa_admin';
}

async function verifyGoogleIdToken(
  token: string,
  expectedAudience: string,
  fetchFn: typeof fetch,
): Promise<VerifiedGoogleIdentity> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed Google ID token');

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  let header: GoogleIdTokenHeader;
  let payload: GoogleIdTokenPayload;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(headerB64))) as GoogleIdTokenHeader;
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadB64))) as GoogleIdTokenPayload;
  } catch {
    throw new Error('Invalid Google ID token');
  }

  if (header.alg !== 'RS256') throw new Error(`Unsupported algorithm: ${String(header.alg)}`);
  if (typeof header.kid !== 'string') throw new Error('Missing kid in Google ID token header');

  const jwksRes = await fetchFn(GOOGLE_JWKS_URL);
  if (!jwksRes.ok) throw new Error(`Failed to fetch Google JWKS: ${jwksRes.status}`);
  const jwksData: GoogleJwksResponse = await jwksRes.json();
  const key = jwksData.keys?.find((candidate) => candidate.kid === header.kid);
  if (!key || key.kty !== 'RSA' || !key.n || !key.e) {
    throw new Error(`No usable Google key found for kid: ${header.kid}`);
  }

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: key.n, e: key.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    base64UrlToBytes(signatureB64) as BufferSource,
    new TextEncoder().encode(`${headerB64}.${payloadB64}`) as BufferSource,
  );
  if (!valid) throw new Error('Invalid signature');

  if (payload.iss !== 'https://accounts.google.com') {
    throw new Error(`Invalid issuer: ${String(payload.iss)}`);
  }
  if (payload.aud !== expectedAudience) {
    throw new Error(`Audience mismatch: expected ${expectedAudience}, got ${String(payload.aud)}`);
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) throw new Error('Token expired');
  if (typeof payload.iat !== 'number' || payload.iat > now) throw new Error('Token not yet valid');
  if (payload.email_verified !== true) throw new Error('Email not verified by Google');
  if (typeof payload.email !== 'string' || payload.email.trim().length === 0) {
    throw new Error('No email claim in Google ID token');
  }

  return {
    email: payload.email,
    hostedDomain: typeof payload.hd === 'string' ? payload.hd : null,
  };
}

function getWorkspaceDomainError(identity: VerifiedGoogleIdentity, requiredDomain?: string): string | null {
  const normalizedRequiredDomain = requiredDomain?.trim().toLowerCase();
  if (!normalizedRequiredDomain) return null;

  const normalizedHostedDomain = identity.hostedDomain?.trim().toLowerCase() ?? '';
  if (normalizedHostedDomain !== normalizedRequiredDomain) {
    return `Google account '${identity.email}' is not a member of the required Workspace domain '${normalizedRequiredDomain}'`;
  }
  return null;
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
  if (!/^[a-f0-9]{64}$/.test(expected)) return false;

  let diff = actual.length ^ expected.length;
  const maxLength = Math.max(actual.length, expected.length);
  for (let i = 0; i < maxLength; i++) {
    diff |= (actual.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export { authRouter };
