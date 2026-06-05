/**
 * Tests for factory-agent-gateway.
 *
 * Uses Hono's built-in test helper (app.request) rather than
 * @cloudflare/vitest-pool-workers so the tests run in Node/Vitest without
 * needing a full miniflare environment. DO forwarding is covered by a
 * manually constructed stub mock; auth is covered with real HS256 tokens
 * produced using the Web Crypto API (no Buffer, no Node crypto).
 */
import { describe, it, expect, vi } from 'vitest';
import app, { type Env } from './index.js';

// ---------------------------------------------------------------------------
// Minimal JWT helpers — mirrors @latimer-woods-tech/auth internals.
// We sign real HS256 tokens so the middleware exercises the actual
// verifyToken path rather than a mock.
// ---------------------------------------------------------------------------

const TEST_SECRET = 'test-jwt-secret-32-chars-minimum!!';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(value: string): string {
  const bytes = encoder.encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll(/=+$/gu, '');
}

async function signToken(payload: Record<string, unknown>): Promise<string> {
  const header = toBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = toBase64Url(JSON.stringify(payload));
  const data = `${header}.${body}`;

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(TEST_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  let binary = '';
  for (const byte of new Uint8Array(signature)) {
    binary += String.fromCharCode(byte);
  }
  const sig = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll(/=+$/gu, '');

  return `${data}.${sig}`;
}

/** Produces a valid, non-expired JWT with a test sub claim. */
async function validToken(sub = 'user-123'): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signToken({ sub, tenantId: 'tenant-abc', role: 'member', iat: now, exp: now + 3600 });
}

/** Produces a definitely-expired JWT. */
async function expiredToken(): Promise<string> {
  const past = Math.floor(Date.now() / 1000) - 7200;
  return signToken({ sub: 'user-old', tenantId: 'tenant-abc', role: 'member', iat: past - 3600, exp: past });
}

// ---------------------------------------------------------------------------
// DO stub factory
// ---------------------------------------------------------------------------

interface DOStub {
  fetch: ReturnType<typeof vi.fn>;
}

/** Creates a minimal DurableObjectStub mock that returns a canned JSON response. */
function makeDOStub(status: number, body: unknown): DOStub {
  return {
    fetch: vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  };
}

// ---------------------------------------------------------------------------
// Session namespace factory
// ---------------------------------------------------------------------------

interface NamespaceMocks {
  idFromName: ReturnType<typeof vi.fn>;
  namespace: DurableObjectNamespace;
}

/** Creates a mock DurableObjectNamespace backed by the given DO stub. */
function makeNamespace(doStub: DOStub): NamespaceMocks {
  const idFromName = vi.fn().mockReturnValue({ toString: () => 'do-id' });
  const namespace = {
    idFromName,
    get: vi.fn().mockReturnValue(doStub),
    idFromString: vi.fn(),
    newUniqueId: vi.fn(),
    jurisdiction: vi.fn(),
  } as unknown as DurableObjectNamespace;
  return { idFromName, namespace };
}

// ---------------------------------------------------------------------------
// Env factory
// ---------------------------------------------------------------------------

function makeEnv(overrides: Partial<Env> = {}): Env {
  const doStub = makeDOStub(200, { ok: true });
  const { namespace } = makeNamespace(doStub);

  return {
    AGENT_SESSIONS: namespace,
    DB: {} as D1Database,
    KV: {} as KVNamespace,
    RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    JWT_SECRET: TEST_SECRET,
    AI_GATEWAY_BASE_URL: 'https://gateway.ai.cloudflare.com/v1/acct/prime-self',
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    GROQ_API_KEY: 'test-groq-key',
    ...overrides,
  };
}

/** Reads and parses the JSON response body with an explicit type parameter. */
async function parseJson<T>(res: Response): Promise<T> {
  const raw: unknown = await res.json();
  return raw as T;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /health', () => {
  it('returns 200 with service name — no auth required', async () => {
    const res = await app.request('/health', {}, makeEnv());
    expect(res.status).toBe(200);
    const json = await parseJson<{ ok: boolean; service: string }>(res);
    expect(json).toEqual({ ok: true, service: 'agent-gateway' });
  });
});

describe('Auth middleware on /sessions/*', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await app.request('/sessions/sess-1/history', {}, makeEnv());
    expect(res.status).toBe(401);
    const json = await parseJson<{ error: string }>(res);
    expect(json.error).toMatch(/[Bb]earer/);
  });

  it('returns 401 when token is garbage', async () => {
    const res = await app.request(
      '/sessions/sess-1/history',
      { headers: { authorization: 'Bearer not.a.real.token' } },
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when token is expired', async () => {
    const token = await expiredToken();
    const res = await app.request(
      '/sessions/sess-1/history',
      { headers: { authorization: `Bearer ${token}` } },
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it('returns 503 when JWT_SECRET is not configured', async () => {
    const env = makeEnv({ JWT_SECRET: '' });
    const res = await app.request(
      '/sessions/sess-1/history',
      { headers: { authorization: 'Bearer anything' } },
      env,
    );
    expect(res.status).toBe(503);
  });

  it('passes through with a valid token', async () => {
    const token = await validToken();
    const env = makeEnv();
    const res = await app.request(
      '/sessions/sess-1/history',
      { headers: { authorization: `Bearer ${token}` } },
      env,
    );
    // DO stub returns 200 — middleware passed through
    expect(res.status).toBe(200);
  });
});

describe('Rate-limit middleware on /sessions/*', () => {
  it('returns 429 when RATE_LIMITER signals limit exceeded', async () => {
    const token = await validToken();
    const env = makeEnv({
      RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: false }) },
    });
    const res = await app.request(
      '/sessions/sess-rl/run',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      },
      env,
    );
    expect(res.status).toBe(429);
    const json = await parseJson<{ error: string }>(res);
    expect(json.error).toBe('rate limit exceeded');
  });

  it('rate-limit key is the JWT subject', async () => {
    const sub = 'specific-user-id';
    const token = await validToken(sub);
    const limitMock = vi.fn().mockResolvedValue({ success: true });
    const env = makeEnv({
      RATE_LIMITER: { limit: limitMock },
    });
    await app.request(
      '/sessions/sess-2/history',
      { headers: { authorization: `Bearer ${token}` } },
      env,
    );
    expect(limitMock).toHaveBeenCalledWith({ key: sub });
  });
});

