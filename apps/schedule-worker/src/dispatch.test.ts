/**
 * Tests for dispatchDueSubscriptions (I1 Slice 4, D5).
 *
 * All tests mock @neondatabase/serverless and globalThis.fetch so no real DB
 * or network calls are made.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dispatchDueSubscriptions, computeNextRunAt } from './index.js';

// ---------------------------------------------------------------------------
// Hoist mocks before module resolution so vi.mock hoisting works correctly.
// ---------------------------------------------------------------------------

const mockSql = vi.hoisted(() => {
  // The neon() tagged-template function is called as:
  //   sql`SELECT …`        → first call (SELECT)
  //   sql(query, params)   → subsequent calls (UPDATE)
  // We make it a function that also supports being called as a tagged template.
  const fn = vi.fn();
  return fn;
});

vi.mock('@neondatabase/serverless', () => ({
  neon: vi.fn(() => mockSql),
}));

vi.mock('@latimer-woods-tech/video', () => ({
  signRenderPayload: vi.fn(({ timestamp }: { rawBody: string; secret: string; timestamp?: string }) =>
    Promise.resolve({
      signature: 'mock-sig',
      timestamp: timestamp ?? '1234567890',
    }),
  ),
}));

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const env = {
  SELFPRIME_DB_URL: 'postgres://user:pass@host/selfprime',
  PRIME_SELF_API_SECRET: 'test-secret',
};

const dueSubscription = {
  id: 'sub-001',
  user_id: 'user-abc',
  cadence: 'weekly',
  composition_spec: { sources: ['bodygraph'], format: 'portrait' },
  channels: ['in_app', 'email'],
  next_run_at: new Date(Date.now() - 60_000).toISOString(), // 1 minute ago
};

function makeFetch(status: number, body = '{}'): typeof fetch {
  return vi.fn().mockResolvedValue(
    new Response(body, { status }),
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// computeNextRunAt unit tests
// ---------------------------------------------------------------------------

describe('computeNextRunAt', () => {
  it('advances by 1 day for daily cadence', () => {
    const from = new Date('2026-06-02T00:00:00Z');
    const next = computeNextRunAt('daily', from);
    expect(next.toISOString()).toBe('2026-06-03T00:00:00.000Z');
  });

  it('advances by 7 days for weekly cadence', () => {
    const from = new Date('2026-06-02T00:00:00Z');
    const next = computeNextRunAt('weekly', from);
    expect(next.toISOString()).toBe('2026-06-09T00:00:00.000Z');
  });

  it('advances by 1 month for monthly cadence', () => {
    const from = new Date('2026-06-02T00:00:00Z');
    const next = computeNextRunAt('monthly', from);
    expect(next.toISOString()).toBe('2026-07-02T00:00:00.000Z');
  });

  it('defaults to weekly for an unrecognised cadence', () => {
    const from = new Date('2026-06-02T00:00:00Z');
    const next = computeNextRunAt('RRULE:FREQ=WEEKLY;BYDAY=MO', from);
    expect(next.toISOString()).toBe('2026-06-09T00:00:00.000Z');
  });

  it('is case-insensitive', () => {
    const from = new Date('2026-06-02T00:00:00Z');
    expect(computeNextRunAt('DAILY', from).toISOString()).toBe('2026-06-03T00:00:00.000Z');
    expect(computeNextRunAt('Monthly', from).toISOString()).toBe('2026-07-02T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// dispatchDueSubscriptions — no due subscriptions
// ---------------------------------------------------------------------------

describe('dispatchDueSubscriptions — empty result set', () => {
  it('returns { dispatched:0, skipped:0, errors:0 } when no rows are due', async () => {
    mockSql.mockResolvedValueOnce([]); // SELECT returns empty

    const result = await dispatchDueSubscriptions(env);

    expect(result).toEqual({ dispatched: 0, skipped: 0, errors: 0 });
  });
});

// ---------------------------------------------------------------------------
// dispatchDueSubscriptions — successful dispatch
// ---------------------------------------------------------------------------

describe('dispatchDueSubscriptions — successful dispatch', () => {
  it('dispatches a due subscription and updates next_run_at', async () => {
    // First call: SELECT
    mockSql.mockResolvedValueOnce([dueSubscription]);
    // Second call: UPDATE
    mockSql.mockResolvedValueOnce([]);

    const mockFetch = makeFetch(200);
    const result = await dispatchDueSubscriptions(env, { fetch: mockFetch });

    expect(result).toEqual({ dispatched: 1, skipped: 0, errors: 0 });

    // Verify the dispatch call was made
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.selfprime.net/api/internal/video/subscription-dispatch');
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Signature']).toBe('mock-sig');
    expect(headers['X-Timestamp']).toBeDefined();

    // Verify payload shape
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      subscriptionId: 'sub-001',
      userId: 'user-abc',
      spec: dueSubscription.composition_spec,
      channels: dueSubscription.channels,
    });

    // Verify next_run_at was updated (UPDATE call happened)
    expect(mockSql).toHaveBeenCalledTimes(2);
    const updateCall = (mockSql as ReturnType<typeof vi.fn>).mock.calls[1] as [string, unknown[]];
    expect(updateCall[0]).toContain('UPDATE video_subscription SET next_run_at');
    expect(updateCall[1][1]).toBe('sub-001');
  });
});

// ---------------------------------------------------------------------------
// dispatchDueSubscriptions — non-2xx response
// ---------------------------------------------------------------------------

describe('dispatchDueSubscriptions — non-2xx response', () => {
  it('increments errors and does NOT update next_run_at on non-2xx', async () => {
    mockSql.mockResolvedValueOnce([dueSubscription]);
    // No second call expected (no UPDATE)

    const mockFetch = makeFetch(500, '{"error":"internal"}');
    const result = await dispatchDueSubscriptions(env, { fetch: mockFetch });

    expect(result).toEqual({ dispatched: 0, skipped: 0, errors: 1 });

    // SELECT + no UPDATE = only 1 sql call
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('increments errors on 422 response', async () => {
    mockSql.mockResolvedValueOnce([dueSubscription]);

    const mockFetch = makeFetch(422, '{"error":"validation"}');
    const result = await dispatchDueSubscriptions(env, { fetch: mockFetch });

    expect(result).toEqual({ dispatched: 0, skipped: 0, errors: 1 });
    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// dispatchDueSubscriptions — HMAC signing verification
// ---------------------------------------------------------------------------

describe('dispatchDueSubscriptions — HMAC signing', () => {
  it('sends X-Signature and X-Timestamp headers', async () => {
    mockSql.mockResolvedValueOnce([dueSubscription]);
    mockSql.mockResolvedValueOnce([]);

    const mockFetch = makeFetch(200);
    await dispatchDueSubscriptions(env, { fetch: mockFetch });

    const [, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;

    expect(headers['X-Signature']).toBeTruthy();
    expect(headers['X-Timestamp']).toBeTruthy();
  });

  it('signs the exact raw body sent in the request', async () => {
    const { signRenderPayload } = await import('@latimer-woods-tech/video');

    mockSql.mockResolvedValueOnce([dueSubscription]);
    mockSql.mockResolvedValueOnce([]);

    const mockFetch = makeFetch(200);
    await dispatchDueSubscriptions(env, { fetch: mockFetch });

    const [, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const sentBody = init.body as string;

    // signRenderPayload was called with the same rawBody that was sent
    const signCalls = (signRenderPayload as ReturnType<typeof vi.fn>).mock.calls as Array<[{ rawBody: string; secret: string }]>;
    expect(signCalls[0]![0].rawBody).toBe(sentBody);
    expect(signCalls[0]![0].secret).toBe(env.PRIME_SELF_API_SECRET);
  });

  it('handles multiple due subscriptions independently', async () => {
    const sub2 = { ...dueSubscription, id: 'sub-002', user_id: 'user-xyz' };
    mockSql.mockResolvedValueOnce([dueSubscription, sub2]);
    mockSql.mockResolvedValueOnce([]); // UPDATE sub-001
    mockSql.mockResolvedValueOnce([]); // UPDATE sub-002

    const mockFetch = makeFetch(200);
    const result = await dispatchDueSubscriptions(env, { fetch: mockFetch });

    expect(result).toEqual({ dispatched: 2, skipped: 0, errors: 0 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// dispatchDueSubscriptions — mixed success/failure
// ---------------------------------------------------------------------------

describe('dispatchDueSubscriptions — mixed results', () => {
  it('counts dispatched and errors separately across a batch', async () => {
    const sub2 = { ...dueSubscription, id: 'sub-002', user_id: 'user-xyz' };
    mockSql.mockResolvedValueOnce([dueSubscription, sub2]);
    mockSql.mockResolvedValueOnce([]); // UPDATE for sub-001

    // First dispatch succeeds, second fails
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('error', { status: 503 })) as unknown as typeof fetch;

    const result = await dispatchDueSubscriptions(env, { fetch: mockFetch });

    expect(result).toEqual({ dispatched: 1, skipped: 0, errors: 1 });
  });
});

// ---------------------------------------------------------------------------
// dispatchDueSubscriptions — fetch network error (lines 615-625)
// ---------------------------------------------------------------------------

describe('dispatchDueSubscriptions — network failure', () => {
  it('increments errors when fetch throws a network error', async () => {
    mockSql.mockResolvedValueOnce([dueSubscription]);
    // No UPDATE call expected

    const mockFetch = vi.fn().mockRejectedValueOnce(new Error('network error')) as unknown as typeof fetch;
    const result = await dispatchDueSubscriptions(env, { fetch: mockFetch });

    expect(result).toEqual({ dispatched: 0, skipped: 0, errors: 1 });
    expect(mockSql).toHaveBeenCalledTimes(1); // Only SELECT, no UPDATE
  });
});

// ---------------------------------------------------------------------------
// dispatchDueSubscriptions — DB UPDATE failure (lines 636-645)
// ---------------------------------------------------------------------------

describe('dispatchDueSubscriptions — DB update failure', () => {
  it('increments errors when next_run_at UPDATE throws', async () => {
    mockSql.mockResolvedValueOnce([dueSubscription]);
    // Second call (UPDATE) throws
    mockSql.mockRejectedValueOnce(new Error('db connection lost'));

    const mockFetch = makeFetch(200);
    const result = await dispatchDueSubscriptions(env, { fetch: mockFetch });

    // Dispatch was sent (fetch called), but UPDATE failed → error
    expect(result).toEqual({ dispatched: 0, skipped: 0, errors: 1 });
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockSql).toHaveBeenCalledTimes(2);
  });
});
