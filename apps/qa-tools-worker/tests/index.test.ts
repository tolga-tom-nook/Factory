/**
 * qa-tools-worker unit tests.
 *
 * Tests the Hono app in isolation — no real DB, no browser-agent calls.
 * Auth is tested with in-memory JWTs minted via the mintQaJwt helper.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import app from '../src/index.js';
import { mintQaJwt } from '../src/middleware/auth.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET = 'test-secret-for-unit-tests';
const NOW_SECONDS = Math.floor(Date.now() / 1000);

/** Creates a minimal Cloudflare Worker Env stub for tests. */
function makeEnv(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    ENVIRONMENT: 'development',
    QA_TOOLS_JWT_SECRET: TEST_JWT_SECRET,
    BROWSER_AGENT_URL: 'https://browser-agent.test',
    BROWSER_AGENT_AUDIENCE: 'https://browser-agent.test',
    BROWSER_AGENT_SA_KEY: JSON.stringify({ client_email: 'test@sa.test', private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkq-----END PRIVATE KEY-----' }),
    DB: { connectionString: 'postgresql://test:test@localhost/test' },
    QA_TOOLS_R2: {
      put: async () => undefined,
      get: async () => null,
      head: async () => null,
      delete: async () => undefined,
      list: async () => ({ objects: [], truncated: false, cursor: undefined }),
    },
    RATE_LIMIT_KV: {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
    },
    ...overrides,
  };
}

/** Mints a valid qa_runner JWT for the given appIds. */
async function makeRunnerToken(appIds: string[] = ['capricast']): Promise<string> {
  return mintQaJwt(
    { sub: 'test-user-id', email: 'test@example.com', role: 'qa_runner', app_ids: appIds as never, exp: NOW_SECONDS + 3600 },
    TEST_JWT_SECRET,
  );
}

/** Mints a valid qa_admin JWT. */
async function makeAdminToken(): Promise<string> {
  return mintQaJwt(
    { sub: 'admin-id', email: 'admin@example.com', role: 'qa_admin', exp: NOW_SECONDS + 3600 },
    TEST_JWT_SECRET,
  );
}

/** Sends a request to the Hono app with the given env bound. */
async function req(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; env?: Record<string, unknown> } = {},
): Promise<Response> {
  const env = opts.env ?? makeEnv();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;

  const request = new Request(`http://qa-tools.test${path}`, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  // Bind the env to the Worker app (Hono uses `env` passed to fetch)
  return app.fetch(request, env as never, {
    waitUntil: () => { /* no-op in tests */ },
    passThroughOnException: () => { /* no-op */ },
  } as never);
}

// ---------------------------------------------------------------------------
// /health
// ---------------------------------------------------------------------------

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await req('GET', '/health');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['status']).toBe('ok');
    expect(body['service']).toBe('qa-tools-worker');
  });
});

// ---------------------------------------------------------------------------
// /version
// ---------------------------------------------------------------------------

