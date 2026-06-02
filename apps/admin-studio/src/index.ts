/**
 * Factory Admin Studio — Worker entrypoint.
 *
 * @see docs/admin-studio/00-MASTER-PLAN.md
 *
 * Observability is provided by `@latimer-woods-tech/monitoring` (Sentry init
 * via `initMonitoring` + per-error reporting via `captureError`) and
 * `@latimer-woods-tech/logger` (`createLogger` produces the structured JSON
 * lines tagged with `request_id`). Sentry initialisation is lazy on the first
 * request that exposes `SENTRY_DSN`, so the worker still boots locally when
 * the secret is not configured. Stack-trace symbolication relies on the
 * sourcemaps step in `.github/workflows/deploy-admin-studio.yml`.
 */
import { Hono } from 'hono';
import {
  captureError,
  initMonitoring,
} from '@latimer-woods-tech/monitoring';
import { createLogger } from '@latimer-woods-tech/logger';
import type { AppEnv } from './types.js';
import type { Env } from './env.js';
import { corsMiddleware } from './middleware/cors.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { envContextMiddleware } from './middleware/env-context.js';
import { auditMiddleware } from './middleware/audit.js';

import auth from './routes/auth.js';
import { runAnalysisCycle } from './routes/ai.js';
import { runDigest } from './digest/index.js';
import { runDriftCheck } from './scheduled.js';
import me from './routes/me.js';
import tests from './routes/tests.js';
import deploy from './routes/deploy.js';
import ai from './routes/ai.js';
import audit from './routes/audit.js';
import timeline from './routes/timeline.js';
import apps from './routes/apps.js';
import observability from './routes/observability.js';
import repo from './routes/repo.js';
import capabilities from './routes/capabilities.js';
import manifest from './routes/manifest.js';
import catalog from './routes/catalog.js';
import smoke from './routes/smoke.js';
import slo from './routes/slo.js';
import synthetic from './routes/synthetic.js';
import ops from './routes/ops.js';
import creatorOnboarding from './routes/creator-onboarding.js';
import creators from './routes/creators.js';
import payouts from './routes/payouts.js';
import stripeConnectWebhooks from './routes/webhooks-stripe-connect.js';
import studioTestsWebhook from './routes/webhooks-studio-tests.js';
import studioSubscriptionsWebhook from './routes/webhooks-studio-subscriptions.js';
import dsr from './routes/dsr.js';
import privacy from './routes/privacy.js';
import { flagship } from './routes/flagship.js';
import blocking from './routes/blocking.js';
import commandCenter from './routes/command-center.js';
import training from './routes/training.js';

const app = new Hono<AppEnv>();

// ── Global middleware (order matters) ─────────────────────────────────────────────────────

// Strip trailing slashes BEFORE routing. Hono treats `/timeline` and
// `/timeline/` as distinct paths, so when UI bundles ship with a trailing
// slash they 404 on routes mounted at the bare form. Issuing a 308
// preserves the request method (so a stale `POST /foo/` survives) and is
// cacheable. Root path `/` is left alone.
//
// CORS headers are set inline on the redirect response. The cors
// middleware decorates `c.res` after `next()`, but this handler returns
// before `next()` is called, so the redirect would otherwise lack CORS
// and the browser would fail the cross-origin redirect with
// `net::ERR_FAILED`. Cross-origin redirects MUST carry CORS headers on
// every leg of the chain.
app.use('*', async (c, next) => {
  // OPTIONS must NOT be redirected — browsers refuse to follow redirects
  // during a CORS preflight, so a 308 on the preflight aborts the entire
  // fetch with net::ERR_FAILED. Let OPTIONS fall through to corsMiddleware,
  // which returns the 204 preflight response inline.
  if (c.req.method === 'OPTIONS') return next();

  const url = new URL(c.req.url);
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
    const origin = c.req.header('Origin');
    const allowed = c.env.ALLOWED_ORIGINS?.split(',').map((s) => s.trim()) ?? [];
    const headers = new Headers({ Location: url.toString() });
    if (origin && allowed.includes(origin)) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Credentials', 'true');
      headers.set('Vary', 'Origin');
    }
    return new Response(null, { status: 308, headers });
  }
  return next();
});

app.use('*', requestIdMiddleware());
// Initialise Sentry on the first request that has SENTRY_DSN available, then
// every subsequent request runs inside the configured Sentry scope. This is
// the @latimer-woods-tech/monitoring contract — initMonitoring is idempotent
// and ties the worker's request_id into Sentry tags via captureError below.
// We don't use the higher-level sentryMiddleware/withSentry wrappers here
// because they alter the default-export shape that the existing test suite
// (apps/admin-studio/src/routes/*.test.ts) imports directly via `worker.fetch`.
let _sentryInit = false;
app.use('*', async (c, next) => {
  if (c.env.SENTRY_DSN && !_sentryInit) {
    initMonitoring({
      dsn: c.env.SENTRY_DSN,
      environment: c.env.STUDIO_ENV === 'production' ? 'production' : 'staging',
      release: c.env.BUILD_SHA,
      tracesSampleRate: 0.1,
    });
    _sentryInit = true;
  }
  await next();
});
app.use('*', corsMiddleware());

// ── Public routes ────────────────────────────────────────────────────────────────────────────────────

/**
 * GET /health — unauthenticated. Returns env so operators can curl-verify
 * which worker they're hitting (matches the CLAUDE.md verification protocol).
 */
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    env: c.env.STUDIO_ENV,
    service: 'admin-studio',
    timestamp: new Date().toISOString(),
  });
});

app.route('/auth', auth);

