import puppeteer from '@cloudflare/puppeteer';
import { Hono } from 'hono';
import type { Env } from './env.js';
import { GENERATED_TARGETS } from './targets.generated.js';
import { CUSTOM_TARGETS } from './targets.custom.js';

class ValidationError extends Error {
  public readonly status = 422;
  public readonly code = 'VALIDATION_ERROR';

  public constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Supported HTTP methods for synthetic checks. */
type CheckMethod = 'GET' | 'HEAD';

/** Synthetic endpoint definition. */
export interface MonitorTarget {
  id: string;
  url: string;
  method?: CheckMethod;
  expectedStatus?: number;
  contains?: string;
  timeoutMs?: number;
}

/** Result emitted by each synthetic check. */
export interface MonitorResult {
  id: string;
  url: string;
  method: CheckMethod;
  expectedStatus: number;
  status: number | null;
  ok: boolean;
  latencyMs: number;
  checkedAt: string;
  responseUrl?: string;
  error?: string;
}

/** Aggregate synthetic run envelope. */
export interface MonitorRunResult {
  status: 'ok' | 'degraded';
  environment: string;
  checkedAt: string;
  results: MonitorResult[];
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type ServiceBindingName = 'SCHEDULE_WORKER' | 'VIDEO_CRON' | 'ADMIN_STUDIO_STAGING' | 'PRIME_SELF';

const SERVICE_BINDINGS_BY_HOST: Readonly<Record<string, ServiceBindingName>> = {
  'schedule-worker.adrper79.workers.dev': 'SCHEDULE_WORKER',
  'video-cron.adrper79.workers.dev': 'VIDEO_CRON',
  'admin-studio-staging.adrper79.workers.dev': 'ADMIN_STUDIO_STAGING',
  'api.admin.latimerwoods.dev': 'ADMIN_STUDIO_STAGING',
  'prime-self.adrper79.workers.dev': 'PRIME_SELF',
};

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_EXPECTED_STATUS = 200;

/** Combined liveness + manifest + SLO journey targets. Generated probes first, then custom. */
const DEFAULT_TARGETS: readonly MonitorTarget[] = [
  ...GENERATED_TARGETS,
  ...CUSTOM_TARGETS,
];

const app = new Hono<{ Bindings: Env }>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseMethod(value: unknown): CheckMethod {
  if (value === undefined) {
    return 'GET';
  }
  if (value === 'GET' || value === 'HEAD') {
    return value;
  }
  throw new ValidationError('method must be GET or HEAD');
}

function parsePositiveInteger(value: unknown, fallback: number, field: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ValidationError(`${field} must be a positive integer`);
  }
  return value;
}

function validateTarget(value: unknown): MonitorTarget {
  if (!isRecord(value)) {
    throw new ValidationError('Each monitor target must be an object');
  }
  const { id, url, method, expectedStatus, contains, timeoutMs } = value;
  if (typeof id !== 'string' || !id.trim()) {
    throw new ValidationError('target id is required');
  }
  if (typeof url !== 'string' || !url.trim()) {
    throw new ValidationError('target url is required');
  }
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw new ValidationError('target url must use http or https');
  }
  if (contains !== undefined && typeof contains !== 'string') {
    throw new ValidationError('contains must be a string when provided');
  }
  return {
    id: id.trim(),
    url: parsedUrl.toString(),
    method: parseMethod(method),
    expectedStatus: parsePositiveInteger(expectedStatus, DEFAULT_EXPECTED_STATUS, 'expectedStatus'),
    contains,
    timeoutMs: parsePositiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs'),
  };
}

/**
 * Parses monitor targets from Worker configuration with deterministic fallback.
 *
 * @param raw - JSON array string from `env.TARGETS_JSON`.
 */
export function parseTargets(raw: string | undefined): MonitorTarget[] {
  if (!raw?.trim() || raw.trim() === '[]') {
    return [...DEFAULT_TARGETS];
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new ValidationError('TARGETS_JSON must be a JSON array');
  }
  const targets = parsed.map(validateTarget);
  if (targets.length === 0) {
    return [...DEFAULT_TARGETS];
  }
  return targets;
}

function elapsedMs(start: number): number {
  return Math.max(0, Math.round(performance.now() - start));
}

async function readBodyForAssertion(response: Response, method: CheckMethod): Promise<string> {
  if (method === 'HEAD') {
    return '';
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text') && !contentType.includes('json') && !contentType.includes('html')) {
    return '';
  }
  return response.text();
}

/**
 * Runs one endpoint check with explicit timeout and response validation.
 *
 * @param target - Endpoint definition to check.
 * @param fetchImpl - Fetch implementation, injectable for tests.
 */
