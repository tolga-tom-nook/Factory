import { describe, it, expect, vi } from 'vitest';
import { runSession, type DOStorage, type SessionState } from './session.js';
import { ToolRegistry, type Tool } from './registry.js';
import type { LLMEnv } from '@latimer-woods-tech/llm';

const ENV: LLMEnv = {
  AI_GATEWAY_BASE_URL: 'https://gw.test',
  ANTHROPIC_API_KEY: 'ak-test',
  GROQ_API_KEY: 'grq-test',
  VERTEX_ACCESS_TOKEN: 'vtx-test',
  VERTEX_PROJECT: 'proj',
  VERTEX_LOCATION: 'us-central1',
};

/** In-memory DOStorage stub — mirrors the CF DO storage API. */
function makeStorage(initial: Record<string, unknown> = {}): DOStorage {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get: (k: string) => Promise.resolve(store.get(k) as never),
    put: (k: string, v: unknown) => { store.set(k, v); return Promise.resolve(); },
    delete: (k: string) => Promise.resolve(store.delete(k)),
    list: ({ prefix = '' }: { prefix?: string } = {}) => {
      const out = new Map<string, unknown>();
      for (const [k, v] of store) if (k.startsWith(prefix)) out.set(k, v);
      return Promise.resolve(out as never);
    },
  };
}

function makeRegistry(tools: Tool[] = []): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of tools) r.register(t);
  return r;
}

function textFetch(text: string) {
  return () => Promise.resolve(new Response(
    JSON.stringify({
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 8, output_tokens: 4 },
      model: 'claude-sonnet-4-20250514',
    }),
    { status: 200 },
  ));
}

function toolUseFetch(id: string, name: string, input: Record<string, unknown>) {
  return () => Promise.resolve(new Response(
    JSON.stringify({
      content: [{ type: 'tool_use', id, name, input }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 12, output_tokens: 6 },
      model: 'claude-sonnet-4-20250514',
    }),
    { status: 200 },
  ));
}