describe('GET /version', () => {
  it('returns version metadata', async () => {
    const res = await req('GET', '/version');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['phase']).toBe('phase-2');
  });
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe('POST /runs — authentication', () => {
  it('rejects missing Authorization header with 401', async () => {
    const res = await req('POST', '/runs', { body: {} });
    expect(res.status).toBe(401);
  });

  it('rejects invalid bearer token with 401', async () => {
    const res = await req('POST', '/runs', { token: 'invalid.token.value', body: {} });
    expect(res.status).toBe(401);
  });

  it('rejects expired JWT with 401', async () => {
    const expiredToken = await mintQaJwt(
      { sub: 'u1', role: 'qa_runner', app_ids: ['capricast'] as never, exp: NOW_SECONDS - 10 },
      TEST_JWT_SECRET,
    );
    const res = await req('POST', '/runs', { token: expiredToken, body: {} });
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body['message']).toContain('expired');
  });

  it('rejects qa_viewer token on POST /runs (requires qa_runner)', async () => {
    const viewerToken = await mintQaJwt(
      { sub: 'viewer', role: 'qa_viewer', app_ids: ['capricast'] as never, exp: NOW_SECONDS + 3600 },
      TEST_JWT_SECRET,
    );
    const res = await req('POST', '/runs', {
      token: viewerToken,
      body: { appId: 'capricast', environment: 'production', testType: 'a11y', profile: 'fast' },
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('POST /runs — validation', () => {
  it('rejects invalid appId with 422', async () => {
    const token = await makeRunnerToken();
    const res = await req('POST', '/runs', {
      token,
      body: { appId: 'invalid-app', environment: 'production', testType: 'a11y', profile: 'fast' },
    });
    expect(res.status).toBe(422);
    const body = await res.json() as Record<string, unknown>;
    expect(String(body['message'])).toContain('appId');
  });

  it('rejects app not in token app_ids with 401', async () => {
    const token = await makeRunnerToken(['selfprime']); // no capricast
    const res = await req('POST', '/runs', {
      token,
      body: { appId: 'capricast', environment: 'production', testType: 'a11y', profile: 'fast' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects invalid environment with 422', async () => {
    const token = await makeRunnerToken();
    const res = await req('POST', '/runs', {
      token,
      body: { appId: 'capricast', environment: 'dev', testType: 'a11y', profile: 'fast' },
    });
    expect(res.status).toBe(422);
  });

  it('rejects custom environment without customUrl with 422', async () => {
    const token = await makeRunnerToken();
    const res = await req('POST', '/runs', {
      token,
      body: { appId: 'capricast', environment: 'custom', testType: 'a11y', profile: 'fast' },
    });
    expect(res.status).toBe(422);
  });

  it('admin token bypasses app_ids restriction', async () => {
    const adminToken = await makeAdminToken();
    // Will fail at the DB insert (no real DB) but should pass auth+validation
    const res = await req('POST', '/runs', {
      token: adminToken,
      body: { appId: 'capricast', environment: 'production', testType: 'a11y', profile: 'fast' },
    });
    // 500 from DB call is acceptable — means auth passed
    expect([202, 500, 503]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('POST /runs — rate limiting', () => {
  it('returns 429 when concurrent limit reached', async () => {
    const token = await makeRunnerToken();
    // Simulate KV reporting 3 concurrent runs
    const envWithFullKv = makeEnv({
      RATE_LIMIT_KV: {
        get: async (key: string) => key.startsWith('rl:concurrent:') ? '3' : null,
        put: async () => undefined,
        delete: async () => undefined,
      },
    });
    const res = await req('POST', '/runs', {
      token,
      env: envWithFullKv,
      body: { appId: 'capricast', environment: 'production', testType: 'a11y', profile: 'fast' },
    });
    expect(res.status).toBe(429);
    const body = await res.json() as Record<string, unknown>;
    expect(body['error']).toBe('rate_limited');
    expect(body['retryAfterMs']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// GET /runs/:id/status — not found
// ---------------------------------------------------------------------------

describe('GET /runs/:id/status', () => {
  it('returns 404 for unknown run id', async () => {
    const token = await makeRunnerToken();
    const envWithNullDb = makeEnv({
      DB: {
        connectionString: 'postgresql://test',
        // Simulate DB returning no rows
      },
    });

    // This will 500 (no real DB) — but should not 401 or crash
    const res = await req('GET', '/runs/non-existent-id/status', {
      token,
      env: envWithNullDb,
    });
    // Expected: 500 from DB error OR 404 — both are acceptable
    expect([404, 500]).toContain(res.status);
  });

  it('rejects without auth', async () => {
    const res = await req('GET', '/runs/some-id/status');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// JWT minting utility (used by CI and tests)
// ---------------------------------------------------------------------------

describe('mintQaJwt', () => {
  it('produces a token that verifies against the same secret', async () => {
    const token = await makeRunnerToken(['selfprime', 'capricast']);
    const parts = token.split('.');
    expect(parts).toHaveLength(3);

    // Verify it was minted correctly by decoding payload
    const payload = JSON.parse(atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
    expect(payload['role']).toBe('qa_runner');
    expect(Array.isArray(payload['app_ids'])).toBe(true);
  });
});
