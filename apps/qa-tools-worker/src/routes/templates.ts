/**
 * Template management route handlers (Phase 2).
 *
 * POST   /templates          — Create a custom template (qa_admin only)
 * GET    /templates          — List templates visible to caller (qa_viewer+)
 *                             ?appId= filters to system + app-specific templates
 * GET    /templates/:id      — Fetch a single template (qa_viewer+)
 * DELETE /templates/:id      — Delete a custom template (qa_admin; system templates are protected)
 *
 * System templates are seeded via 002_phase2.sql and cannot be deleted or
 * modified via the API (is_system = TRUE guard in deleteTemplate).
 *
 * See: docs/architecture/QA_TOOLS_ARCHITECTURE.md §3.5
 */

import { Hono } from 'hono';
import { ValidationError, NotFoundError } from '@latimer-woods-tech/errors';
import type { Env } from '../env.js';
import {
  insertTemplate,
  listTemplates,
  getTemplateById,
  deleteTemplate,
} from '../lib/phase2-db.js';
import { requireAuth, assertRole } from '../middleware/auth.js';

const templatesRouter = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// POST /templates
// ---------------------------------------------------------------------------

templatesRouter.post('/', async (c) => {
  const claims = await requireAuth(c.req.header('Authorization'), c.env.QA_TOOLS_JWT_SECRET);
  assertRole(claims, 'qa_admin');

  const body = await c.req.json<{
    name?: unknown;
    description?: unknown;
    appId?: unknown;
    testType?: unknown;
    profile?: unknown;
    testConfig?: unknown;
    isCiDefault?: unknown;
    ciFail?: unknown;
    thresholds?: unknown;
  }>().catch(() => { throw new ValidationError('JSON body required'); });

  if (typeof body.name !== 'string' || body.name.trim().length === 0) {
    throw new ValidationError('name is required');
  }
  if (typeof body.testType !== 'string' || body.testType.trim().length === 0) {
    throw new ValidationError('testType is required');
  }

  const VALID_TEST_TYPES = ['a11y', 'performance', 'scenario', 'full-audit', 'screenshot'];
  if (!VALID_TEST_TYPES.includes(body.testType)) {
    throw new ValidationError(`testType must be one of: ${VALID_TEST_TYPES.join(', ')}`);
  }

  const VALID_PROFILES = ['fast', 'a11y', 'performance', 'full', 'scenario', 'custom'];
  const profile = typeof body.profile === 'string' ? body.profile : 'full';
  if (!VALID_PROFILES.includes(profile)) {
    throw new ValidationError(`profile must be one of: ${VALID_PROFILES.join(', ')}`);
  }

  if (body.testConfig !== undefined && (
    typeof body.testConfig !== 'object' ||
    body.testConfig === null ||
    Array.isArray(body.testConfig)
  )) {
    throw new ValidationError('testConfig must be an object');
  }

  if (body.thresholds !== undefined && (
    typeof body.thresholds !== 'object' ||
    body.thresholds === null ||
    Array.isArray(body.thresholds)
  )) {
    throw new ValidationError('thresholds must be an object');
  }

  const row = await insertTemplate(c.env.DB.connectionString, {
    name: body.name.trim(),
    description: typeof body.description === 'string' ? body.description : null,
    appId: typeof body.appId === 'string' && body.appId.length > 0 ? body.appId : null,
    testType: body.testType,
    profile,
    testConfig: body.testConfig as Record<string, unknown> | undefined,
    isCiDefault: Boolean(body.isCiDefault),
    ciFail: body.ciFail === undefined ? true : Boolean(body.ciFail),
    thresholds: body.thresholds as Record<string, unknown> | undefined,
    createdBy: claims.sub,
  });

  return c.json(serializeTemplate(row), 201);
});

// ---------------------------------------------------------------------------
// GET /templates?appId=
// ---------------------------------------------------------------------------

templatesRouter.get('/', async (c) => {
  const claims = await requireAuth(c.req.header('Authorization'), c.env.QA_TOOLS_JWT_SECRET);
  assertRole(claims, 'qa_viewer');

  const appId = c.req.query('appId') ?? null;

  const rows = await listTemplates(c.env.DB.connectionString, appId);

  return c.json({ templates: rows.map(serializeTemplate) });
});

// ---------------------------------------------------------------------------
// GET /templates/:id
// ---------------------------------------------------------------------------

templatesRouter.get('/:id', async (c) => {
  const claims = await requireAuth(c.req.header('Authorization'), c.env.QA_TOOLS_JWT_SECRET);
  assertRole(claims, 'qa_viewer');

  const row = await getTemplateById(c.env.DB.connectionString, c.req.param('id'));
  if (!row) throw new NotFoundError(`Template ${c.req.param('id')} not found`);

  return c.json(serializeTemplate(row));
});

// ---------------------------------------------------------------------------
// DELETE /templates/:id
// ---------------------------------------------------------------------------

templatesRouter.delete('/:id', async (c) => {
  const claims = await requireAuth(c.req.header('Authorization'), c.env.QA_TOOLS_JWT_SECRET);
  assertRole(claims, 'qa_admin');

  // deleteTemplate throws NotFoundError for system templates, returns false if not found
  const deleted = await deleteTemplate(c.env.DB.connectionString, c.req.param('id'));
  if (!deleted) throw new NotFoundError(`Template ${c.req.param('id')} not found`);

  return c.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import type { TemplateRow } from '../lib/phase2-db.js';

/** Serializes a TemplateRow for API responses. */
function serializeTemplate(row: TemplateRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    appId: row.app_id,
    testType: row.test_type,
    profile: row.profile,
    testConfig: row.test_config,
    isCiDefault: row.is_ci_default,
    ciFail: row.ci_fail_on_regression,
    thresholds: row.thresholds,
    isSystem: row.is_system,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export { templatesRouter };
