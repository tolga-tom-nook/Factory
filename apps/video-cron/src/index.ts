import { InternalError } from '@latimer-woods-tech/errors';
import type { RenderJob } from '@latimer-woods-tech/schedule';
import type { Env } from './env.js';

const MAX_CONCURRENT_JOBS = 3;
const PENDING_LIMIT = 10;
const FETCH_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readErrorBody(res: Response): Promise<string> {
  return res.text().catch(() => '');
}

async function fetchScheduleWorker(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  if (env.SCHEDULE_WORKER) {
    return env.SCHEDULE_WORKER.fetch(new Request(`https://schedule-worker.internal${path}`, init));
  }
  return fetchWithTimeout(`${env.SCHEDULE_WORKER_URL}${path}`, init);
}

// ---------------------------------------------------------------------------
// Schedule-worker API helpers
// ---------------------------------------------------------------------------

/**
 * Fetches pending render jobs from the schedule-worker.
 */
async function fetchPendingJobs(env: Env): Promise<RenderJob[]> {
  const search = new URLSearchParams({ limit: String(PENDING_LIMIT), appId: env.APP_ID });
  const path = `/jobs/pending?${search.toString()}`;
  const res = await fetchScheduleWorker(env, path, {
    headers: { Authorization: `Bearer ${env.WORKER_API_TOKEN}` },
  });

  if (!res.ok) {
    throw new InternalError(`Failed to fetch pending jobs: ${res.status}`, {
      path,
      status: res.status,
      body: await readErrorBody(res),
    });
  }

  const body = await res.json() as { data: RenderJob[] };
  return body.data;
}

/**
 * Marks a job as `rendering` in the schedule-worker before dispatching it.
 * This prevents double-dispatch if the cron fires again before the workflow completes.
 */
async function markRendering(env: Env, jobId: string): Promise<void> {
  const res = await fetchScheduleWorker(env, `/jobs/${jobId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${env.WORKER_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status: 'rendering' }),
  });

  if (!res.ok) {
    throw new InternalError(`Failed to mark job ${jobId} as rendering: ${res.status}`, {
      jobId,
      status: res.status,
      body: await readErrorBody(res),
    });
  }
}

/**
 * Marks a job as `failed` in the schedule-worker (used when dispatch itself errors).
 */
async function markFailed(env: Env, jobId: string, reason: string): Promise<void> {
  const res = await fetchScheduleWorker(env, `/jobs/${jobId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${env.WORKER_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status: 'failed', script: `dispatch error: ${reason}` }),
  });
  if (!res.ok) {
    throw new InternalError(`Failed to mark job ${jobId} as failed: ${res.status}`, {
      jobId,
      status: res.status,
      body: await readErrorBody(res),
    });
  }
}

// ---------------------------------------------------------------------------
// GitHub Actions workflow dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatches the `render-video.yml` workflow for a single job.
 */
async function dispatchRenderWorkflow(env: Env, job: RenderJob): Promise<void> {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/render-video.yml/dispatches`;
  const compositionId = job.compositionId || (
    job.type === 'marketing'
      ? env.DEFAULT_COMPOSITION_ID
      : job.type === 'training'
        ? 'TrainingVideo'
        : 'WalkthroughVideo'
  );

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'factory-video-cron/1.0',
    },
    body: JSON.stringify({
      ref: 'main',
      inputs: {
        job_id: job.id,
        composition_id: compositionId,
        app_id: job.appId,
        topic: job.topic,
        brief_key: job.briefKey || '',
        brand_color: '#6366f1',
        brand_accent: '#a5b4fc',
        logo_url: '',
        forge_theme: job.forgeTheme || 'self',
        hd_type: job.hdType || '',
        signature_gates: JSON.stringify(job.signatureGates || []),
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new InternalError(`GitHub dispatch failed (${res.status}): ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Cron handler
// ---------------------------------------------------------------------------

/**
 * Processes up to MAX_CONCURRENT_JOBS pending video jobs per cron tick.
 */
async function processPendingJobs(env: Env): Promise<{ dispatched: number; failed: number }> {
  const jobs = await fetchPendingJobs(env);
  const batch = jobs.slice(0, MAX_CONCURRENT_JOBS);

  let dispatched = 0;
  let failed = 0;

  for (const job of batch) {
    try {
      await markRendering(env, job.id);
      await dispatchRenderWorkflow(env, job);
      dispatched++;
    } catch (err) {
      failed++;
      const reason = err instanceof Error ? err.message : String(err);
      try {
        await markFailed(env, job.id, reason);
      } catch (markErr) {
        console.error(JSON.stringify({
          level: 'error',
          msg: 'Failed to mark render job failed',
          jobId: job.id,
          error: markErr instanceof Error ? markErr.message : String(markErr),
        }));
      }
      console.error(JSON.stringify({
        level: 'error',
        msg: 'Failed to dispatch render job',
        jobId: job.id,
        error: reason,
      }));
    }
  }

  return { dispatched, failed };
}

// ---------------------------------------------------------------------------
// Worker export
// ---------------------------------------------------------------------------

export default {
  /**
   * Scheduled handler — fires every hour per wrangler.jsonc cron config.
   * Fetches pending video jobs and dispatches render-video.yml for each.
   */
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log(JSON.stringify({
      level: 'info',
      msg: 'video-cron tick',
      ts: new Date().toISOString(),
      environment: env.ENVIRONMENT,
    }));

    try {
      const { dispatched, failed } = await processPendingJobs(env);
      console.log(JSON.stringify({
        level: 'info',
        msg: 'video-cron complete',
        dispatched,
        failed,
      }));
    } catch (err) {
      console.error(JSON.stringify({
        level: 'error',
        msg: 'video-cron fatal error',
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  },

  /**
   * HTTP handler — exposes /health for Verification Requirement curl checks.
   */
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        worker: 'video-cron',
        environment: env.ENVIRONMENT,
        ts: new Date().toISOString(),
      });
    }

    if (url.pathname === '/manifest') {
      return Response.json({
        manifestVersion: 1,
        app: 'video-cron',
        env: env.ENVIRONMENT ?? 'production',
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
            path: '/manifest',
            auth: 'public',
            summary: 'Machine-readable manifest for studio catalog crawlers',
            smoke: [{ expectedStatus: 200, expectContains: '"manifestVersion"' }],
            tags: ['ops'],
          },
          {
            method: 'POST',
            path: '/trigger',
            auth: 'admin',
            summary: 'Manually dispatch pending render jobs (requires WORKER_API_TOKEN)',
            reversibility: 'reversible',
            slo: { p95Ms: 30000, errorRate: 0.05 },
            tags: ['video', 'jobs', 'cron'],
          },
        ],
      });
    }

    if (url.pathname === '/trigger' && request.method === 'POST') {
      // Manual trigger endpoint — protected by WORKER_API_TOKEN
      const authHeader = request.headers.get('authorization');
      if (!authHeader?.startsWith('Bearer ') || authHeader.slice(7) !== env.WORKER_API_TOKEN) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }

      try {
        const { dispatched, failed } = await processPendingJobs(env);
        return Response.json({ data: { dispatched, failed } });
      } catch (err) {
        const context = err instanceof InternalError ? err.context : undefined;
        return Response.json(
          { error: { message: err instanceof Error ? err.message : 'Unknown error', context } },
          { status: 500 },
        );
      }
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  },
};
