import { describe, it, expect, vi } from 'vitest';
import {
  assertRunBudget,
  assertTenantBudget,
  computeCostCents,
  getProjectMonthTotal,
  getTenantMonthTotal,
  getRunTotal,
  meteredComplete,
  recordCall,
  TIER_BUDGET_CENTS,
  type BudgetAlertContext,
  type BudgetExceededContext,
  type D1Like,
  type LedgerRow,
} from './index.js';

function makeDb(): { db: D1Like; inserts: unknown[][]; queries: Array<{ sql: string; binds: unknown[] }>; firstResult: Record<string, unknown> | null } {
  const inserts: unknown[][] = [];
  const queries: Array<{ sql: string; binds: unknown[] }> = [];
  let firstResult: Record<string, unknown> | null = { cost_cents: 0, input_tokens: 0, output_tokens: 0, call_count: 0 };
  const db: D1Like = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          queries.push({ sql, binds });
          return {
            first: <_T>() => Promise.resolve(firstResult as _T | null),
            run: () => {
              inserts.push(binds);
              return Promise.resolve({ success: true });
            },
            all: <_T>() => Promise.resolve({ results: [] as _T[] }),
          };
        },
      };
    },
  };
  return {
    db,
    inserts,
    queries,
    get firstResult() { return firstResult; },
    set firstResult(v: Record<string, unknown> | null) { firstResult = v; },
  } as unknown as { db: D1Like; inserts: unknown[][]; queries: Array<{ sql: string; binds: unknown[] }>; firstResult: Record<string, unknown> | null };
}

function llmResponse(content = 'hi') {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text: content }],
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500 },
      model: 'claude-sonnet-4-20250514',
    }),
    { status: 200, headers: { 'cf-aig-request-id': 'aig-1' } },
  );
}

const ENV = {
  AI_GATEWAY_BASE_URL: 'https://gw.test',
  ANTHROPIC_API_KEY: 'ak',
  GROQ_API_KEY: 'gk',
  VERTEX_ACCESS_TOKEN: 'v',
  VERTEX_PROJECT: 'p',
  VERTEX_LOCATION: 'us-central1',
};

describe('computeCostCents', () => {
  it('bills input + output with cache discount', () => {
    // Sonnet: $3/1M in, $15/1M out, $0.30/1M cache-read.
    // billable input 60k = 18c; cache 40k = 1.2c; output 50k = 75c => 94.2c, ceil => 95c.
    const c = computeCostCents('claude-sonnet-4-20250514', 100_000, 50_000, 40_000);
    expect(c).toBe(95);
  });

  it('bills 1M Sonnet input tokens at $3.00 (300 cents), not $0.03', () => {
    // Regression guard for the 100x under-billing bug: the per-Mtok values are
    // cents, so 1M input tokens must cost 300 cents, not 3.
    expect(computeCostCents('claude-sonnet-4-6', 1_000_000, 0, 0)).toBe(300);
  });

  it('returns 0 for unknown model', () => {
    expect(computeCostCents('unknown-model', 1000, 1000)).toBe(0);
  });

  it('bills the live verifier/workbench models (previously $0)', () => {
    // 1M input each, priced from @lwt/llm MODEL_PRICE_PER_1M (USD x 100 => cents).
    expect(computeCostCents('llama-4-maverick', 1_000_000, 0, 0)).toBe(50);  // $0.50/1M
    expect(computeCostCents('deepseek-chat', 1_000_000, 0, 0)).toBe(27);     // $0.27/1M
    expect(computeCostCents('gemini-2.5-pro', 0, 1_000_000, 0)).toBe(1000);  // $10/1M out
  });

  it('zero tokens bills zero', () => {
    expect(computeCostCents('claude-sonnet-4-20250514', 0, 0)).toBe(0);
  });
});