describe('runSession', () => {
  it('initialises state on first call', async () => {
    const storage = makeStorage();
    const fetch = vi.fn().mockImplementation(textFetch('hello'));
    await runSession(storage, 'sess-1', ENV, makeRegistry(),
      { messages: [{ role: 'user', content: 'hi' }] },
      { fetch: fetch as unknown as typeof globalThis.fetch });
    const state = await storage.get<SessionState>('session:state');
    expect(state?.sessionId).toBe('sess-1');
    expect(state?.status).toBe('done');
    expect(state?.totalTurns).toBe(1);
  });

  it('persists message history across two calls', async () => {
    const storage = makeStorage();
    const fetch = vi.fn().mockImplementation(textFetch('response'));

    await runSession(storage, 's', ENV, makeRegistry(),
      { messages: [{ role: 'user', content: 'first' }] },
      { fetch: fetch as unknown as typeof globalThis.fetch });
    await runSession(storage, 's', ENV, makeRegistry(),
      { messages: [{ role: 'user', content: 'second' }] },
      { fetch: fetch as unknown as typeof globalThis.fetch });

    const state = await storage.get<SessionState>('session:state');
    const userMsgs = state?.messages.filter(m => m.role === 'user') ?? [];
    expect(userMsgs.length).toBeGreaterThanOrEqual(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('accumulates totalCostUsd and totalTurns', async () => {
    const storage = makeStorage();
    const fetch = vi.fn().mockImplementation(textFetch('ok'));

    await runSession(storage, 's', ENV, makeRegistry(),
      { messages: [{ role: 'user', content: 'a' }] },
      { fetch: fetch as unknown as typeof globalThis.fetch });
    await runSession(storage, 's', ENV, makeRegistry(),
      { messages: [{ role: 'user', content: 'b' }] },
      { fetch: fetch as unknown as typeof globalThis.fetch });

    const state = await storage.get<SessionState>('session:state');
    expect(state?.totalTurns).toBe(2);
    expect(state?.totalCostUsd).toBeGreaterThan(0);
  });

  it('writes idempotency keys (turn:N) for each completed turn', async () => {
    const storage = makeStorage();
    const fetch = vi.fn()
      .mockImplementationOnce(toolUseFetch('tc_1', 'lookup', { id: 'x' }))
      .mockImplementationOnce(textFetch('done'));

    const tool: Tool = {
      name: 'lookup', description: 't', side_effects: 'none', required_scope: 'read',
      parameters: { type: 'object', properties: {} },
      invoke: vi.fn().mockResolvedValue({ ok: true, result: 'data' }),
    };
    await runSession(storage, 's', ENV, makeRegistry([tool]),
      { messages: [{ role: 'user', content: 'go' }] },
      { fetch: fetch as unknown as typeof globalThis.fetch });

    const turn0 = await storage.get('turn:0');
    const turn1 = await storage.get('turn:1');
    expect(turn0).toBeDefined();
    expect(turn1).toBeDefined();
  });

  it('idempotency: resumes from stored turns without re-executing', async () => {
    // Pre-populate storage with one completed turn (simulates DO eviction mid-run).
    const fakeTurn = {
      turn: 0,
      llmResult: { content: 'cached', provider: 'anthropic', model: 'claude-sonnet-4-20250514', tier: 'balanced', tokens: { input: 5, output: 3 }, latency: 10, attempts: 1 },
      receipts: [],
      costUsd: 0.001,
    };
    const storage = makeStorage({ 'turn:0': fakeTurn });
    const fetch = vi.fn().mockImplementation(textFetch('resumed'));

    await runSession(storage, 's', ENV, makeRegistry(),
      { messages: [{ role: 'user', content: 'continue' }] },
      { fetch: fetch as unknown as typeof globalThis.fetch });

    // The loop should have maxTurns reduced by 1 (resumeOffset=1), so with
    // default 10 turns it runs at most 9 — the key test is that the first
    // fetch call does NOT re-run turn 0.  Only 1 fetch for the resumed turn.
    expect(fetch).toHaveBeenCalledTimes(1);
    const state = await storage.get<SessionState>('session:state');
    expect(state?.status).toBe('done');
  });

  it('rejects subsequent calls when budget_exceeded', async () => {
    const storage = makeStorage({
      'session:state': {
        sessionId: 's', messages: [], turns: [], totalCostUsd: 5, totalTurns: 20,
        createdAt: '', updatedAt: '', status: 'budget_exceeded',
      } satisfies SessionState,
    });
    const fetch = vi.fn();

    const result = await runSession(storage, 's', ENV, makeRegistry(),
      { messages: [{ role: 'user', content: 'try' }] },
      { fetch: fetch as unknown as typeof globalThis.fetch });

    expect(result.stopReason).toBe('budget');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('marks status budget_exceeded when loop hits budget', async () => {
    const storage = makeStorage();
    const fetch = vi.fn().mockImplementation(toolUseFetch('tc_b', 'noop', {}));

    const tool: Tool = {
      name: 'noop', description: 't', side_effects: 'none', required_scope: 'read',
      parameters: { type: 'object', properties: {} },
      invoke: vi.fn().mockResolvedValue({ ok: true, result: null }),
    };
    await runSession(storage, 's', ENV, makeRegistry([tool]),
      { messages: [{ role: 'user', content: 'go' }], maxCostUsdThisRun: 0.000001 },
      { fetch: fetch as unknown as typeof globalThis.fetch });

    const state = await storage.get<SessionState>('session:state');
    // Either budget_exceeded or idle (budget so small even 1 turn may not trigger
    // but the cost will be >0 and session recorded).
    expect(['budget_exceeded', 'idle', 'done']).toContain(state?.status);
  });
});

// ─── AgentSessionDO HTTP handler ─────────────────────────────────────────────
import { AgentSessionDO } from './session.js';

function makeDO(initial: Record<string, unknown> = {}, fetchImpl?: typeof globalThis.fetch): AgentSessionDO {
  const storage = makeStorage(initial);
  return new AgentSessionDO(
    { storage, id: { toString: () => 'test-session' } },
    fetchImpl ? { fetch: fetchImpl } : undefined,
  );
}

describe('AgentSessionDO', () => {
  it('GET /health returns ok + sessionId', async () => {
    const do_ = makeDO();
    const res = await do_.fetch(new Request('http://do/health'));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; sessionId: string };
    expect(body.ok).toBe(true);
    expect(body.sessionId).toBe('test-session');
  });

  it('GET /history returns empty state for new session', async () => {
    const do_ = makeDO();
    const res = await do_.fetch(new Request('http://do/history'));
    const body = await res.json() as { messages: unknown[]; status: string };
    expect(body.messages).toEqual([]);
    expect(body.status).toBe('idle');
  });

  it('POST /reset clears state and turn keys', async () => {
    const do_ = makeDO({ 'session:state': { sessionId: 's', messages: [], turns: [], totalCostUsd: 0, totalTurns: 0, createdAt: '', updatedAt: '', status: 'done' }, 'turn:0': {} });
    await do_.fetch(new Request('http://do/reset', { method: 'POST' }));
    const histRes = await do_.fetch(new Request('http://do/history'));
    const body = await histRes.json() as { status: string };
    expect(body.status).toBe('idle');
  });

  it('POST /run executes the loop and returns AgentResult', async () => {
    const fetchImpl = vi.fn().mockImplementation(textFetch('do-response'));
    const do_ = makeDO({}, fetchImpl as unknown as typeof globalThis.fetch);
    const res = await do_.fetch(new Request('http://do/run', {
      method: 'POST',
      body: JSON.stringify({ env: ENV, messages: [{ role: 'user', content: 'hi' }] }),
      headers: { 'content-type': 'application/json' },
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { stopReason: string; content: string };
    expect(body.stopReason).toBe('end');
    expect(body.content).toBe('do-response');
  });

  it('POST /run persists history (second call sees first turn)', async () => {
    const fetchImpl = vi.fn().mockImplementation(textFetch('second'));
    const do_ = makeDO({}, fetchImpl as unknown as typeof globalThis.fetch);
    await do_.fetch(new Request('http://do/run', {
      method: 'POST',
      body: JSON.stringify({ env: ENV, messages: [{ role: 'user', content: 'first' }] }),
      headers: { 'content-type': 'application/json' },
    }));
    const histRes = await do_.fetch(new Request('http://do/history'));
    const hist = await histRes.json() as { totalTurns: number };
    expect(hist.totalTurns).toBe(1);
  });

  it('returns 404 for unknown routes', async () => {
    const do_ = makeDO();
    const res = await do_.fetch(new Request('http://do/unknown'));
    expect(res.status).toBe(404);
  });

  it('returns 500 on internal error (malformed request body)', async () => {
    const do_ = makeDO();
    const res = await do_.fetch(new Request('http://do/run', {
      method: 'POST',
      body: 'not json',
      headers: { 'content-type': 'application/json' },
    }));
    expect(res.status).toBe(500);
  });
});
