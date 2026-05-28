/**
 * qa-tools-worker — QA Testing Platform API
 *
 * Hono worker providing browser audit orchestration, accessibility testing,
 * screenshot capture, and result storage for selfprime.net, capricast.com,
 * cipherofhealing.com, and xicocity.com.
 *
 * Architecture: docs/architecture/QA_TOOLS_ARCHITECTURE.md
 * Surface:      docs/architecture/SURFACES.md §13
 *
 * Routes:
 *   GET  /health              Worker health check
 *   GET  /version             Build metadata
 *   POST /runs                Start an audit (§4.1)
 *   GET  /runs                List runs (§4.7)
 *   GET  /runs/:id/status     Poll status (§4.2)
 *   GET  /runs/:id/results    Full findings (§4.3)
 *   POST /runs/:id/create-issue  Export to GitHub (§4.4)
 *   POST /runs/:id/rerun      Manual rerun (§4.5)
 *   PATCH /runs/:id/results/:resultId  Acknowledge finding (§4.8)
 *   GET  /apps/:appId/health  App health summary (§4.6)
 */

import { Hono } from 'hono';
import { AuthError, ValidationError, NotFoundError, InternalError } from '@latimer-woods-tech/errors';
import type { Env } from './env.js';
import { runsRouter } from './routes/runs.js';
import { appsRouter } from './routes/apps.js';
import { authRouter } from './routes/auth.js';

const app = new Hono<{ Bindings: Env }>();

const DEFAULT_ALLOWED_ORIGINS = [
  'https://qa.latimerwoods.dev',
  'https://staging.qa.latimerwoods.dev',
  'http://localhost:3000',
];

app.use('*', async (c, next) => {
  const origin = c.req.header('Origin');
  const allowedOrigins = (c.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','))
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (origin && allowedOrigins.includes(origin)) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Vary', 'Origin');
    c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    c.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  }

  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204);
  }

  await next();
});

// ---------------------------------------------------------------------------
// Health + version endpoints (no auth)
// ---------------------------------------------------------------------------

app.get('/health', (c) =>
  c.json({
    status: 'ok',
    service: 'qa-tools-worker',
    environment: c.env.ENVIRONMENT,
    timestamp: new Date().toISOString(),
  }),
);

app.get('/version', (c) =>
  c.json({
    service: 'qa-tools-worker',
    version: '1.0.0',
    phase: 'phase-1',
    environment: c.env.ENVIRONMENT,
  }),
);

// ---------------------------------------------------------------------------
// Route mounting
// ---------------------------------------------------------------------------

app.route('/auth', authRouter);
app.route('/runs', runsRouter);
app.route('/apps', appsRouter);

// ---------------------------------------------------------------------------
// 404 handler
// ---------------------------------------------------------------------------

app.notFound((c) => c.json({ error: 'Not found' }, 404));

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

app.onError((err, c) => {
  if (err instanceof AuthError) {
    return c.json({ error: 'unauthorized', message: err.message }, 401);
  }
  if (err instanceof ValidationError) {
    return c.json({ error: 'validation_error', message: err.message }, 422);
  }
  if (err instanceof NotFoundError) {
    return c.json({ error: 'not_found', message: err.message }, 404);
  }
  if (err instanceof InternalError) {
    console.error('[qa-tools] InternalError:', err.message);
    return c.json({ error: 'internal_error', message: err.message }, 500);
  }

  // Unknown errors — log full stack for Cloudflare logpush
  console.error('[qa-tools] Unhandled error:', err instanceof Error ? (err.stack ?? err.message) : String(err));
  return c.json({ error: 'internal_server_error' }, 500);
});

export default app;