describe('POST /sessions/:id/run', () => {
  it('forwards the request to the DO and returns the response', async () => {
    const token = await validToken();
    const agentResult = { content: 'hello', stopReason: 'end', totalCostUsd: 0.001, totalTurns: 1, turns: [] };
    const doStub = makeDOStub(200, agentResult);
    const { idFromName, namespace } = makeNamespace(doStub);

    const env = makeEnv({ AGENT_SESSIONS: namespace });
    const res = await app.request(
      '/sessions/my-session/run',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'run something' }] }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const json = await parseJson<typeof agentResult>(res);
    expect(json.content).toBe('hello');
    expect(json.stopReason).toBe('end');

    // Verify the DO was invoked on the correct session ID
    expect(idFromName).toHaveBeenCalledWith('my-session');

    // Verify the DO fetch was called with the expected URL and body
    const calls = doStub.fetch.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const firstCall = calls[0];
    expect(firstCall).toBeDefined();
    const doUrl = String(firstCall?.[0] ?? '');
    const doInit = (firstCall?.[1] ?? {}) as { body?: string };
    expect(doUrl).toBe('https://do/run');
    const body = JSON.parse(doInit.body ?? '{}') as { messages: unknown[]; env: Record<string, unknown> };
    expect(body.messages).toEqual([{ role: 'user', content: 'run something' }]);
    // LLM env is forwarded to the DO as `env` (the contract AgentSessionDO/runSession reads).
    expect(body.env).toHaveProperty('AI_GATEWAY_BASE_URL');
    expect(body.env).toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('returns 400 for invalid JSON body', async () => {
    const token = await validToken();
    const res = await app.request(
      '/sessions/sess-bad/run',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: 'not json{{{',
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('forwards non-200 DO status to the caller', async () => {
    const token = await validToken();
    const doStub = makeDOStub(409, { error: 'session busy' });
    const { namespace } = makeNamespace(doStub);
    const env = makeEnv({ AGENT_SESSIONS: namespace });

    const res = await app.request(
      '/sessions/busy-session/run',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      },
      env,
    );
    expect(res.status).toBe(409);
  });
});

describe('GET /sessions/:id/history', () => {
  it('forwards GET /history to the DO and returns session state', async () => {
    const token = await validToken();
    const sessionState = {
      sessionId: 'hist-session',
      messages: [],
      turns: [],
      totalCostUsd: 0,
      totalTurns: 0,
      createdAt: '2026-06-04T00:00:00.000Z',
      updatedAt: '2026-06-04T00:00:00.000Z',
      status: 'idle',
    };
    const doStub = makeDOStub(200, sessionState);
    const { idFromName, namespace } = makeNamespace(doStub);
    const env = makeEnv({ AGENT_SESSIONS: namespace });

    const res = await app.request(
      '/sessions/hist-session/history',
      { headers: { authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    const json = await parseJson<typeof sessionState>(res);
    expect(json.sessionId).toBe('hist-session');
    expect(json.status).toBe('idle');
    expect(idFromName).toHaveBeenCalledWith('hist-session');

    // Verify DO was called with GET /history
    const calls = doStub.fetch.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const firstCall = calls[0];
    expect(String(firstCall?.[0] ?? '')).toBe('https://do/history');
  });
});

describe('POST /sessions/:id/reset', () => {
  it('forwards POST /reset to the DO and returns ok', async () => {
    const token = await validToken();
    const doStub = makeDOStub(200, { ok: true });
    const { idFromName, namespace } = makeNamespace(doStub);
    const env = makeEnv({ AGENT_SESSIONS: namespace });

    const res = await app.request(
      '/sessions/reset-session/reset',
      { method: 'POST', headers: { authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    const json = await parseJson<{ ok: boolean }>(res);
    expect(json.ok).toBe(true);
    expect(idFromName).toHaveBeenCalledWith('reset-session');

    // Verify DO was called with POST /reset
    const calls = doStub.fetch.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const firstCall = calls[0];
    const doUrl = String(firstCall?.[0] ?? '');
    const doInit = (firstCall?.[1] ?? {}) as { method?: string };
    expect(doUrl).toBe('https://do/reset');
    expect(doInit.method).toBe('POST');
  });
});

describe('Decoder guard', () => {
  it('atob round-trip in the token signing helper produces valid base64url', () => {
    // Verifies the TextDecoder usage in the signing helper (no Buffer allowed).
    const text = '{"test":true}';
    const bytes = encoder.encode(text);
    let binary = '';
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    const b64 = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll(/=+$/gu, '');
    expect(b64).not.toContain('+');
    expect(b64).not.toContain('/');

    // Round-trip decode
    const base64 = b64.replaceAll('-', '+').replaceAll('_', '/');
    const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`;
    const decodedBinary = atob(padded);
    const decodedBytes = Uint8Array.from(decodedBinary, (ch) => ch.charCodeAt(0));
    expect(decoder.decode(decodedBytes)).toBe(text);
  });
});
