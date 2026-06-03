import { Hono } from 'hono';
import type { Context } from 'hono';
import { createDb, sql } from '@latimer-woods-tech/neon';
import { toErrorResponse, ValidationError, AuthError, NotFoundError } from '@latimer-woods-tech/errors';
import trainingLibraryManifest from '../../video-studio/content-briefs/prime-self/training-library.json';
import {
  getPendingJobs,
  getVideoJob,
  scheduleVideo,
  updateJobStatus,
  VIDEO_CALENDAR_MIGRATION_STATEMENTS,
} from '@latimer-woods-tech/schedule';
import type { TriggerSource, RenderJobStatus } from '@latimer-woods-tech/schedule';
import { signRenderPayload } from '@latimer-woods-tech/video';
import { neon } from '@neondatabase/serverless';
import type { Env } from './env.js';

type RenderType = 'marketing' | 'training' | 'walkthrough';

interface ServiceAuth {
  /** `null` means the internal Factory token may operate across apps. */
  appId: string | null;
}

/** @internal Named export so existing tests can call `app.request(...)`. */
export const app = new Hono<{ Bindings: Env }>();

type ScheduleWorkerContext = Context<{ Bindings: Env }>;

// ---------------------------------------------------------------------------
// Auth helpers: supports one internal token plus optional app-scoped tokens
// ---------------------------------------------------------------------------

function parseScopedTokens(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => (
        typeof entry[0] === 'string' && typeof entry[1] === 'string' && entry[0].length > 0 && entry[1].length > 0
      )),
    );
  } catch {
    throw new AuthError('APP_SERVICE_TOKENS must be a JSON object when configured');
  }
}

function requireApiToken(env: Env, authHeader: string | undefined): ServiceAuth {
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AuthError('Bearer token required');
  }
  const bearer = authHeader.slice(7);
  if (bearer === env.WORKER_API_TOKEN) {
    return { appId: null };
  }

  const appId = parseScopedTokens(env.APP_SERVICE_TOKENS)[bearer];
  if (!appId) {
    throw new AuthError('Invalid API token');
  }
  return { appId };
}

