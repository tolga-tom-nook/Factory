/**
 * Credential management route handlers (Phase 2).
 *
 * POST   /credentials          — Store encrypted test-user credentials (qa_admin only)
 * GET    /credentials          — List credentials for an app (qa_admin)
 * GET    /credentials/:id      — Fetch credential metadata — no payload decryption (qa_admin)
 * DELETE /credentials/:id      — Delete a credential (qa_admin)
 * POST   /credentials/:id/test — Test-decrypt: verifies key + returns username_hint (qa_admin)
 *
 * Credentials are encrypted at rest with AES-256-GCM using QA_TOOLS_ENCRYPT_KEY.
 * See: docs/architecture/QA_TOOLS_ARCHITECTURE.md §3.3, §6.1
 */

import { Hono } from 'hono';
import { ValidationError, NotFoundError } from '@latimer-woods-tech/errors';
import type { Env } from '../env.js';
import {
  insertCredential,
  listCredentials,
  getCredentialById,
  deleteCredential,
} from '../lib/phase2-db.js';
import { encryptCredential, decryptCredential, validateCredentialPayload } from '../lib/crypto.js';
import { requireAuth, assertRole } from '../middleware/auth.js';

const credentialsRouter = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// POST /credentials
// ---------------------------------------------------------------------------

credentialsRouter.post('/', async (c) => {
  const claims = await requireAuth(c.req.header('Authorization'), c.env.QA_TOOLS_JWT_SECRET);
  assertRole(claims, 'qa_admin');

  if (!c.env.QA_TOOLS_ENCRYPT_KEY) {
    throw new ValidationError('QA_TOOLS_ENCRYPT_KEY is not configured — cannot store credentials');
  }

  const body = await c.req.json<{
    appId?: unknown;
    environment?: unknown;
    label?: unknown;
    username?: unknown;
    password?: unknown;
    mfaSecret?: unknown;
    additionalHeaders?: unknown;
  }>().catch(() => { throw new ValidationError('JSON body required'); });

  if (typeof body.appId !== 'string' || body.appId.length === 0) {
    throw new ValidationError('appId is required');
  }
  if (!['staging', 'production', 'custom'].includes(String(body.environment))) {
    throw new ValidationError('environment must be staging, production, or custom');
  }
  if (typeof body.label !== 'string' || body.label.length === 0) {
    throw new ValidationError('label is required');
  }

  // Validate and encrypt the credential payload
  const payload = validateCredentialPayload({
    username: body.username,
    password: body.password,
    mfaSecret: body.mfaSecret,
    additionalHeaders: body.additionalHeaders,
  });

  const encryptedPayload = await encryptCredential(payload, c.env.QA_TOOLS_ENCRYPT_KEY);

  // username_hint: first 3 chars + *** + domain (to allow UI to show partial username)
  const hint = buildUsernameHint(payload.username);

  const row = await insertCredential(c.env.DB.connectionString, {
    appId: body.appId,
    environment: String(body.environment),
    label: body.label,
    encryptedPayload,
    usernameHint: hint,
    createdBy: claims.sub,
  });

  return c.json({
    id: row.id,
    appId: row.app_id,
    environment: row.environment,
    label: row.label,
    usernameHint: row.username_hint,
    createdAt: row.created_at,
  }, 201);
});

// ---------------------------------------------------------------------------
// GET /credentials?appId=&environment=
// ---------------------------------------------------------------------------

credentialsRouter.get('/', async (c) => {
  const claims = await requireAuth(c.req.header('Authorization'), c.env.QA_TOOLS_JWT_SECRET);
  assertRole(claims, 'qa_admin');

  const appId = c.req.query('appId');
  if (!appId) throw new ValidationError('appId query param is required');

  const environment = c.req.query('environment') ?? undefined;

  const rows = await listCredentials(c.env.DB.connectionString, appId, environment);

  return c.json({
    credentials: rows.map((r) => ({
      id: r.id,
      appId: r.app_id,
      environment: r.environment,
      label: r.label,
      usernameHint: r.username_hint,
      lastUsedAt: r.last_used_at,
      createdAt: r.created_at,
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /credentials/:id
// ---------------------------------------------------------------------------

credentialsRouter.get('/:id', async (c) => {
  const claims = await requireAuth(c.req.header('Authorization'), c.env.QA_TOOLS_JWT_SECRET);
  assertRole(claims, 'qa_admin');

  const row = await getCredentialById(c.env.DB.connectionString, c.req.param('id'));
  if (!row) throw new NotFoundError(`Credential ${c.req.param('id')} not found`);

  // Return metadata only — never expose encrypted_payload over HTTP
  return c.json({
    id: row.id,
    appId: row.app_id,
    environment: row.environment,
    label: row.label,
    usernameHint: row.username_hint,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
});

// ---------------------------------------------------------------------------
// DELETE /credentials/:id
// ---------------------------------------------------------------------------

credentialsRouter.delete('/:id', async (c) => {
  const claims = await requireAuth(c.req.header('Authorization'), c.env.QA_TOOLS_JWT_SECRET);
  assertRole(claims, 'qa_admin');

  const deleted = await deleteCredential(c.env.DB.connectionString, c.req.param('id'));
  if (!deleted) throw new NotFoundError(`Credential ${c.req.param('id')} not found`);

  return c.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// POST /credentials/:id/test — verify decrypt works
// ---------------------------------------------------------------------------

credentialsRouter.post('/:id/test', async (c) => {
  const claims = await requireAuth(c.req.header('Authorization'), c.env.QA_TOOLS_JWT_SECRET);
  assertRole(claims, 'qa_admin');

  if (!c.env.QA_TOOLS_ENCRYPT_KEY) {
    throw new ValidationError('QA_TOOLS_ENCRYPT_KEY is not configured');
  }

  const row = await getCredentialById(c.env.DB.connectionString, c.req.param('id'));
  if (!row) throw new NotFoundError(`Credential ${c.req.param('id')} not found`);

  // Decrypt to verify — return username only (never password)
  const payload = await decryptCredential(row.encrypted_payload, c.env.QA_TOOLS_ENCRYPT_KEY);

  return c.json({
    ok: true,
    username: payload.username,
    hasMfa: Boolean(payload.mfaSecret),
    hasHeaders: Boolean(payload.additionalHeaders && Object.keys(payload.additionalHeaders).length > 0),
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a partial username for display (e.g. "qa+***@example.com"). */
function buildUsernameHint(username: string): string {
  const atIdx = username.indexOf('@');
  if (atIdx > 3) {
    const local = username.slice(0, 3) + '***';
    const domain = username.slice(atIdx);
    return `${local}${domain}`;
  }
  if (username.length > 3) {
    return username.slice(0, 3) + '***';
  }
  return '***';
}

export { credentialsRouter };