export async function checkTarget(target: MonitorTarget, env: Env, fetchImpl: FetchLike = fetch): Promise<MonitorResult> {
  const method = target.method ?? 'GET';
  const expectedStatus = target.expectedStatus ?? DEFAULT_EXPECTED_STATUS;
  const timeoutMs = target.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const startedAt = performance.now();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(target.url, {
      method,
      signal: controller.signal,
      headers: { 'user-agent': 'factory-synthetic-monitor/0.1' },
    });
    const body = await readBodyForAssertion(response, method);
    const missingText = target.contains ? !body.includes(target.contains) : false;
    const statusMismatch = response.status !== expectedStatus;
    const ok = !statusMismatch && !missingText;
    const bodySnippet = body ? body.slice(0, 160).replace(/\s+/g, ' ').trim() : '';
    const mismatchDetail = statusMismatch
      ? `Unexpected status ${response.status} (expected ${expectedStatus})`
      : undefined;
    const containsDetail = missingText
      ? `Response did not contain expected text: ${target.contains}`
      : undefined;
    const detail = [mismatchDetail, containsDetail, !ok && bodySnippet ? `Body snippet: ${bodySnippet}` : undefined]
      .filter((value): value is string => Boolean(value))
      .join(' | ');
    
    if (!ok && env.BROWSER && env.AUDIT_LOGS && env.SLACK_WEBHOOK_OPS) {
      try {
        const browser = await puppeteer.launch(env.BROWSER);
        const page = await browser.newPage();
        await page.goto(target.url, { waitUntil: 'networkidle2', timeout: 15000 });
        const screenshot = await page.screenshot();
        await browser.close();
        
        const key = `smoke-failures/${target.id}-${new Date().toISOString()}.png`;
        await env.AUDIT_LOGS.put(key, screenshot, { httpMetadata: { contentType: 'image/png' } });
        
        // In a real implementation, we'd generate a pre-signed URL here.
        // For now, we just alert Slack that it's in R2.
        await fetch(env.SLACK_WEBHOOK_OPS, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `🚨 Synthetic monitor failed: ${target.id}\nURL: ${target.url}\nError: ${detail}\nScreenshot saved to R2: ${key}`
          })
        });
      } catch (e) {
        console.error('Failed to capture screenshot:', e);
      }
    }

    return {
      id: target.id,
      url: target.url,
      method,
      expectedStatus,
      status: response.status,
      ok,
      latencyMs: elapsedMs(startedAt),
      checkedAt: new Date().toISOString(),
      responseUrl: response.url,
      error: detail || undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown fetch failure';
    return {
      id: target.id,
      url: target.url,
      method,
      expectedStatus,
      status: null,
      ok: false,
      latencyMs: elapsedMs(startedAt),
      checkedAt: new Date().toISOString(),
      error: message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function resolveFetchForTarget(target: MonitorTarget, env: Env, fetchImpl: FetchLike): FetchLike {
  try {
    const parsedUrl = new URL(target.url);
    const bindingName = SERVICE_BINDINGS_BY_HOST[parsedUrl.hostname];
    if (!bindingName) {
      return fetchImpl;
    }
    const binding = env[bindingName];
    if (!binding) {
      return fetchImpl;
    }
    return (input, init) => {
      const baseUrl = typeof input === 'string' || input instanceof URL ? new URL(input.toString()) : new URL(input.url);
      const internalUrl = `https://internal${baseUrl.pathname}${baseUrl.search}`;
      return binding.fetch(internalUrl, init);
    };
  } catch {
    return fetchImpl;
  }
}

/**
 * Runs the full synthetic check suite.
 *
 * @param env - Worker bindings.
 * @param fetchImpl - Fetch implementation, injectable for tests.
 */
export async function runSyntheticChecks(env: Env, fetchImpl: FetchLike = fetch): Promise<MonitorRunResult> {
  const targets = parseTargets(env.TARGETS_JSON);
  const results = await Promise.all(
    targets.map((target) => checkTarget(target, env, resolveFetchForTarget(target, env, fetchImpl))),
  );
  const status = results.every((result) => result.ok) ? 'ok' : 'degraded';
  return {
    status,
    environment: env.ENVIRONMENT,
    checkedAt: new Date().toISOString(),
    results,
  };
}

app.get('/health', (c) => c.json({ status: 'ok', worker: 'synthetic-monitor', ts: new Date().toISOString() }));

app.get('/manifest', (c) => {
  const manifest = {
    manifestVersion: 1,
    app: 'synthetic-monitor',
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
        path: '/manifest',
        auth: 'public',
        summary: 'Machine-readable manifest for studio catalog crawlers',
        smoke: [{ expectedStatus: 200, expectContains: '"manifestVersion"' }],
        tags: ['ops'],
      },
      {
        method: 'GET',
        path: '/checks/run',
        auth: 'public',
        summary: 'Run synthetic checks against configured targets',
        reversibility: 'reversible',
        slo: { p95Ms: 2000, errorRate: 0.01 },
        tags: ['monitoring', 'synthetic'],
      },
    ],
  };
  return c.json(manifest);
});

app.get('/checks/run', async (c) => {
  const result = await runSyntheticChecks(c.env);
  return c.json(result, result.status === 'ok' ? 200 : 503);
});

app.onError((err, c) => {
  const isValidationError = err instanceof ValidationError;
  const status: 422 | 500 = isValidationError ? err.status : 500;
  const response = {
    data: null,
    error: {
      code: isValidationError ? err.code : 'INTERNAL_ERROR',
      message: err.message,
      status,
      retryable: !isValidationError,
    },
  };
  return c.json(response, status);
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const result = await runSyntheticChecks(env);
    const failed = result.results.filter((entry) => !entry.ok).map((entry) => ({
      id: entry.id,
      status: entry.status,
      error: entry.error,
      latencyMs: entry.latencyMs,
    }));
    console.log(JSON.stringify({
      event: 'synthetic_monitor.run',
      status: result.status,
      environment: result.environment,
      checkedAt: result.checkedAt,
      failed,
      total: result.results.length,
    }));
    if (env.MONITOR_KV) {
      const snapshot = {
        ts: result.checkedAt,
        status: result.status,
        failed: result.results.filter(r => !r.ok).map(r => ({
          id: r.id, url: r.url, latencyMs: r.latencyMs, error: r.error,
        })),
        latencies: Object.fromEntries(result.results.map(r => [r.id, r.latencyMs])),
        urls: Object.fromEntries(result.results.map(r => [r.id, r.url])),
      };
      const key = `snapshots:${result.checkedAt}`;
      await env.MONITOR_KV.put(key, JSON.stringify(snapshot), { expirationTtl: 604800 });
      await env.MONITOR_KV.put('latest', JSON.stringify(snapshot));
    }
  },
};