function enforceAppScope(auth: ServiceAuth, requestedAppId: string): string {
  const appId = requestedAppId.trim();
  if (!appId) throw new ValidationError('appId is required');
  if (auth.appId && auth.appId !== appId) {
    throw new AuthError('API token is not scoped for this app');
  }
  return appId;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${field} is required`);
  return value.trim();
}

type TrainingLibraryComposition = 'MarketingVideo' | 'TrainingVideo' | 'WalkthroughVideo';

type TrainingLibraryModule = {
  briefKey: string;
  composition: TrainingLibraryComposition;
  audience: string;
  area: string;
  status: string;
  topic: string;
};

type TrainingLibraryManifest = {
  appId: string;
  library: string;
  version: number;
  updatedAt: string;
  description: string;
  modules: TrainingLibraryModule[];
};

function getTrainingLibrary(appId: string): TrainingLibraryManifest | null {
  if (appId === 'prime_self') {
    return trainingLibraryManifest as TrainingLibraryManifest;
  }
  return null;
}

function resolveRenderType(composition: TrainingLibraryComposition): RenderType {
  if (composition === 'MarketingVideo') return 'marketing';
  if (composition === 'TrainingVideo') return 'training';
  if (composition === 'WalkthroughVideo') return 'walkthrough';
  throw new ValidationError('Unsupported composition type');
}

function parseRenderType(value: unknown): RenderType {
  const type = requireString(value, 'type');
  if (type !== 'marketing' && type !== 'training' && type !== 'walkthrough') {
    throw new ValidationError('type must be one of: marketing, training, walkthrough');
  }
  return type;
}

function parseTriggerSource(value: unknown): TriggerSource {
  const triggerSource = requireString(value, 'triggerSource');
  if (triggerSource !== 'cron' && triggerSource !== 'git_tag' && triggerSource !== 'feedback_threshold' && triggerSource !== 'manual') {
    throw new ValidationError('triggerSource must be one of: cron, git_tag, feedback_threshold, manual');
  }
  return triggerSource;
}

async function handlePendingJobs(c: ScheduleWorkerContext): Promise<Response> {
  const auth = requireApiToken(c.env, c.req.header('authorization'));
  const limitParam = c.req.query('limit');
  const limit = limitParam ? Number(limitParam) : 10;
  const requestedAppId = c.req.query('appId') ?? auth.appId ?? undefined;

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ValidationError('limit must be an integer between 1 and 100');
  }
  const appId = requestedAppId ? enforceAppScope(auth, requestedAppId) : undefined;

  const db = createDb(c.env.DB);
  const jobs = await getPendingJobs(db, limit, appId);
  return c.json({ data: jobs });
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

app.get('/health', (c) => c.json({ status: 'ok', worker: 'schedule-worker', ts: new Date().toISOString() }));

// Stripe webhook ingress probe (W360-005 / J08).
app.get('/stripe/health', (c) => c.json({ status: 'ok', service: 'stripe-ingress', worker: 'schedule-worker', ts: new Date().toISOString() }));

// ---------------------------------------------------------------------------
// GET /manifest  — machine-readable function manifest for studio catalog crawlers
// ---------------------------------------------------------------------------

app.get('/manifest', (c) => {
  const manifest = {
    manifestVersion: 1,
    app: 'schedule-worker',
    env: c.env.ENVIRONMENT ?? 'production',
    generatedAt: new Date().toISOString(),
    entries: [
      {
        method: 'GET',
        path: '/health',
        auth: 'public',
        summary: 'Liveness probe with deployed env',
        smoke: [{ expectedStatus: 200, expectContains: '"status":"ok"' }],
        slo: { p95Ms: 200, errorRate: 0.001 },
        tags: ['ops'],
      },
      {
        method: 'GET',
        path: '/stripe/health',
        auth: 'public',
        summary: 'Stripe webhook ingress liveness probe',
        smoke: [{ expectedStatus: 200, expectContains: '"service":"stripe-ingress"' }],
        slo: { p95Ms: 200, errorRate: 0.001 },
        tags: ['ops', 'webhook'],
      },
      {
        method: 'GET',
        path: '/manifest',
        auth: 'public',
        summary: 'Machine-readable manifest for studio catalog crawlers',
        smoke: [{ expectedStatus: 200, expectContains: '"manifestVersion"' }],
        tags: ['ops'],
      },
      {
        method: 'GET',
        path: '/jobs/pending',
        auth: 'admin',
        summary: 'List pending render jobs ready for dispatch',
        reversibility: 'reversible',
        slo: { p95Ms: 500, errorRate: 0.01 },
        tags: ['video', 'jobs'],
      },
      {
        method: 'GET',
        path: '/training-library',
        auth: 'admin',
        summary: 'List the training library manifest for a given app',
        reversibility: 'reversible',
        slo: { p95Ms: 500, errorRate: 0.01 },
        tags: ['video', 'library'],
      },
      {
        method: 'POST',
        path: '/jobs/from-brief',
        auth: 'admin',
        summary: 'Schedule a render job from a manifest brief key',
        reversibility: 'reversible',
        slo: { p95Ms: 600, errorRate: 0.01 },
        tags: ['video', 'jobs', 'library'],
      },
      {
        method: 'GET',
        path: '/jobs/:id',
        auth: 'admin',
        summary: 'Fetch single render job by ID',
        reversibility: 'reversible',
        slo: { p95Ms: 400, errorRate: 0.01 },
        tags: ['video', 'jobs'],
      },
      {
        method: 'POST',
        path: '/jobs',
        auth: 'admin',
        summary: 'Schedule a new video render job',
        reversibility: 'reversible',
        slo: { p95Ms: 600, errorRate: 0.01 },
        tags: ['video', 'jobs'],
      },
      {
        method: 'PATCH',
        path: '/jobs/:id',
        auth: 'admin',
        summary: 'Update render job status (called by render-video.yml)',
        reversibility: 'reversible',
        slo: { p95Ms: 500, errorRate: 0.01 },
        tags: ['video', 'jobs'],
      },
      {
        method: 'POST',
        path: '/migrate',
        auth: 'admin',
        summary: 'Run DDL migrations — internal Factory token only',
        reversibility: 'irreversible',
        tags: ['ops', 'migrations'],
      },
    ],
  };
  return c.json(manifest);
});



app.get('/jobs/pending', async (c) => {
  return handlePendingJobs(c);
});

app.get('/training-library', (c) => {
  const auth = requireApiToken(c.env, c.req.header('authorization'));
  const requestedAppId = c.req.query('appId') ?? auth.appId ?? undefined;
  if (!requestedAppId) {
    throw new ValidationError('appId is required');
  }
  const appId = enforceAppScope(auth, String(requestedAppId));
  const library = getTrainingLibrary(appId);
  if (!library) {
    throw new NotFoundError(`Training library not found for appId ${appId}`);
  }
  return c.json({ data: library });
});

app.post('/jobs/from-brief', async (c) => {
  const auth = requireApiToken(c.env, c.req.header('authorization'));

  type Body = {
    appId?: unknown;
    briefKey?: unknown;
    triggerSource?: unknown;
    scheduledAt?: unknown;
    performanceScore?: unknown;
    idempotencyKey?: unknown;
  };

  const body = await c.req.json<Body>();
  const { appId, briefKey, triggerSource, scheduledAt, performanceScore, idempotencyKey } = body;

  const scopedAppId = enforceAppScope(auth, requireString(appId, 'appId'));
  const briefKeyValue = requireString(briefKey, 'briefKey');
  const library = getTrainingLibrary(scopedAppId);
  if (!library) {
    throw new NotFoundError(`Training library not found for appId ${scopedAppId}`);
  }

  const module = library.modules.find((item) => item.briefKey === briefKeyValue);
  if (!module) {
    throw new NotFoundError(`Training brief not found: ${briefKeyValue}`);
  }

  const renderType = resolveRenderType(module.composition);
  const source = triggerSource ? parseTriggerSource(triggerSource) : 'manual';
  const scheduledAtDate = scheduledAt ? new Date(String(scheduledAt)) : new Date();
  if (Number.isNaN(scheduledAtDate.getTime())) {
    throw new ValidationError('scheduledAt must be a valid ISO 8601 timestamp');
  }

  const db = createDb(c.env.DB);
  const job = await scheduleVideo(db, {
    appId: scopedAppId,
    type: renderType,
    briefKey: briefKeyValue,
    compositionId: module.composition,
    topic: module.topic,
    triggerSource: source,
    scheduledAt: scheduledAtDate,
    performanceScore: typeof performanceScore === 'number' ? performanceScore : 50,
    idempotencyKey: idempotencyKey === undefined ? undefined : requireString(idempotencyKey, 'idempotencyKey'),
  });

  return c.json({ data: job }, 201);
});

// ---------------------------------------------------------------------------
// GET /jobs/:id  — fetch a single job
// ---------------------------------------------------------------------------

app.get('/jobs/:id', async (c) => {
  const auth = requireApiToken(c.env, c.req.header('authorization'));
  const { id } = c.req.param();
  if (id === 'pending') return handlePendingJobs(c);

  const db = createDb(c.env.DB);
  const job = await getVideoJob(db, id, auth.appId ?? undefined);
  return c.json({ data: job });
});

// ---------------------------------------------------------------------------
// POST /jobs  — schedule a new video
// ---------------------------------------------------------------------------

app.post('/jobs', async (c) => {
  const auth = requireApiToken(c.env, c.req.header('authorization'));

  type Body = {
    appId?: unknown;
    type?: unknown;
    topic?: unknown;
    triggerSource?: unknown;
    scheduledAt?: unknown;
    performanceScore?: unknown;
    idempotencyKey?: unknown;
  };

  const body = await c.req.json<Body>();
  const { appId, type, topic, triggerSource, scheduledAt, performanceScore, idempotencyKey } = body;

  const scopedAppId = enforceAppScope(auth, requireString(appId, 'appId'));
  const renderType = parseRenderType(type);
  const videoTopic = requireString(topic, 'topic');
  const source = parseTriggerSource(triggerSource);
  const retryKey = idempotencyKey === undefined ? undefined : requireString(idempotencyKey, 'idempotencyKey');

  const db = createDb(c.env.DB);
  const job = await scheduleVideo(db, {
    appId: scopedAppId,
    type: renderType,
    topic: videoTopic,
    triggerSource: source,
    scheduledAt: scheduledAt ? new Date(scheduledAt as string) : new Date(),
    performanceScore: typeof performanceScore === 'number' ? performanceScore : 50,
    idempotencyKey: retryKey,
  });

  return c.json({ data: job }, 201);
});

// ---------------------------------------------------------------------------
// PATCH /jobs/:id  — update job status (called by render-video.yml + cron)
// ---------------------------------------------------------------------------

app.patch('/jobs/:id', async (c) => {
  const auth = requireApiToken(c.env, c.req.header('authorization'));

  type Body = {
    status?: unknown;
    streamUid?: unknown;
    videoUrl?: unknown;
    narrationUrl?: unknown;
    script?: unknown;
  };

  const { id } = c.req.param();
  const body = await c.req.json<Body>();
  const { status, streamUid, videoUrl, narrationUrl, script } = body;

  const validStatuses: RenderJobStatus[] = ['pending', 'rendering', 'uploading', 'done', 'failed'];
  if (typeof status !== 'string' || !validStatuses.includes(status as RenderJobStatus)) {
    throw new ValidationError(`status must be one of: ${validStatuses.join(', ')}`);
  }

  const db = createDb(c.env.DB);
  const job = await updateJobStatus(db, id, status as RenderJobStatus, {
    streamUid: typeof streamUid === 'string' ? streamUid : undefined,
    videoUrl: typeof videoUrl === 'string' ? videoUrl : undefined,
    narrationUrl: typeof narrationUrl === 'string' ? narrationUrl : undefined,
    script: typeof script === 'string' ? script : undefined,
  }, auth.appId ?? undefined);

  return c.json({ data: job });
});

// ---------------------------------------------------------------------------
// POST /migrate  — run DDL (operator only, call once after deploy)
// ---------------------------------------------------------------------------

app.post('/migrate', async (c) => {
  const auth = requireApiToken(c.env, c.req.header('authorization'));
  if (auth.appId) {
    throw new AuthError('Only the internal Factory token can run migrations');
  }
  const db = createDb(c.env.DB);
  for (const statement of VIDEO_CALENDAR_MIGRATION_STATEMENTS) {
    await db.execute(sql.raw(statement));
  }
  return c.json({ data: { migrated: true, statements: VIDEO_CALENDAR_MIGRATION_STATEMENTS.length } });
});


// ---------------------------------------------------------------------------
// GET /diagnostics  — 24 h SLO summary from monitor KV snapshots
// ---------------------------------------------------------------------------

app.get('/diagnostics', async (c) => {
  requireApiToken(c.env, c.req.header('authorization'));

  if (!c.env.MONITOR_KV) return c.json({ error: 'MONITOR_KV not bound' }, 503);

  interface KvSnapshot {
    latencies?: Record<string, number>;
    failed?: unknown[];
  }

  const { keys } = await c.env.MONITOR_KV.list({ prefix: 'snapshots:', limit: 48 });
  const snapshots = (await Promise.all(
    keys.map(k => c.env.MONITOR_KV!.get<KvSnapshot>(k.name, 'json')),
  )).filter((s): s is KvSnapshot => s !== null);

  const byEndpoint: Record<string, number[]> = {};
  let totalChecks = 0, totalFailed = 0;

  for (const snap of snapshots) {
    if (!snap.latencies) continue;
    totalChecks += Object.keys(snap.latencies).length;
    totalFailed += (snap.failed?.length ?? 0);
    for (const [id, ms] of Object.entries(snap.latencies)) {
      (byEndpoint[id] ??= []).push(ms);
    }
  }

  const slo = Object.entries(byEndpoint).map(([id, vals]) => {
    vals.sort((a, b) => a - b);
    return {
      id,
      p50: vals[Math.floor(vals.length * 0.5)] ?? 0,
      p95: vals[Math.floor(vals.length * 0.95)] ?? 0,
      breaches: vals.filter(v => v > 2000).length,
    };
  });

  return c.json({
    errorRate: totalChecks > 0 ? totalFailed / totalChecks : 0,
    slo,
    windowSnapshots: snapshots.length,
    windowHours: 24,
    computedAt: new Date().toISOString(),
  });
});
// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

app.onError((err, c) => {
  const response = toErrorResponse(err);
  const status = (response.error?.status ?? 500) as 200 | 201 | 400 | 401 | 403 | 404 | 422 | 429 | 500;
  return c.json(response, status);
});

// ---------------------------------------------------------------------------
// Subscription dispatch types (I1 Slice 4, D5)
// ---------------------------------------------------------------------------

/**
 * A row from selfprime's `video_subscription` table.
 * Only the columns this cron needs are fetched.
 */
interface VideoSubscriptionRow {
  id: string;
  user_id: string;
  cadence: string;
  composition_spec: Record<string, unknown>;
  channels: string[];
  next_run_at: string | null;
}

/**
 * Result counters returned by {@link dispatchDueSubscriptions}.
 */
export interface DispatchResult {
  dispatched: number;
  skipped: number;
  errors: number;
}

/**
 * Computes the next run timestamp for a subscription by advancing the
 * current time by the cadence interval.
 *
 * Supported cadence values (case-insensitive): `daily`, `weekly`, `monthly`.
 * Any unrecognised cadence falls back to adding 7 days (weekly).
 *
 * @internal
 */
export function computeNextRunAt(cadence: string, from: Date = new Date()): Date {
  const key = cadence.trim().toLowerCase();
  const next = new Date(from);
  if (key === 'daily') {
    next.setUTCDate(next.getUTCDate() + 1);
  } else if (key === 'monthly') {
    next.setUTCMonth(next.getUTCMonth() + 1);
  } else {
    // weekly (default, covers 'weekly' and unknown rrule strings)
    next.setUTCDate(next.getUTCDate() + 7);
  }
  return next;
}

const SELFPRIME_DISPATCH_URL =
  'https://api.selfprime.net/api/internal/video/subscription-dispatch';
const DISPATCH_BATCH_LIMIT = 50;

/**
 * Queries selfprime's Neon DB for due `video_subscription` rows and dispatches
 * each one to selfprime's internal render trigger endpoint (I1 Slice 4, D5).
 *
 * Signing uses the same HMAC-SHA256 scheme as the render contract (D10):
 * `X-Signature = hex(HMAC-SHA256(secret, "${timestamp}.${rawBody}"))`.
 *
 * On 2xx: updates `next_run_at` in the DB.
 * On non-2xx: logs the failure and increments `errors` — `next_run_at` is NOT
 * updated so the subscription retries on the next cron tick.
 */
export async function dispatchDueSubscriptions(
  env: Pick<Env, 'SELFPRIME_DB_URL' | 'PRIME_SELF_API_SECRET'>,
  deps: { fetch?: typeof fetch } = {},
): Promise<DispatchResult> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const result: DispatchResult = { dispatched: 0, skipped: 0, errors: 0 };

  // Connect to selfprime Neon via HTTP (no Node built-ins, no WebSocket).
  const sql = neon(env.SELFPRIME_DB_URL);

  // Fetch at most DISPATCH_BATCH_LIMIT due subscriptions.
  const rows = (await sql(
    `SELECT id, user_id, cadence, composition_spec, channels, next_run_at
     FROM video_subscription
     WHERE active = true AND next_run_at <= now()
     LIMIT ${DISPATCH_BATCH_LIMIT}`,
  )) as VideoSubscriptionRow[];

  if (rows.length === 0) {
    return result;
  }

  for (const sub of rows) {
    const payload = {
      subscriptionId: sub.id,
      userId: sub.user_id,
      spec: sub.composition_spec,
      channels: sub.channels,
    };
    const rawBody = JSON.stringify(payload);

    let signature: string;
    let timestamp: string;
    try {
      ({ signature, timestamp } = await signRenderPayload({
        rawBody,
        secret: env.PRIME_SELF_API_SECRET,
      }));
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'subscription-dispatch: signing failed',
          subscriptionId: sub.id,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      result.errors += 1;
      continue;
    }

    let res: Response;
    try {
      res = await fetchImpl(SELFPRIME_DISPATCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': signature,
          'X-Timestamp': timestamp,
        },
        body: rawBody,
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'subscription-dispatch: fetch failed',
          subscriptionId: sub.id,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      result.errors += 1;
      continue;
    }

    if (res.ok) {
      const nextRunAt = computeNextRunAt(sub.cadence);
      try {
        await sql(
          `UPDATE video_subscription SET next_run_at = $1 WHERE id = $2`,
          [nextRunAt.toISOString(), sub.id],
        );
        result.dispatched += 1;
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            msg: 'subscription-dispatch: next_run_at update failed',
            subscriptionId: sub.id,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        result.errors += 1;
      }
    } else {
      const body = await res.text().catch(() => '');
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'subscription-dispatch: dispatch returned non-2xx',
          subscriptionId: sub.id,
          status: res.status,
          body,
        }),
      );
      result.errors += 1;
    }
  }

  return result;
}

export default {
  fetch: app.fetch,

  /**
   * Cron handler — runs on the Worker's configured schedule.
   * Currently dispatches due user video subscriptions (I1 Slice 4, D5).
   */
  scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(
      dispatchDueSubscriptions(env).then((counts) => {
        console.log(
          JSON.stringify({
            level: 'info',
            msg: 'subscription-dispatch complete',
            environment: env.ENVIRONMENT,
            ...counts,
          }),
        );
      }).catch((err: unknown) => {
        console.error(
          JSON.stringify({
            level: 'error',
            msg: 'subscription-dispatch fatal',
            environment: env.ENVIRONMENT,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }),
    );
  },
};
