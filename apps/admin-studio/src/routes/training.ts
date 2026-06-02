/**
 * Training Library proxy.
 *
 * The training catalog and the video job queue are owned by **schedule-worker**,
 * not admin-studio. The browser must not call schedule-worker directly — those
 * routes require the shared `WORKER_API_TOKEN` service token, which must never
 * reach the client. Instead the admin UI calls admin-studio (authenticated with
 * the operator JWT via `envContextMiddleware`), and admin-studio forwards the
 * request to schedule-worker over the `SCHEDULE_WORKER` service binding with the
 * service token attached server-side.
 *
 *   GET  /training-library?appId=…   → schedule-worker GET /training-library
 *   POST /jobs/from-brief            → schedule-worker POST /jobs/from-brief
 *
 * schedule-worker responses (`{ data: … }`) are passed through verbatim.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../types.js';

const training = new Hono<AppEnv>();

/** Hostname is irrelevant over a service binding, but the URL must be well-formed. */
const SCHEDULE_ORIGIN = 'https://schedule-worker.internal';

/**
 * Forward a request to schedule-worker over the service binding, attaching the
 * shared service token. Returns 503 if the binding/token isn't configured and
 * 502 if schedule-worker is unreachable; otherwise relays the upstream status
 * and JSON body unchanged.
 */
async function proxy(c: Context<AppEnv>, path: string, init: RequestInit): Promise<Response> {
  if (!c.env.SCHEDULE_WORKER || !c.env.WORKER_API_TOKEN) {
    return c.json(
      { error: 'schedule-worker not configured (missing SCHEDULE_WORKER binding or WORKER_API_TOKEN)' },
      503,
    );
  }
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${c.env.WORKER_API_TOKEN}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  let upstream: Response;
  try {
    upstream = await c.env.SCHEDULE_WORKER.fetch(
      new Request(`${SCHEDULE_ORIGIN}${path}`, { ...init, headers }),
    );
  } catch (err) {
    return c.json(
      { error: `schedule-worker unreachable: ${err instanceof Error ? err.message : 'fetch failed'}` },
      502,
    );
  }

  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json' },
  });
}

/** GET /training-library?appId=… — proxied list of a product's video briefs. */
training.get('/training-library', async (c) => {
  const appId = c.req.query('appId');
  const qs = appId ? `?appId=${encodeURIComponent(appId)}` : '';
  return proxy(c, `/training-library${qs}`, { method: 'GET' });
});

/** POST /jobs/from-brief — dispatch a render for a ready brief to the queue. */
training.post('/jobs/from-brief', async (c) => {
  const body = await c.req.text();
  return proxy(c, '/jobs/from-brief', { method: 'POST', body });
});

export default training;