describe('recordCall', () => {
  it('writes a ledger row', async () => {
    const { db, inserts } = makeDb();
    const row: LedgerRow = {
      project: 'p1',
      actor: 'worker',
      runId: 'r-1',
      workload: 'synthesis',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      inputTokens: 1000,
      cachedInputTokens: 100,
      outputTokens: 200,
      costCents: 3,
      latencyMs: 120,
    };
    await recordCall(db, row, { now: () => 1_700_000_000_000 });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.[0]).toBe('p1');
    expect(inserts[0]?.[1]).toBe('worker');
  });

  it('swallows db errors and logs', async () => {
    const error = vi.fn();
    const db: D1Like = {
      prepare: () => ({
        bind: () => ({
          first: () => Promise.resolve(null),
          run: () => Promise.reject(new Error('boom')),
          all: () => Promise.resolve({ results: [] }),
        }),
      }),
    };
    await recordCall(db, {
      project: 'p', actor: 'w', provider: 'anthropic', model: 'm',
      inputTokens: 0, outputTokens: 0, costCents: 0, latencyMs: 0,
    }, { logger: { error } as unknown as import('@latimer-woods-tech/logger').Logger });
    expect(error).toHaveBeenCalledOnce();
  });
});

describe('getRunTotal and assertRunBudget', () => {
  it('reads run totals from SUM query', async () => {
    const harness = makeDb();
    harness.firstResult = { cost_cents: 250, input_tokens: 10_000, output_tokens: 500, call_count: 3 };
    const totals = await getRunTotal(harness.db, 'r-1');
    expect(totals.costCents).toBe(250);
    expect(totals.callCount).toBe(3);
  });

  it('assertRunBudget passes under cap', async () => {
    const h = makeDb();
    h.firstResult = { cost_cents: 100, input_tokens: 0, output_tokens: 0, call_count: 1 };
    await expect(assertRunBudget(h.db, 'r-1', 500)).resolves.toBeUndefined();
  });

  it('assertRunBudget throws BUDGET_EXCEEDED at cap', async () => {
    const h = makeDb();
    h.firstResult = { cost_cents: 500, input_tokens: 0, output_tokens: 0, call_count: 10 };
    await expect(assertRunBudget(h.db, 'r-1', 500)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
  });
});

describe('getProjectMonthTotal', () => {
  it('returns 0 when no rows', async () => {
    const h = makeDb();
    h.firstResult = { cost_cents: 0 };
    expect(await getProjectMonthTotal(h.db, 'p1', '2026-05')).toBe(0);
  });
});

describe('TIER_BUDGET_CENTS', () => {
  it('has entries for all four tiers', () => {
    expect(TIER_BUDGET_CENTS.free).toBe(50);
    expect(TIER_BUDGET_CENTS.individual).toBe(300);
    expect(TIER_BUDGET_CENTS.practitioner).toBe(3500);
    expect(TIER_BUDGET_CENTS.agency).toBe(15000);
  });
});

describe('getTenantMonthTotal', () => {
  it('queries by tenant_id', async () => {
    const h = makeDb();
    h.firstResult = { cost_cents: 42 };
    const total = await getTenantMonthTotal(h.db, 'tenant-1', '2026-05');
    expect(total).toBe(42);
    const q = h.queries.find(q => q.sql.includes('tenant_id'));
    expect(q).toBeTruthy();
    expect(q?.binds).toContain('tenant-1');
  });

  it('returns 0 when no rows', async () => {
    const h = makeDb();
    h.firstResult = { cost_cents: 0 };
    expect(await getTenantMonthTotal(h.db, 't', '2026-05')).toBe(0);
  });
});

describe('assertTenantBudget', () => {
  it('passes when under 80%', async () => {
    const h = makeDb();
    // individual cap = 300 cents; 50% spent = 150 cents
    h.firstResult = { cost_cents: 150 };
    await expect(
      assertTenantBudget(h.db, 'tenant-1', 'individual'),
    ).resolves.toBeUndefined();
  });

  it('accepts explicit yyyyMm override (covers opts.yyyyMm ?? branch)', async () => {
    const h = makeDb();
    h.firstResult = { cost_cents: 10 };
    await expect(
      assertTenantBudget(h.db, 'tenant-1', 'individual', { yyyyMm: '2026-01' }),
    ).resolves.toBeUndefined();
    // The SELECT should have been bound with the explicit month
    const q = h.queries.find(q => q.sql.toLowerCase().includes('yyyy_mm') || q.sql.toLowerCase().includes('select'));
    expect(q?.binds).toContain('2026-01');
  });

  it('fires onBudgetAlert callback at 80% but does not throw', async () => {
    const h = makeDb();
    // individual cap = 300; 80% = 240
    h.firstResult = { cost_cents: 240 };
    const alertFn = vi.fn<(ctx: BudgetAlertContext) => void>();
    await expect(
      assertTenantBudget(h.db, 'tenant-1', 'individual', { onBudgetAlert: alertFn }),
    ).resolves.toBeUndefined();
    // Alert fires asynchronously; give the microtask queue a turn
    await new Promise(r => setTimeout(r, 0));
    expect(alertFn).toHaveBeenCalledOnce();
    expect(alertFn.mock.calls[0]![0].percentUsed).toBeGreaterThanOrEqual(80);
  });

  it('logs BUDGET_WARNING at 90% but does not throw', async () => {
    const h = makeDb();
    // individual cap = 300; 90% = 270
    h.firstResult = { cost_cents: 270 };
    const warn = vi.fn();
    await expect(
      assertTenantBudget(h.db, 'tenant-1', 'individual', {}, { logger: { warn } as unknown as import('@latimer-woods-tech/logger').Logger }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toBe('llm-meter.budget.warning');
    expect(warn.mock.calls[0]![1]).toMatchObject({ event: 'BUDGET_WARNING' });
  });

  it('throws BUDGET_EXCEEDED at 100%', async () => {
    const h = makeDb();
    // individual cap = 300; 100% = 300
    h.firstResult = { cost_cents: 300 };
    await expect(
      assertTenantBudget(h.db, 'tenant-1', 'individual'),
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
  });

  it('throws BUDGET_EXCEEDED when over cap', async () => {
    const h = makeDb();
    // free cap = 50; spent 60 = over cap
    h.firstResult = { cost_cents: 60 };
    await expect(
      assertTenantBudget(h.db, 'tenant-x', 'free'),
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED', status: 429 });
  });

  it('writes a BUDGET_ALERT row to tenant_budget_warnings at 80%', async () => {
    const h = makeDb();
    h.firstResult = { cost_cents: 240 }; // 80% of individual (300)
    await assertTenantBudget(h.db, 'tenant-1', 'individual');
    await new Promise(r => setTimeout(r, 0));
    const warningInsert = h.queries.find(q => q.sql.includes('tenant_budget_warnings'));
    expect(warningInsert).toBeTruthy();
    expect(warningInsert?.binds[2]).toBe('BUDGET_ALERT');
  });

  it('writes a BUDGET_WARNING row to tenant_budget_warnings at 90%', async () => {
    const h = makeDb();
    h.firstResult = { cost_cents: 270 }; // 90% of individual (300)
    await assertTenantBudget(h.db, 'tenant-1', 'individual');
    await new Promise(r => setTimeout(r, 0));
    const warningInsert = h.queries.find(q => q.sql.includes('tenant_budget_warnings'));
    expect(warningInsert).toBeTruthy();
    expect(warningInsert?.binds[2]).toBe('BUDGET_WARNING');
  });


  it('swallows alerting errors and does not throw (Error instance)', async () => {
    const h = makeDb();
    h.firstResult = { cost_cents: 240 }; // 80% of individual (300)
    const failingAlert = vi.fn<(ctx: BudgetAlertContext) => Promise<void>>().mockRejectedValue(new Error('email down'));
    const errorLog = vi.fn();
    await expect(
      assertTenantBudget(
        h.db,
        'tenant-1',
        'individual',
        { onBudgetAlert: failingAlert },
        { logger: { error: errorLog } as unknown as import('@latimer-woods-tech/logger').Logger },
      ),
    ).resolves.toBeUndefined();
    // Give the async rejection a chance to propagate
    await new Promise(r => setTimeout(r, 0));
    expect(errorLog).toHaveBeenCalledOnce();
  });

  it('swallows alerting errors and does not throw (non-Error, covers String(e) branch)', async () => {
    const h = makeDb();
    h.firstResult = { cost_cents: 240 };
    // Reject with a plain string to cover the String(e) branch in onBudgetAlert.catch()
    const failingAlert = vi.fn<(ctx: BudgetAlertContext) => Promise<void>>().mockRejectedValue('smtp timeout');
    const errorLog = vi.fn();
    await expect(
      assertTenantBudget(
        h.db, 'tenant-1', 'individual',
        { onBudgetAlert: failingAlert },
        { logger: { error: errorLog } as unknown as import('@latimer-woods-tech/logger').Logger },
      ),
    ).resolves.toBeUndefined();
    await new Promise(r => setTimeout(r, 0));
    expect(errorLog).toHaveBeenCalledWith(
      'llm-meter.budget.alert.failed',
      expect.objectContaining({ error: 'smtp timeout' }),
    );
  });

  it('swallows DB error on warning-row insert and logs it', async () => {
    // DB where first() (SELECT) succeeds but run() (INSERT) rejects with an Error.
    const errorLog = vi.fn();
    const db: D1Like = {
      prepare: () => ({
        bind: () => ({
          first: <_T>() => Promise.resolve({ cost_cents: 240 } as _T),
          run: () => Promise.reject(new Error('disk full')),
          all: <_T>() => Promise.resolve({ results: [] as _T[] }),
        }),
      }),
    };
    await expect(
      assertTenantBudget(
        db,
        'tenant-1',
        'individual',
        {},
        { logger: { error: errorLog } as unknown as import('@latimer-woods-tech/logger').Logger },
      ),
    ).resolves.toBeUndefined();
    await new Promise(r => setTimeout(r, 0));
    expect(errorLog).toHaveBeenCalledWith(
      'llm-meter.budget.warning.insert.failed',
      expect.objectContaining({ error: 'disk full', tenantId: 'tenant-1' }),
    );
  });

  it('uses String(e) when non-Error is thrown on warning-row insert', async () => {
    // Throw a plain string (not an Error) to cover the String(e) branch.
    const errorLog = vi.fn();
    const db: D1Like = {
      prepare: () => ({
        bind: () => ({
          first: <_T>() => Promise.resolve({ cost_cents: 240 } as _T),
          run: () => Promise.reject('write conflict'), // not an Error instance
          all: <_T>() => Promise.resolve({ results: [] as _T[] }),
        }),
      }),
    };
    await assertTenantBudget(db, 'tenant-1', 'individual', {}, {
      logger: { error: errorLog } as unknown as import('@latimer-woods-tech/logger').Logger,
    });
    await new Promise(r => setTimeout(r, 0));
    expect(errorLog).toHaveBeenCalledWith(
      'llm-meter.budget.warning.insert.failed',
      expect.objectContaining({ error: 'write conflict' }),
    );
  });
});

describe('meteredComplete', () => {
  it('records a ledger row on success', async () => {
    const h = makeDb();
    const fetchImpl = vi.fn(() => Promise.resolve(llmResponse()));
    const res = await meteredComplete(
      h.db,
      [{ role: 'user', content: 'hi' }],
      ENV,
      { project: 'prime-self', actor: 'worker', runId: 'r-42', tier: 'balanced' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.error).toBeNull();
    // First query: budget check (SELECT SUM), second: INSERT
    const insertCall = h.queries.find(q => q.sql.includes('INSERT'));
    expect(insertCall).toBeTruthy();
  });

  it('short-circuits with BUDGET_EXCEEDED when cap hit', async () => {
    const h = makeDb();
    h.firstResult = { cost_cents: 600, input_tokens: 0, output_tokens: 0, call_count: 5 };
    const fetchImpl = vi.fn();
    const res = await meteredComplete(
      h.db,
      [{ role: 'user', content: 'hi' }],
      ENV,
      { project: 'prime-self', actor: 'worker', runId: 'r-42', tier: 'balanced', budget: { perRunCapCents: 500 } },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.data).toBeNull();
    expect(res.error!.code).toBe('BUDGET_EXCEEDED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips budget check when no runId', async () => {
    const h = makeDb();
    const fetchImpl = vi.fn(() => Promise.resolve(llmResponse()));
    const res = await meteredComplete(
      h.db,
      [{ role: 'user', content: 'hi' }],
      ENV,
      { project: 'prime-self', actor: 'worker', tier: 'balanced' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.error).toBeNull();
    // No SELECT-for-budget query; only INSERT
    const selects = h.queries.filter(q => q.sql.includes('SELECT') && q.sql.includes('run_id'));
    expect(selects).toHaveLength(0);
  });

  it('short-circuits with BUDGET_EXCEEDED when tenant monthly cap is hit', async () => {
    const h = makeDb();
    // free cap = 50; query returns 50 (at cap)
    h.firstResult = { cost_cents: 50, input_tokens: 0, output_tokens: 0, call_count: 0 };
    const fetchImpl = vi.fn();
    const res = await meteredComplete(
      h.db,
      [{ role: 'user', content: 'hi' }],
      ENV,
      {
        project: 'prime-self',
        actor: 'worker',
        tier: 'balanced',
        tenantId: 'tenant-free-1',
        tenantTier: 'free',
      },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.data).toBeNull();
    expect(res.error!.code).toBe('BUDGET_EXCEEDED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('records tenant_id in ledger row on success', async () => {
    const h = makeDb();
    // Return 0 cost for budget check, then handle INSERT
    h.firstResult = { cost_cents: 0, input_tokens: 0, output_tokens: 0, call_count: 0 };
    const fetchImpl = vi.fn(() => Promise.resolve(llmResponse()));
    const res = await meteredComplete(
      h.db,
      [{ role: 'user', content: 'hi' }],
      ENV,
      {
        project: 'prime-self',
        actor: 'worker',
        runId: 'r-99',
        tier: 'balanced',
        tenantId: 'tenant-pro-1',
        tenantTier: 'practitioner',
      },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.error).toBeNull();
    const insertCall = h.queries.find(q => q.sql.includes('INSERT'));
    expect(insertCall).toBeTruthy();
    // tenant_id is the 3rd bind parameter in the INSERT
    expect(insertCall?.binds[2]).toBe('tenant-pro-1');
  });

  it('does not record on LLM failure', async () => {
    const h = makeDb();
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('nope', { status: 400 })));
    const res = await meteredComplete(
      h.db,
      [{ role: 'user', content: 'hi' }],
      ENV,
      { project: 'prime-self', actor: 'worker', tier: 'balanced' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.error).not.toBeNull();
    const inserts = h.queries.filter(q => q.sql.includes('INSERT'));
    expect(inserts).toHaveLength(0);
  });

  it('wraps plain Error from assertRunBudget in InternalError (covers e.message branch)', async () => {
    // DB whose first() rejects with a plain Error (not a FactoryBaseError)
    const db: D1Like = {
      prepare: () => ({
        bind: () => ({
          first: <_T>() => Promise.reject(new Error('db timeout')),
          run: () => Promise.resolve({ success: true }),
          all: <_T>() => Promise.resolve({ results: [] as _T[] }),
        }),
      }),
    };
    const res = await meteredComplete(
      db,
      [{ role: 'user', content: 'hi' }],
      ENV,
      { project: 'prime-self', actor: 'worker', runId: 'r-db-err', tier: 'balanced' },
      { fetch: vi.fn() as unknown as typeof fetch },
    );
    expect(res.data).toBeNull();
    expect(res.error!.code).toBe('INTERNAL_ERROR');
  });

  it('wraps non-Error from assertRunBudget in InternalError (covers String(e) branch)', async () => {
    const db: D1Like = {
      prepare: () => ({
        bind: () => ({
          first: <_T>() => Promise.reject('db timeout'), // not an Error instance
          run: () => Promise.resolve({ success: true }),
          all: <_T>() => Promise.resolve({ results: [] as _T[] }),
        }),
      }),
    };
    const res = await meteredComplete(
      db,
      [{ role: 'user', content: 'hi' }],
      ENV,
      { project: 'prime-self', actor: 'worker', runId: 'r-db-err2', tier: 'balanced' },
      { fetch: vi.fn() as unknown as typeof fetch },
    );
    expect(res.data).toBeNull();
    expect(res.error!.code).toBe('INTERNAL_ERROR');
  });

  it('wraps plain Error from assertTenantBudget in InternalError (covers e.message branch)', async () => {
    const db: D1Like = {
      prepare: () => ({
        bind: () => ({
          first: <_T>() => Promise.reject(new Error('network error')),
          run: () => Promise.resolve({ success: true }),
          all: <_T>() => Promise.resolve({ results: [] as _T[] }),
        }),
      }),
    };
    const res = await meteredComplete(
      db,
      [{ role: 'user', content: 'hi' }],
      ENV,
      { project: 'prime-self', actor: 'worker', tier: 'balanced', tenantId: 'tenant-err', tenantTier: 'individual' },
      { fetch: vi.fn() as unknown as typeof fetch },
    );
    expect(res.data).toBeNull();
    expect(res.error!.code).toBe('INTERNAL_ERROR');
  });

  it('wraps non-Error from assertTenantBudget in InternalError (covers String(e) branch)', async () => {
    const db: D1Like = {
      prepare: () => ({
        bind: () => ({
          first: <_T>() => Promise.reject('network error'), // not an Error instance
          run: () => Promise.resolve({ success: true }),
          all: <_T>() => Promise.resolve({ results: [] as _T[] }),
        }),
      }),
    };
    const res = await meteredComplete(
      db,
      [{ role: 'user', content: 'hi' }],
      ENV,
      { project: 'prime-self', actor: 'worker', tier: 'balanced', tenantId: 'tenant-err2', tenantTier: 'individual' },
      { fetch: vi.fn() as unknown as typeof fetch },
    );
    expect(res.data).toBeNull();
    expect(res.error!.code).toBe('INTERNAL_ERROR');
  });

  it('fires onBudgetExceeded when run cap is hit', async () => {
    const h = makeDb();
    h.firstResult = { cost_cents: 600, input_tokens: 0, output_tokens: 0, call_count: 5 };
    const onBudgetExceeded = vi.fn().mockResolvedValue(undefined);
    const res = await meteredComplete(
      h.db,
      [{ role: 'user', content: 'hi' }],
      ENV,
      { project: 'p', actor: 'a', runId: 'r-99', tier: 'balanced', budget: { perRunCapCents: 500, onBudgetExceeded } },
      { fetch: vi.fn() as unknown as typeof fetch },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(res.error!.code).toBe('BUDGET_EXCEEDED');
    expect(onBudgetExceeded).toHaveBeenCalledOnce();
    const ctx = onBudgetExceeded.mock.calls[0]![0] as BudgetExceededContext;
    expect(ctx.kind).toBe('run');
    expect(ctx.runId).toBe('r-99');
    expect(typeof ctx.spentCents).toBe('number');
  });

  it('fires onBudgetExceeded when tenant monthly cap is hit', async () => {
    const h = makeDb();
    // Spend > free cap (50 cents)
    h.firstResult = { cost_cents: 60, input_tokens: 0, output_tokens: 0, call_count: 3 };
    const onBudgetExceeded = vi.fn().mockResolvedValue(undefined);
    const res = await meteredComplete(
      h.db,
      [{ role: 'user', content: 'hi' }],
      ENV,
      {
        project: 'p', actor: 'a', tier: 'balanced',
        tenantId: 'tenant-cap', tenantTier: 'free',
        budget: { onBudgetExceeded },
      },
      { fetch: vi.fn() as unknown as typeof fetch },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(res.error!.code).toBe('BUDGET_EXCEEDED');
    expect(onBudgetExceeded).toHaveBeenCalledOnce();
    const ctx = onBudgetExceeded.mock.calls[0]![0] as BudgetExceededContext;
    expect(ctx.kind).toBe('tenant');
    expect(ctx.tenantId).toBe('tenant-cap');
    expect(ctx.tier).toBe('free');
  });

  it('swallows onBudgetExceeded Error and logs warning', async () => {
    const h = makeDb();
    h.firstResult = { cost_cents: 600, input_tokens: 0, output_tokens: 0, call_count: 5 };
    const warnSpy = vi.fn();
    const onBudgetExceeded = vi.fn().mockRejectedValue(new Error('gate write failed'));
    const res = await meteredComplete(
      h.db,
      [{ role: 'user', content: 'hi' }],
      ENV,
      { project: 'p', actor: 'a', runId: 'r-err', tier: 'balanced', budget: { perRunCapCents: 500, onBudgetExceeded } },
      { fetch: vi.fn() as unknown as typeof fetch, logger: { warn: warnSpy } as never },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(res.error!.code).toBe('BUDGET_EXCEEDED');
    expect(warnSpy).toHaveBeenCalledWith('llm-meter.onBudgetExceeded.error', expect.objectContaining({ message: 'gate write failed' }));
  });

  it('swallows non-Error from onBudgetExceeded (covers String(e) branch)', async () => {
    const h = makeDb();
    h.firstResult = { cost_cents: 600, input_tokens: 0, output_tokens: 0, call_count: 5 };
    const warnSpy = vi.fn();
    const onBudgetExceeded = vi.fn().mockRejectedValue('network timeout');
    const res = await meteredComplete(
      h.db,
      [{ role: 'user', content: 'hi' }],
      ENV,
      { project: 'p', actor: 'a', runId: 'r-str', tier: 'balanced', budget: { perRunCapCents: 500, onBudgetExceeded } },
      { fetch: vi.fn() as unknown as typeof fetch, logger: { warn: warnSpy } as never },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(res.error!.code).toBe('BUDGET_EXCEEDED');
    expect(warnSpy).toHaveBeenCalledWith('llm-meter.onBudgetExceeded.error', expect.objectContaining({ message: 'network timeout' }));
  });

  it('swallows tenant onBudgetExceeded Error and logs warning (covers tenant .catch branch)', async () => {
    const h = makeDb();
    h.firstResult = { cost_cents: 60, input_tokens: 0, output_tokens: 0, call_count: 3 };
    const warnSpy = vi.fn();
    const onBudgetExceeded = vi.fn().mockRejectedValue(new Error('gate failed'));
    const res = await meteredComplete(
      h.db,
      [{ role: 'user', content: 'hi' }],
      ENV,
      {
        project: 'p', actor: 'a', tier: 'balanced',
        tenantId: 'tenant-cb', tenantTier: 'free',
        budget: { onBudgetExceeded },
      },
      { fetch: vi.fn() as unknown as typeof fetch, logger: { warn: warnSpy } as never },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(res.error!.code).toBe('BUDGET_EXCEEDED');
    expect(warnSpy).toHaveBeenCalledWith('llm-meter.onBudgetExceeded.error', expect.objectContaining({ message: 'gate failed' }));
  });

  it('swallows non-Error from tenant onBudgetExceeded (covers tenant String(err) branch)', async () => {
    const h = makeDb();
    h.firstResult = { cost_cents: 60, input_tokens: 0, output_tokens: 0, call_count: 3 };
    const warnSpy = vi.fn();
    const onBudgetExceeded = vi.fn().mockRejectedValue('cf timeout');
    const res = await meteredComplete(
      h.db,
      [{ role: 'user', content: 'hi' }],
      ENV,
      {
        project: 'p', actor: 'a', tier: 'balanced',
        tenantId: 'tenant-str', tenantTier: 'free',
        budget: { onBudgetExceeded },
      },
      { fetch: vi.fn() as unknown as typeof fetch, logger: { warn: warnSpy } as never },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(res.error!.code).toBe('BUDGET_EXCEEDED');
    expect(warnSpy).toHaveBeenCalledWith('llm-meter.onBudgetExceeded.error', expect.objectContaining({ message: 'cf timeout' }));
  });

  it('handles success with no cacheRead tokens (covers cacheRead ?? 0 false branches)', async () => {
    const h = makeDb();
    const noCacheResponse = new Response(
      JSON.stringify({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 100, output_tokens: 20 },
        model: 'claude-sonnet-4-20250514',
      }),
      { status: 200, headers: { 'cf-aig-request-id': 'aig-nc' } },
    );
    const fetchImpl = vi.fn(() => Promise.resolve(noCacheResponse));
    const res = await meteredComplete(
      h.db,
      [{ role: 'user', content: 'hi' }],
      ENV,
      { project: 'p', actor: 'a', runId: 'r-nc', tier: 'balanced' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.error).toBeNull();
    const insertCall = h.queries.find(q => q.sql.includes('INSERT'));
    expect(insertCall).toBeTruthy();
  });
});
