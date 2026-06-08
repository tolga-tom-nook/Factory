import { Hono } from 'hono';
import type { Env } from './env.js';

const app = new Hono<{ Bindings: Env }>();

const CACHE_KEY = 'workers-traffic-1h';
const CACHE_TTL_SECONDS = 60;
const ALLOWED_ORIGIN = 'https://latwoodtech.com';

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': ALLOWED_ORIGIN,
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

app.options('*', () => new Response(null, { status: 204, headers: CORS_HEADERS }));

app.get('/health', (c) =>
  c.json({ ok: true, worker: 'analytics-proxy', environment: c.env.ENVIRONMENT }),
);

app.get('/', async (c) => {
  const cached = await c.env.ANALYTICS_KV.get(CACHE_KEY);
  if (cached) {
    return new Response(cached, {
      status: 200,
      headers: { ...CORS_HEADERS, 'content-type': 'application/json', 'x-cache': 'HIT' },
    });
  }

  const payload = await fetchWorkerMetrics(c.env);
  const body = JSON.stringify(payload);
  await c.env.ANALYTICS_KV.put(CACHE_KEY, body, { expirationTtl: CACHE_TTL_SECONDS });

  return new Response(body, {
    status: 200,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json', 'x-cache': 'MISS' },
  });
});

app.onError((err, c) => {
  const message = err instanceof Error ? err.message : 'unknown error';
  console.error(JSON.stringify({ event: 'analytics_proxy.error', error: message }));
  return new Response(JSON.stringify({ error: message }), {
    status: 500,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
  });
});

interface WorkerMetric {
  scriptName: string;
  requests: number;
  errors: number;
  errorRate: number;
  cpuTimeP50Ms: number;
  cpuTimeP99Ms: number;
}

interface AnalyticsPayload {
  windowMinutes: number;
  generatedAt: string;
  workers: WorkerMetric[];
}

async function fetchWorkerMetrics(env: Env): Promise<AnalyticsPayload> {
  const now = new Date();
  const start = new Date(now.getTime() - 60 * 60 * 1000);

  const query = `{
    viewer {
      accounts(filter: { accountTag: "${env.CF_ACCOUNT_ID}" }) {
        workersInvocationsAdaptive(
          limit: 100
          filter: {
            datetime_geq: "${start.toISOString()}"
            datetime_leq: "${now.toISOString()}"
          }
          orderBy: [sum_requests_DESC]
        ) {
          dimensions {
            scriptName
          }
          sum {
            requests
            errors
            subrequests
          }
          quantiles {
            cpuTimeP50
            cpuTimeP99
          }
        }
      }
    }
  }`;

  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.CF_API_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) {
    throw new Error(`CF Analytics GraphQL returned ${res.status}`);
  }

  const json = (await res.json()) as {
    data?: {
      viewer?: {
        accounts?: Array<{
          workersInvocationsAdaptive?: Array<{
            dimensions: { scriptName: string };
            sum: { requests: number; errors: number; subrequests: number };
            quantiles: { cpuTimeP50: number; cpuTimeP99: number };
          }>;
        }>;
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join('; '));
  }

  const rows = json.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];

  // Aggregate across outcomes per script
  const byScript = new Map<string, { requests: number; errors: number; cpuP50: number; cpuP99: number }>();
  for (const row of rows) {
    const name = row.dimensions.scriptName;
    const existing = byScript.get(name) ?? { requests: 0, errors: 0, cpuP50: 0, cpuP99: 0 };
    byScript.set(name, {
      requests: existing.requests + (row.sum.requests ?? 0),
      errors: existing.errors + (row.sum.errors ?? 0),
      cpuP50: Math.max(existing.cpuP50, row.quantiles.cpuTimeP50 ?? 0),
      cpuP99: Math.max(existing.cpuP99, row.quantiles.cpuTimeP99 ?? 0),
    });
  }

  const workers: WorkerMetric[] = [];
  for (const [scriptName, data] of byScript) {
    workers.push({
      scriptName,
      requests: data.requests,
      errors: data.errors,
      errorRate: data.requests > 0 ? data.errors / data.requests : 0,
      cpuTimeP50Ms: Math.round(data.cpuP50 / 1000),
      cpuTimeP99Ms: Math.round(data.cpuP99 / 1000),
    });
  }

  workers.sort((a, b) => b.requests - a.requests);

  return { windowMinutes: 60, generatedAt: now.toISOString(), workers };
}

export default app;