// ── Public manifest (Phase E) ────────────────────────────────────────────────────────────────────────────────
// Crawlable function catalog — no auth so external monitors can scrape.
app.route('/manifest', manifest);

// ── Webhooks (public, Stripe-signed) ────────────────────────────────────────────────────────────────────────
app.route('/webhooks/stripe-connect', stripeConnectWebhooks);
app.route('/webhooks/studio-tests', studioTestsWebhook);
app.route('/webhooks/studio-subscriptions', studioSubscriptionsWebhook);

// ── Authenticated routes (env context required) ─────────────────────────────────────────────────────────
app.use('/me/*', envContextMiddleware());
app.use('/tests/*', envContextMiddleware(), auditMiddleware());
app.use('/deploys/*', envContextMiddleware(), auditMiddleware());
app.use('/ai/*', envContextMiddleware(), auditMiddleware());
app.use('/audit/*', envContextMiddleware());
app.use('/timeline/*', envContextMiddleware());
app.use('/apps/*', envContextMiddleware());
app.use('/observability/*', envContextMiddleware());
app.use('/capabilities/*', envContextMiddleware(), auditMiddleware());
// Audit middleware skips GET/HEAD/OPTIONS, so reads stay cheap and
// writes (commit, create-branch, open-PR) are recorded.
app.use('/repo/*', envContextMiddleware(), auditMiddleware());
// Catalog GETs are read-only; refresh POST is audited automatically.
app.use('/catalog/*', envContextMiddleware(), auditMiddleware());
// Smoke tests are auditable but not critical
app.use('/smoke/*', envContextMiddleware(), auditMiddleware());
// SLO panel � reads only, no audit.
app.use('/slo/*', envContextMiddleware());
// Synthetic journey monitor � GET is read, POST is audited.
app.use('/synthetic/*', envContextMiddleware(), auditMiddleware());
// Ops panel � all writes are audited via requireConfirmation + auditMiddleware.
app.use('/ops/*', envContextMiddleware(), auditMiddleware());
app.use('/api/creator/*', envContextMiddleware());
app.use('/api/admin/*', envContextMiddleware(), auditMiddleware());
app.use('/dsr/*', envContextMiddleware(), auditMiddleware());
app.use('/privacy/*', envContextMiddleware());
app.use('/api/flags/*', envContextMiddleware(), auditMiddleware());
app.use('/v1/blocking/*', envContextMiddleware());
app.use('/v1/command-center/*', envContextMiddleware());
// Training Library proxy → schedule-worker. GET is a read; /jobs dispatch is audited.
app.use('/training-library', envContextMiddleware());
app.use('/jobs/*', envContextMiddleware(), auditMiddleware());

app.route('/me', me);
app.route('/tests', tests);
app.route('/deploys', deploy);
app.route('/ai', ai);
app.route('/audit', audit);
app.route('/timeline', timeline);
app.route('/apps', apps);
app.route('/observability', observability);
app.route('/capabilities', capabilities);
app.route('/repo', repo);
app.route('/catalog', catalog);
app.route('/smoke', smoke);
app.route('/slo', slo);
app.route('/synthetic', synthetic);
app.route('/ops', ops);
app.route('/api/creator/onboarding', creatorOnboarding);
app.route('/api/admin/creators', creators);
app.route('/api/admin/payouts', payouts);
app.route('/dsr', dsr);
app.route('/privacy', privacy);
app.route('/api/flags', flagship);
app.route('/v1/blocking', blocking);
app.route('/v1/command-center', commandCenter);
// Mounted at root: defines GET /training-library and POST /jobs/from-brief.
app.route('/', training);

// ── Error handler ─────────────────────────────────────────────────────────────────────────────────────
app.onError((err, c) => {
  const requestId = c.var.requestId;
  // Structured JSON log via @latimer-woods-tech/logger (no raw console.*).
  const logger = createLogger({
    workerId: 'admin-studio',
    requestId: requestId ?? 'unknown',
    environment: c.env.STUDIO_ENV === 'production' ? 'production' : 'staging',
  });
  logger.error('admin-studio.error', err, { path: c.req.path, method: c.req.method });
  // Belt-and-braces Sentry capture — sentryMiddleware also catches via c.error
  // but explicit capture here keeps the trace tagged with request_id even if
  // SENTRY_DSN was added between middleware init and the error.
  if (c.env.SENTRY_DSN) {
    captureError(err, { requestId });
  }
  return c.json(
    {
      error: 'Internal server error',
      requestId,
      // Only echo error message in non-prod to avoid leaking internals.
      ...(c.env.STUDIO_ENV !== 'production' ? { detail: err.message } : {}),
    },
    500,
  );
});

app.notFound((c) =>
  c.json({ error: 'Not found', path: c.req.path, requestId: c.var.requestId }, 404),
);

/** Cron expressions that fire the digest (UTC): 06:30 ET and 18:30 ET */
const DIGEST_CRONS = new Set(['30 10 * * *', '30 22 * * *']);

/** Cron that fires the drift check (every 6 h). */
const DRIFT_CHECK_CRONS = new Set(['0 */6 * * *']);

export default {
  fetch: app.fetch,
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    // Always run the self-improvement analysis cycle
    ctx.waitUntil(runAnalysisCycle(env));

    // Run the digest only on the 10:30 UTC and 22:30 UTC crons
    if (DIGEST_CRONS.has(controller.cron)) {
      ctx.waitUntil(runDigest(env));
    }

    // Run the capability drift check every 6 h
    if (DRIFT_CHECK_CRONS.has(controller.cron)) {
      ctx.waitUntil(runDriftCheck(env));
    }
  },
} satisfies ExportedHandler<Env>;
