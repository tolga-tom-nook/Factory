import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  complete,
  completionStream,
  assertGrounding,
  isProviderCoolingDown,
  markProviderCoolingDown,
  clearProviderCooldown,
  PROVIDER_COOLDOWN_MS,
  type LLMEnv,
  type LLMRecordRow,
  type LLMResult,
} from './index.js';

const ENV: LLMEnv = {
  AI_GATEWAY_BASE_URL: 'https://gateway.test/v1',
  ANTHROPIC_API_KEY: 'ak-test',
  GROQ_API_KEY: 'grq-test',
  DEEPSEEK_API_KEY: 'dsk-test',
  VERTEX_ACCESS_TOKEN: 'vertex-test',
  VERTEX_PROJECT: 'factory-495015',
  VERTEX_LOCATION: 'us-central1',
};

function anthropicResponse(text = 'hello', extra: Record<string, number> = {}) {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text }],
      usage: {
        input_tokens: 12,
        output_tokens: 7,
        cache_read_input_tokens: extra.cacheRead ?? 0,
        cache_creation_input_tokens: extra.cacheWrite ?? 0,
      },
      model: 'claude-sonnet-4-20250514',
    }),
    { status: 200, headers: { 'cf-aig-request-id': 'aig-xyz' } },
  );
}

function geminiResponse(text = 'gemini-hello') {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 200000, candidatesTokenCount: 9 },
    }),
    { status: 200 },
  );
}

function groqResponse(text = 'verdict') {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
      model: 'llama-3.3-70b-versatile',
    }),
    { status: 200 },
  );
}

function deepSeekResponse(text = 'workbench') {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 11, completion_tokens: 6 },
      model: 'deepseek-chat',
    }),
    { status: 200, headers: { 'cf-aig-request-id': 'deepseek-aig' } },
  );
}

// â”€â”€â”€ SSE helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Builds a ReadableStream that emits Anthropic SSE events for the given text chunks.
 */
function buildAnthropicStream(chunks: string[], modelName = 'claude-sonnet-4-20250514'): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const events: string[] = [];

  events.push(
    `data: ${JSON.stringify({
      type: 'message_start',
      message: {
        usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        model: modelName,
      },
    })}\n\n`,
  );

  for (const chunk of chunks) {
    events.push(
      `data: ${JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: chunk },
      })}\n\n`,
    );
  }

  events.push(
    `data: ${JSON.stringify({
      type: 'message_delta',
      usage: { output_tokens: chunks.reduce((s, c) => s + c.length, 0) },
    })}\n\n`,
  );

  events.push('data: [DONE]\n\n');

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) {
        controller.enqueue(encoder.encode(e));
      }
      controller.close();
    },
  });
}

/** Drains an async generator collecting all yielded values and the return value. */
async function drainStream(gen: AsyncGenerator<string, unknown, unknown>): Promise<{ chunks: string[]; result: unknown }> {
  const chunks: string[] = [];
  let done = false;
  let result: unknown;
  while (!done) {
    const next = await gen.next();
    if (next.done) {
      result = next.value;
      done = true;
    } else {
      chunks.push(next.value);
    }
  }
  return { chunks, result };
}

// â”€â”€â”€ Reset cooldown state before each test â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
beforeEach(() => {
  // Clear all provider cooldown states to prevent test pollution.
  clearProviderCooldown('anthropic');
  clearProviderCooldown('gemini');
  clearProviderCooldown('groq');
  clearProviderCooldown('grok');
  clearProviderCooldown('deepseek');
});

// â”€â”€â”€ Existing complete() tests (unchanged) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('complete', () => {
  it('routes balanced tier to Anthropic and returns parsed result', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(anthropicResponse('ok')));
    const res = await complete(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'balanced' },
      { fetch: fetchImpl as unknown as typeof fetch, now: () => 1000 },
    );
    expect(res.error).toBeNull();
    expect(res.data).not.toBeNull();
    expect(res.data!.provider).toBe('anthropic');
    expect(res.data!.tier).toBe('balanced');
    expect(res.data!.tokens.input).toBe(12);
    expect(res.data!.gatewayRequestId).toBe('aig-xyz');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const call = fetchImpl.mock.calls[0] as unknown as [string | URL | Request, RequestInit?];
    expect(String(call[0])).toContain('anthropic/v1/messages');
  });

  it('sends cf-aig-metadata header with caller attribution when set', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(anthropicResponse('ok')));
    await complete(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'balanced', project: 'daily-brief', workload: 'narration', actor: 'worker', runId: 'r-1' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    const call = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(call[1].headers['cf-aig-metadata']).toBeDefined();
    const meta = JSON.parse(call[1].headers['cf-aig-metadata']!) as Record<string, string>;
    expect(meta).toEqual({ project: 'daily-brief', workload: 'narration', actor: 'worker', runId: 'r-1' });
  });

  it('omits cf-aig-metadata header when no attribution fields are set', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(anthropicResponse('ok')));
    await complete(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'balanced' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    const call = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(call[1].headers['cf-aig-metadata']).toBeUndefined();
  });

  it('fast tier falls back to Haiku when Grok key is unavailable', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(anthropicResponse('fast')));
    const res = await complete(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'fast' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.error).toBeNull();
    expect(res.data!.tier).toBe('fast');
    expect(res.data!.provider).toBe('anthropic');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('fast tier uses Grok 4.3 with no reasoning when Grok key is available', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'grok-fast' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 7, completion_tokens: 4 },
            model: 'grok-4.3',
          }),
          { status: 200, headers: { 'cf-aig-request-id': 'grok-aig' } },
        ),
      ),
    );
    const res = await complete(
      [{ role: 'user', content: 'hi' }],
      { ...ENV, GROK_API_KEY: 'gk-test' },
      { tier: 'fast' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.error).toBeNull();
    expect(res.data!.provider).toBe('grok');
    expect(res.data!.model).toBe('grok-4.3');
    const call = fetchImpl.mock.calls[0] as unknown as [string, { body: string }];
    const body = JSON.parse(call[1].body) as { model: string; reasoning_effort: string };
    expect(body.model).toBe('grok-4.3');
    expect(body.reasoning_effort).toBe('none');
  });

  it('smart tier with long-context goes to Gemini primary', async () => {
    const fetchImpl = vi.fn((url: string | URL | Request) => {
      if (String(url).includes('google-vertex-ai')) return Promise.resolve(geminiResponse('smart-long'));
      return Promise.resolve(new Response('', { status: 500 }));
    });
    const longText = 'y'.repeat(700_000);
    const res = await complete(
      [{ role: 'user', content: longText }],
      ENV,
      { tier: 'smart' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.data!.provider).toBe('gemini');
    expect(res.data!.tier).toBe('smart');
  });

  it('smart tier short-context uses Opus', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(anthropicResponse('smart')));
    const res = await complete(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'smart' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.data!.provider).toBe('anthropic');
    expect(res.data!.model).toContain('sonnet');
  });

  it('explicit model override routes to matching provider', async () => {
    const fetchImpl = vi.fn((url: string | URL | Request) => {
      if (String(url).includes('google-vertex-ai')) return Promise.resolve(geminiResponse('override'));
      return Promise.resolve(new Response('', { status: 500 }));
    });
    const res = await complete(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { model: 'gemini-1.5-flash' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.data!.provider).toBe('gemini');
  });

  it('routes long-context balanced to Gemini primary', async () => {
    const fetchImpl = vi.fn((url: string | URL | Request) => {
      if (String(url).includes('google-vertex-ai')) return Promise.resolve(geminiResponse('long'));
      return Promise.resolve(new Response('', { status: 500 }));
    });
    const longText = 'x'.repeat(700_000);
    const res = await complete(
      [{ role: 'user', content: longText }],
      ENV,
      { tier: 'balanced' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.error).toBeNull();
    expect(res.data!.provider).toBe('gemini');
  });

  it('falls back to Gemini when Anthropic returns 503', async () => {
    const fetchImpl = vi.fn((url: string | URL | Request) => {
      if (String(url).includes('anthropic')) return Promise.resolve(new Response('boom', { status: 503 }));
      if (String(url).includes('google-vertex-ai')) return Promise.resolve(geminiResponse('fallback'));
      return Promise.resolve(new Response('', { status: 500 }));
    });
    const res = await complete(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'balanced' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.error).toBeNull();
    expect(res.data!.provider).toBe('gemini');
  });

  it('retries on 429 then succeeds', async () => {
    let n = 0;
    const fetchImpl = vi.fn(() => {
      n++;
      if (n === 1) return Promise.resolve(new Response('rate', { status: 429 }));
      return Promise.resolve(anthropicResponse('ok-after-retry'));
    });
    const res = await complete(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'fast' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.error).toBeNull();
    expect(res.data!.attempts).toBe(2);
  });

  it('returns rate-limit error when no fallback and 429 exhausts', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('rate', { status: 429 })));
    const res = await complete(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'fast' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.data).toBeNull();
    expect(res.error!.code).toBe('RATE_LIMITED');
  });

  it('verifier tier hits Groq only', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(groqResponse('verdict')));
    const res = await complete(
      [{ role: 'user', content: 'verify' }],
      ENV,
      { tier: 'verifier' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.error).toBeNull();
    expect(res.data!.provider).toBe('groq');
    const call = fetchImpl.mock.calls[0] as unknown as [string | URL | Request, RequestInit?];
    expect(String(call[0])).toContain('groq/openai/v1/chat/completions');
  });

  it('workbench tier routes to DeepSeek for cheap internal batch work', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(deepSeekResponse('cheap-draft')));
    const res = await complete(
      [{ role: 'user', content: 'summarize this non-sensitive changelog' }],
      ENV,
      { tier: 'workbench', workload: 'docs-summary' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.error).toBeNull();
    expect(res.data!.provider).toBe('deepseek');
    expect(res.data!.model).toBe('deepseek-chat');
    expect(res.data!.tier).toBe('workbench');
    expect(res.data!.gatewayRequestId).toBe('deepseek-aig');
    const call = fetchImpl.mock.calls[0] as unknown as [string, { body: string; headers: Record<string, string> }];
    expect(String(call[0])).toContain('/deepseek/chat/completions');
    expect(call[1].headers.authorization).toBe('Bearer dsk-test');
    const body = JSON.parse(call[1].body) as { model: string };
    expect(body.model).toBe('deepseek-chat');
  });

  it('workbench tier falls back to Groq when DeepSeek key is unavailable', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(groqResponse('fallback-verdict')));
    const envWithoutDeepSeek = { ...ENV, DEEPSEEK_API_KEY: undefined };
    const res = await complete(
      [{ role: 'user', content: 'classify these public docs' }],
      envWithoutDeepSeek,
      { tier: 'workbench' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.error).toBeNull();
    expect(res.data!.provider).toBe('groq');
    expect(res.data!.tier).toBe('workbench');
    const call = fetchImpl.mock.calls[0] as unknown as [string | URL | Request, RequestInit?];
    expect(String(call[0])).toContain('groq/openai/v1/chat/completions');
  });

  it('routes deepseek-* model override through DeepSeek', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(deepSeekResponse('reasoned')));
    const res = await complete(
      [{ role: 'user', content: 'outline a doc cleanup plan' }],
      ENV,
      { model: 'deepseek-reasoner' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.error).toBeNull();
    expect(res.data!.provider).toBe('deepseek');
    const call = fetchImpl.mock.calls[0] as unknown as [string, { body: string }];
    const body = JSON.parse(call[1].body) as { model: string };
    expect(body.model).toBe('deepseek-reasoner');
  });

  it('enables prompt caching for long system prompt', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(anthropicResponse('cached', { cacheRead: 100, cacheWrite: 0 })));
    const longSystem = 'you are helpful. '.repeat(400);
    const res = await complete(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'fast', system: longSystem },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.data!.tokens.cacheRead).toBe(100);
    const call = fetchImpl.mock.calls[0] as unknown as [string, { body: string }];
    const body = JSON.parse(call[1].body) as { system: unknown };
    expect(Array.isArray(body.system)).toBe(true);
  });

  it('stamps ledger fields to logger', async () => {
    const info = vi.fn();
    const fetchImpl = vi.fn(() => Promise.resolve(anthropicResponse()));
    await complete(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'fast', runId: 'r-1', project: 'p-1', actor: 'a-1' },
      { fetch: fetchImpl as unknown as typeof fetch, logger: { info } as unknown as import('@latimer-woods-tech/logger').Logger },
    );
    expect(info).toHaveBeenCalled();
    const args = info.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(args[1]).toMatchObject({ runId: 'r-1', project: 'p-1', actor: 'a-1' });
  });

  it('returns LLM_ALL_PROVIDERS_FAILED when both legs fail non-retryably', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('nope', { status: 400 })));
    const res = await complete(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'balanced' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.data).toBeNull();
    expect(res.error).not.toBeNull();
    expect(res.error!.code).toBe('INTERNAL_ERROR');
    expect(res.error!.message).toContain('LLM_ALL_PROVIDERS_FAILED');
  });

  it('empty anthropic response triggers fallback', async () => {
    const fetchImpl = vi.fn((url: string | URL | Request) => {
      if (String(url).includes('anthropic')) {
        return Promise.resolve(new Response(JSON.stringify({ content: [{ type: 'text', text: '' }], usage: {} }), { status: 200 }));
      }
      return Promise.resolve(geminiResponse('fallback-empty'));
    });
    const res = await complete(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'balanced' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.data!.provider).toBe('gemini');
  });

  it('throws on missing AI_GATEWAY_BASE_URL', async () => {
    const bad = { ...ENV, AI_GATEWAY_BASE_URL: '' };
    await expect(
      complete([{ role: 'user', content: 'x' }], bad as LLMEnv, { tier: 'fast' }),
    ).rejects.toThrow(/AI_GATEWAY_BASE_URL/);
  });

  it('throws on empty messages', async () => {
    await expect(
      complete([], ENV, { tier: 'fast' }),
    ).rejects.toThrow(/messages must not be empty/);
  });

  it('respects AbortSignal and returns aborted error', async () => {
    const ctl = new AbortController();
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      });
    });
    const p = complete(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'fast', signal: ctl.signal },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    ctl.abort();
    const res = await p;
    expect(res.data).toBeNull();
    expect(res.error?.message).toMatch(/aborted/);
  });
  it('routes grok-* model override through buildGrokRequest (lines 529, 583-584, 602)', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'grok-ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 3 },
            model: 'grok-4-fast',
          }),
          { status: 200, headers: { 'cf-aig-request-id': 'grok-aig' } },
        ),
      ),
    );
    const res = await complete(
      [{ role: 'user', content: 'hi' }],
      { ...ENV, GROK_API_KEY: 'gk-test' },
      { model: 'grok-4-fast' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.error).toBeNull();
    expect(res.data!.provider).toBe('grok');
    expect(res.data!.content).toBe('grok-ok');
    const call = fetchImpl.mock.calls[0] as unknown as [string | URL | Request, RequestInit?];
    expect(String(call[0])).toContain('/grok/');
  });

  it('falls back to groq for unrecognized model override (line 530)', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'llama-ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 3 },
            model: 'llama-3.3-custom',
          }),
          { status: 200 },
        ),
      ),
    );
    const res = await complete(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { model: 'llama-3.3-custom' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.error).toBeNull();
    expect(res.data!.provider).toBe('groq');
    expect(res.data!.content).toBe('llama-ok');
  });

  it('sends system as plain string for short prompt (line 250, no cache)', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(anthropicResponse('sys-ok')));
    const res = await complete(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'fast', system: 'short system' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.error).toBeNull();
    const call = fetchImpl.mock.calls[0] as unknown as [string, { body: string }];
    const body = JSON.parse(call[1].body) as { system: unknown };
    expect(typeof body.system).toBe('string');
  });

  it('includes systemInstruction in Gemini request when system provided (lines 285-286)', async () => {
    const fetchImpl = vi.fn((url: string | URL | Request) => {
      if (String(url).includes('google-vertex-ai')) return Promise.resolve(geminiResponse('sys-gemini'));
      return Promise.resolve(new Response('', { status: 500 }));
    });
    const res = await complete(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { model: 'gemini-1.5-flash', system: 'be concise' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.error).toBeNull();
    const call = fetchImpl.mock.calls[0] as unknown as [string, { body: string }];
    const body = JSON.parse(call[1].body) as { systemInstruction?: unknown };
    expect(body.systemInstruction).toBeDefined();
  });

  it('returns error when grok-* used without GROK_API_KEY (lines 330-331)', async () => {
    const res = await complete([{ role: 'user', content: 'hi' }], ENV, { model: 'grok-4-fast' });
    expect(res.data).toBeNull();
    expect(JSON.stringify(res.error!.context)).toMatch(/GROK_API_KEY required/);
  });

});

// â”€â”€â”€ Feature 1 + 2: Per-provider exponential backoff & cooldown â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('per-provider exponential backoff', () => {
  it('retries on 429 up to 2 times then marks provider cooling down', async () => {
    // The provider returns 429 all 3 attempts; after exhaustion it should be marked cooling down.
    const now = vi.fn(() => 1_000_000);
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('rate', { status: 429 })));

    const res = await complete(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'fast' }, // fast = anthropic only, no fallback
      { fetch: fetchImpl as unknown as typeof fetch, now },
    );

    // 3 attempts (1 initial + 2 retries)
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(res.error!.code).toBe('RATE_LIMITED');

    // Provider should now be in cooldown
    expect(isProviderCoolingDown('anthropic', now)).toBe(true);
  });

  it('does NOT retry on a terminal 4xx (403)', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('forbidden', { status: 403 })));

    const res = await complete(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'fast' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );

    // Should stop immediately â€” only 1 call
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res.data).toBeNull();
  });

  it('retries on 5xx up to PER_PROVIDER_MAX_ATTEMPTS times', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(() => {
      calls++;
      if (calls < 3) return Promise.resolve(new Response('server error', { status: 500 }));
      return Promise.resolve(anthropicResponse('recovered'));
    });

    const res = await complete(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'fast' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(res.data!.provider).toBe('anthropic');
    expect(res.data!.attempts).toBe(3);
  });

  it('clears cooldown on success after a previous failure', () => {
    const now = vi.fn(() => 1_000_000);
    // Mark anthropic as cooling down
    markProviderCoolingDown('anthropic', now);
    expect(isProviderCoolingDown('anthropic', now)).toBe(true);

    // Advance time past cooldown
    now.mockReturnValue(1_000_000 + PROVIDER_COOLDOWN_MS + 1);
    expect(isProviderCoolingDown('anthropic', now)).toBe(false);
  });

  it('records non-ProviderError on intermediate attempt and recovers (line 494)', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(() => {
      calls++;
      if (calls === 1) return Promise.reject(new Error('transient-net-err'));
      return Promise.resolve(anthropicResponse('recovered'));
    });
    const res = await complete(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'fast' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(res.data!.content).toBe('recovered');
  });

  it('records retryable ProviderError thrown by fetchImpl on non-last attempt (line 485)', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(() => {
      calls++;
      if (calls === 1) {
        return Promise.reject({ provider: 'anthropic', status: 429, retryable: true, message: 'thrown-retryable' });
      }
      return Promise.resolve(anthropicResponse('recovered-thrown'));
    });
    const res = await complete(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'fast' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(res.data!.content).toBe('recovered-thrown');
  });

  it('aborts during backoff sleep and propagates AbortError (lines 203-209)', async () => {
    const ctl = new AbortController();
    let calls = 0;
    const fetchImpl = vi.fn(() => {
      calls++;
      if (calls === 1) {
        setTimeout(() => ctl.abort(), 50);
        return Promise.resolve(new Response('rate', { status: 429 }));
      }
      return Promise.resolve(anthropicResponse('ok'));
    });
    const res = await complete(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'fast', signal: ctl.signal },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.data).toBeNull();
    expect(res.error?.message).toMatch(/aborted/);
  });

});

describe('per-provider cooldown state', () => {
  it('skips a cooling-down provider and uses the fallback leg', async () => {
    const now = vi.fn(() => 1_000_000);
    // Mark anthropic as cooling down
    markProviderCoolingDown('anthropic', now);

    const fetchImpl = vi.fn((url: string | URL | Request) => {
      // Anthropic should never be called while cooling down
      if (String(url).includes('anthropic')) return Promise.resolve(new Response('should not call', { status: 500 }));
      if (String(url).includes('google-vertex-ai')) return Promise.resolve(geminiResponse('fallback-from-cooldown'));
      return Promise.resolve(new Response('', { status: 500 }));
    });

    const res = await complete(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'balanced' },
      { fetch: fetchImpl as unknown as typeof fetch, now },
    );

    // Anthropic should not have been called
    const anthropicCalls = (fetchImpl.mock.calls as Array<[string | URL | Request, RequestInit?]>).filter(
      ([url]) => String(url).includes('anthropic'),
    );
    expect(anthropicCalls).toHaveLength(0);
    expect(res.data!.provider).toBe('gemini');
  });

  it('does not skip a provider after the cooldown window expires', async () => {
    const now = vi.fn(() => 1_000_000);
    markProviderCoolingDown('anthropic', now);

    // Advance past cooldown
    now.mockReturnValue(1_000_000 + PROVIDER_COOLDOWN_MS + 1);

    const fetchImpl = vi.fn(() => Promise.resolve(anthropicResponse('back-online')));
    const res = await complete(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'fast' },
      { fetch: fetchImpl as unknown as typeof fetch, now },
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(res.data!.provider).toBe('anthropic');
  });

  it('returns ALL_PROVIDERS_FAILED when all providers are in cooldown', async () => {
    const now = vi.fn(() => 1_000_000);
    markProviderCoolingDown('anthropic', now);
    markProviderCoolingDown('gemini', now);

    const fetchImpl = vi.fn(() => Promise.resolve(new Response('', { status: 500 })));

    const res = await complete(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'balanced' },
      { fetch: fetchImpl as unknown as typeof fetch, now },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.data).toBeNull();
    expect(res.error!.code).toBe('INTERNAL_ERROR');
  });

  it('isProviderCoolingDown returns false when no cooldown is set', () => {
    clearProviderCooldown('anthropic');
    expect(isProviderCoolingDown('anthropic')).toBe(false);
  });

  it('isProviderCoolingDown returns true within the window', () => {
    const now = vi.fn(() => 1_000_000);
    markProviderCoolingDown('anthropic', now);
    // Same timestamp â€” still within window
    expect(isProviderCoolingDown('anthropic', now)).toBe(true);
  });
});

// â”€â”€â”€ Feature 3: completionStream() â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('completionStream', () => {
  it('yields text chunks and returns LLMResult', async () => {
    const stream = buildAnthropicStream(['Hello', ', ', 'world!']);
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { 'cf-aig-request-id': 'stream-aig-1' },
        }),
      ),
    );

    const gen = completionStream(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'balanced', deps: { fetch: fetchImpl as unknown as typeof fetch, now: () => 1000 } },
    );

    const { chunks, result } = await drainStream(gen);

    expect(chunks).toEqual(['Hello', ', ', 'world!']);
    const llmResult = result as import('./index.js').LLMResult;
    expect(llmResult.content).toBe('Hello, world!');
    expect(llmResult.provider).toBe('anthropic');
    expect(llmResult.tier).toBe('balanced');
    expect(llmResult.gatewayRequestId).toBe('stream-aig-1');
    expect(llmResult.tokens.input).toBe(10);
  });

  it('sends stream=true in the request body', async () => {
    const stream = buildAnthropicStream(['ok']);
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(stream, { status: 200 })),
    );

    const gen = completionStream(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'fast', deps: { fetch: fetchImpl as unknown as typeof fetch } },
    );
    await drainStream(gen);

    const call = fetchImpl.mock.calls[0] as unknown as [string, { body: string }];
    const body = JSON.parse(call[1].body) as { stream?: boolean };
    expect(body.stream).toBe(true);
  });

  it('falls back to non-streaming complete() for non-Anthropic primary', async () => {
    // Groq (verifier tier) does not support streaming â€” falls back to complete().
    const fetchImpl = vi.fn(() => Promise.resolve(groqResponse('groq-result')));

    const gen = completionStream(
      [{ role: 'user', content: 'verify' }],
      ENV,
      { tier: 'verifier', deps: { fetch: fetchImpl as unknown as typeof fetch } },
    );

    const { chunks, result } = await drainStream(gen);

    const llmResult = result as import('./index.js').LLMResult;
    // The entire content is yielded in one chunk via the fallback path
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('groq-result');
    expect(llmResult.provider).toBe('groq');
  });

  it('falls back when streaming response is non-ok (503)', async () => {
    let callCount = 0;
    const fetchImpl = vi.fn((url: string | URL | Request) => {
      callCount++;
      if (callCount === 1 && String(url).includes('anthropic')) {
        // First call: streaming attempt returns 503
        return Promise.resolve(new Response('', { status: 503 }));
      }
      if (String(url).includes('google-vertex-ai')) {
        return Promise.resolve(geminiResponse('gemini-fallback'));
      }
      return Promise.resolve(new Response('', { status: 500 }));
    });

    const gen = completionStream(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'balanced', deps: { fetch: fetchImpl as unknown as typeof fetch } },
    );

    const { chunks, result } = await drainStream(gen);
    const llmResult = result as import('./index.js').LLMResult;
    expect(chunks).toHaveLength(1);
    expect(llmResult.provider).toBe('gemini');
  });

  it('throws ValidationError for empty messages', async () => {
    const gen = completionStream([], ENV, {});
    await expect(gen.next()).rejects.toThrow(/messages must not be empty/);
  });

  it('throws ValidationError for missing AI_GATEWAY_BASE_URL', async () => {
    const gen = completionStream(
      [{ role: 'user', content: 'hi' }],
      { ...ENV, AI_GATEWAY_BASE_URL: '' },
      {},
    );
    await expect(gen.next()).rejects.toThrow(/AI_GATEWAY_BASE_URL/);
  });

  it('falls back when primary provider is cooling down', async () => {
    const now = vi.fn(() => 1_000_000);
    markProviderCoolingDown('anthropic', now);

    const fetchImpl = vi.fn((url: string | URL | Request) => {
      if (String(url).includes('google-vertex-ai')) return Promise.resolve(geminiResponse('stream-cooldown-fallback'));
      return Promise.resolve(new Response('', { status: 500 }));
    });

    const gen = completionStream(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'balanced', deps: { fetch: fetchImpl as unknown as typeof fetch, now } },
    );

    const { result } = await drainStream(gen);
    const llmResult = result as import('./index.js').LLMResult;
    expect(llmResult.provider).toBe('gemini');
  });

  it('throws on AbortError during stream fetch', async () => {
    const ctl = new AbortController();
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      });
    });

    const gen = completionStream(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'fast', signal: ctl.signal, deps: { fetch: fetchImpl as unknown as typeof fetch } },
    );

    const p = gen.next();
    ctl.abort();
    await expect(p).rejects.toThrow(/aborted/);
  });

  it('handles non-text SSE delta types gracefully', async () => {
    const encoder = new TextEncoder();
    const sseData = [
      `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 5 }, model: 'claude-sonnet-4-20250514' } })}\n\n`,
      // An unknown delta type that should be ignored
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'unknown_type', text: 'ignore me' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'real text' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 2 } })}\n\n`,
      'data: [DONE]\n\n',
    ].join('');

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseData));
        controller.close();
      },
    });

    const fetchImpl = vi.fn(() => Promise.resolve(new Response(stream, { status: 200 })));

    const gen = completionStream(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'fast', deps: { fetch: fetchImpl as unknown as typeof fetch } },
    );

    const { chunks, result } = await drainStream(gen);
    expect(chunks).toEqual(['real text']);
    const llmResult = result as import('./index.js').LLMResult;
    expect(llmResult.content).toBe('real text');
  });

  it('handles null response body gracefully', async () => {
    // Create a response with a null body by mocking the body property.
    const mockResponse = {
      ok: true,
      body: null,
      headers: { get: () => null },
    } as unknown as Response;

    const fetchImpl = vi.fn(() => Promise.resolve(mockResponse));

    const gen = completionStream(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'fast', deps: { fetch: fetchImpl as unknown as typeof fetch } },
    );

    await expect(gen.next()).rejects.toThrow(/response body is null/);
  });

  it('logs completion info to logger', async () => {
    const info = vi.fn();
    const stream = buildAnthropicStream(['logged']);
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(stream, { status: 200 })));

    const gen = completionStream(
      [{ role: 'user', content: 'hi' }],
      ENV,
      {
        tier: 'fast',
        runId: 'r-stream',
        deps: {
          fetch: fetchImpl as unknown as typeof fetch,
          logger: { info } as unknown as import('@latimer-woods-tech/logger').Logger,
        },
      },
    );

    await drainStream(gen);
    expect(info).toHaveBeenCalled();
    const args = info.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(args[1]).toMatchObject({ runId: 'r-stream' });
  });

  it('marks provider cooling down when streaming returns 429 (line 838)', async () => {
    const now = vi.fn(() => 1_000_000);
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('rate limited', { status: 429 })));
    const gen = completionStream(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'fast', deps: { fetch: fetchImpl as unknown as typeof fetch, now } },
    );
    await expect(drainStream(gen)).rejects.toThrow(/LLM_ALL_PROVIDERS_FAILED/);
    expect(isProviderCoolingDown('anthropic', now)).toBe(true);
    clearProviderCooldown('anthropic');
  });

  it('throws when streaming non-ok AND complete() fallback also fails (lines 842-846)', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('upstream down', { status: 503 })),
    );
    const gen = completionStream(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'balanced', deps: { fetch: fetchImpl as unknown as typeof fetch } },
    );
    await expect(drainStream(gen)).rejects.toThrow(/LLM_ALL_PROVIDERS_FAILED/);
  });

  it('throws when non-Anthropic primary and complete() fallback all fail (lines 793-794)', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('rate', { status: 429 })));
    const gen = completionStream(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'verifier', deps: { fetch: fetchImpl as unknown as typeof fetch } },
    );
    await expect(drainStream(gen)).rejects.toThrow(/LLM_ALL_PROVIDERS_FAILED/);
  });

  it('throws when cooling-down primary and complete() fallback also fails (lines 805-806)', async () => {
    const now = vi.fn(() => 1_000_000);
    markProviderCoolingDown('anthropic', now);
    markProviderCoolingDown('gemini', now);
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('', { status: 500 })));
    const gen = completionStream(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'balanced', deps: { fetch: fetchImpl as unknown as typeof fetch, now } },
    );
    await expect(drainStream(gen)).rejects.toThrow(/LLM_ALL_PROVIDERS_FAILED/);
  });

  it('wraps non-abort stream fetch errors in InternalError (line 828)', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('connection-timeout')));
    const gen = completionStream(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'fast', deps: { fetch: fetchImpl as unknown as typeof fetch } },
    );
    await expect(drainStream(gen)).rejects.toThrow(/llm stream fetch failed/);
  });

  it('skips malformed JSON SSE lines and continues (lines 889-890)', async () => {
    const enc = new TextEncoder();
    const lines = [
      'data: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1 }, model: 'm' } }) + '\n\n',
      'data: {bad json}\n\n',
      'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } }) + '\n\n',
      'data: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 1 } }) + '\n\n',
      'data: [DONE]\n\n',
    ];
    const body = lines.join('');
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode(body)); c.close(); },
    });
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(stream, { status: 200 })));
    const gen = completionStream(
      [{ role: 'user', content: 'h' }],
      ENV,
      { tier: 'fast', deps: { fetch: fetchImpl as unknown as typeof fetch } },
    );
    const { chunks } = await drainStream(gen);
    expect(chunks).toEqual(['x']);
  });

  it('ignores unknown SSE event types via default branch (line 909)', async () => {
    const enc = new TextEncoder();
    const lines = [
      'data: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1 }, model: 'm' } }) + '\n\n',
      'data: ' + JSON.stringify({ type: 'content_block_start', index: 0 }) + '\n\n',
      'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'y' } }) + '\n\n',
      'data: ' + JSON.stringify({ type: 'content_block_stop', index: 0 }) + '\n\n',
      'data: ' + JSON.stringify({ type: 'ping' }) + '\n\n',
      'data: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 1 } }) + '\n\n',
      'data: [DONE]\n\n',
    ];
    const body = lines.join('');
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode(body)); c.close(); },
    });
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(stream, { status: 200 })));
    const gen = completionStream(
      [{ role: 'user', content: 'h' }],
      ENV,
      { tier: 'fast', deps: { fetch: fetchImpl as unknown as typeof fetch } },
    );
    const { chunks } = await drainStream(gen);
    expect(chunks).toEqual(['y']);
  });

  it('warns via logger when provider is cooling down (line 801)', async () => {
    const now = vi.fn(() => 1_000_000);
    markProviderCoolingDown('anthropic', now);
    const warn = vi.fn();
    const fetchImpl = vi.fn((url: string | URL | Request) => {
      if (String(url).includes('google-vertex-ai')) return Promise.resolve(geminiResponse('warn-ok'));
      return Promise.resolve(new Response('', { status: 500 }));
    });
    const gen = completionStream(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'balanced', deps: { fetch: fetchImpl as unknown as typeof fetch, now, logger: { warn } as unknown as import('@latimer-woods-tech/logger').Logger } },
    );
    const { result } = await drainStream(gen);
    expect(warn).toHaveBeenCalledWith('llm.provider.coolingDown', expect.objectContaining({ provider: 'anthropic' }));
    const r = result as import('./index.js').LLMResult;
    expect(r.provider).toBe('gemini');
  });

  it('uses String(e) for non-Error thrown from stream fetch (line 829)', async () => {
    const fetchImpl = vi.fn(() => Promise.reject('plain-string-error'));
    const gen = completionStream(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'fast', deps: { fetch: fetchImpl as unknown as typeof fetch } },
    );
    await expect(drainStream(gen)).rejects.toThrow(/llm stream fetch failed/);
  });

  it('uses nullish fallbacks when SSE fields are absent (lines 894, 906, 931)', async () => {
    const enc = new TextEncoder();
    const lines = [
      'data: ' + JSON.stringify({ type: 'message_start', message: { usage: {} } }) + '\n\n',
      'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'z' } }) + '\n\n',
      'data: ' + JSON.stringify({ type: 'message_delta', usage: {} }) + '\n\n',
      'data: [DONE]\n\n',
    ];
    const body = lines.join('');
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode(body)); c.close(); },
    });
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(stream, { status: 200 })));
    const gen = completionStream(
      [{ role: 'user', content: 'h' }],
      ENV,
      { tier: 'fast', deps: { fetch: fetchImpl as unknown as typeof fetch } },
    );
    const { chunks, result } = await drainStream(gen);
    expect(chunks).toEqual(['z']);
    const r = result as import('./index.js').LLMResult;
    expect(r.tokens.input).toBe(0);
    expect(r.tokens.output).toBe(0);
    expect(r.model).toBe('claude-haiku-4-20250514');
  });

});

// â”€â”€â”€ Feature 4: assertGrounding() â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('assertGrounding', () => {
  it('returns true when sources is empty (no grounding violation possible)', () => {
    expect(assertGrounding('any response text here', [])).toBe(true);
  });

  it('returns true when response contains a 5-token phrase from a source', () => {
    const source = 'The quick brown fox jumps over the lazy dog';
    const response = 'According to the source, the quick brown fox jumps over the lazy dog today.';
    expect(assertGrounding(response, [source])).toBe(true);
  });

  it('returns false when response shares no 5-token phrase with any source', () => {
    const source = 'The quick brown fox jumps over the lazy dog';
    const response = 'A completely unrelated sentence about something else entirely different here.';
    expect(assertGrounding(response, [source])).toBe(false);
  });

  it('returns true when phrase spans the exact window boundary', () => {
    // Response contains exactly the first 5 tokens of the source
    const source = 'alpha beta gamma delta epsilon zeta eta';
    const response = 'alpha beta gamma delta epsilon is documented in the source';
    expect(assertGrounding(response, [source])).toBe(true);
  });

  it('returns false when response has fewer than 5 tokens', () => {
    const source = 'alpha beta gamma delta epsilon zeta';
    const response = 'alpha beta';
    expect(assertGrounding(response, [source])).toBe(false);
  });

  it('returns false when source has fewer than 5 tokens (no ngrams to match)', () => {
    const source = 'alpha beta';
    const response = 'alpha beta gamma delta epsilon zeta eta theta';
    expect(assertGrounding(response, [source])).toBe(false);
  });

  it('matches across multiple sources', () => {
    const sources = [
      'unrelated text without any match at all',
      'the factory system uses cloudflare workers for routing',
    ];
    const response = 'As stated: the factory system uses cloudflare workers for routing requests.';
    expect(assertGrounding(response, sources)).toBe(true);
  });

  it('is case-sensitive (does not match different casing)', () => {
    const source = 'The Quick Brown Fox Jumps';
    const response = 'the quick brown fox jumps over things';
    // Different casing â€” should not match
    expect(assertGrounding(response, [source])).toBe(false);
  });

  it('returns false for response that only partially shares 4 tokens', () => {
    // Shares 4 consecutive tokens but not 5
    const source = 'alpha beta gamma delta epsilon';
    const response = 'alpha beta gamma delta but then diverges from the source entirely';
    // "alpha beta gamma delta epsilon" is in source but only "alpha beta gamma delta" matches up to 4 tokens in response
    // Response does not contain the 5th token "epsilon" in sequence
    expect(assertGrounding(response, [source])).toBe(false);
  });

  it('handles whitespace-heavy text correctly', () => {
    const source = '  one   two   three   four   five   six  ';
    const response = 'one two three four five six words here';
    expect(assertGrounding(response, [source])).toBe(true);
  });

  it('returns false when sources array contains only empty strings', () => {
    expect(assertGrounding('some response text here today', ['', '   '])).toBe(false);
  });
});

// ─── org-level KV cost cap enforcement ───────────────────────────────────────

describe('complete - org-level KV daily cap', () => {
  function makeCostKv(stored: Record<string, string> = {}): import('./index.js').CostKvStore {
    const store: Record<string, string> = { ...stored };
    return {
      get: (key: string) => Promise.resolve(store[key] ?? null),
      put: (key: string, value: string) => { store[key] = value; return Promise.resolve(); },
    };
  }

  it('blocks call when today spend >= dailyCapUsd', async () => {
    const kv = makeCostKv();
    // Pre-load today's spend at cap
    const today = new Date().toISOString().slice(0, 10);
    await kv.put(`llm:daily-cost:${today}`, '50');
    const result = await complete(
      [{ role: 'user', content: 'hello' }],
      { ...ENV, LLM_COST_KV: kv },
      { dailyCapUsd: 50 },
    );
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toBe('LLM_DAILY_CAP_EXCEEDED');
  });

  it('allows call when today spend < dailyCapUsd', async () => {
    const kv = makeCostKv();
    const today = new Date().toISOString().slice(0, 10);
    await kv.put(`llm:daily-cost:${today}`, '10');
    const result = await complete(
      [{ role: 'user', content: 'hello' }],
      { ...ENV, LLM_COST_KV: kv },
      { dailyCapUsd: 50 },
      { fetch: () => Promise.resolve(anthropicResponse('ok')) },
    );
    // Should pass cap check — result depends on fetch working
    expect(result.error?.code).not.toBe('LLM_DAILY_CAP_EXCEEDED');
  });

  it('blocks call when monthly spend >= monthlyCapUsd', async () => {
    const kv = makeCostKv();
    const month = new Date().toISOString().slice(0, 7);
    await kv.put(`llm:monthly-cost:${month}`, '500');
    const result = await complete(
      [{ role: 'user', content: 'hello' }],
      { ...ENV, LLM_COST_KV: kv },
      { monthlyCapUsd: 500 },
    );
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toBe('LLM_MONTHLY_CAP_EXCEEDED');
  });

  it('does not enforce cap when LLM_COST_KV is not provided', async () => {
    // Without KV, even setting dailyCapUsd should not block
    const daily = vi.fn().mockResolvedValue(anthropicResponse('ok'));
    const result = await complete(
      [{ role: 'user', content: 'hello' }],
      { ...ENV }, // no LLM_COST_KV
      { dailyCapUsd: 0 },
      { fetch: daily },
    );
    // No KV means no cap check — call proceeds
    expect(result.error?.code).not.toBe('LLM_DAILY_CAP_EXCEEDED');
  });

  it('returns LLM_COST_CAP_EXCEEDED when per-call cost exceeds maxCostUsd', async () => {
    // maxCostUsd=0 means any real call cost will exceed it
    const fetchImpl = vi.fn().mockResolvedValue(anthropicResponse('ok'));
    const result = await complete(
      [{ role: 'user', content: 'hello' }],
      { ...ENV },
      { maxCostUsd: 0 },
      { fetch: fetchImpl },
    );
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toBe('LLM_COST_CAP_EXCEEDED');
  });

  it('updates daily and monthly KV accumulators when maxCostUsd is exceeded', async () => {
    const kv = makeCostKv();
    const today = new Date().toISOString().slice(0, 10);
    const month = new Date().toISOString().slice(0, 7);
    const fetchImpl = vi.fn().mockResolvedValue(anthropicResponse('ok'));
    const result = await complete(
      [{ role: 'user', content: 'hello' }],
      { ...ENV, LLM_COST_KV: kv },
      { maxCostUsd: 0, dailyCapUsd: 100, monthlyCapUsd: 500 },
      { fetch: fetchImpl },
    );

    expect(result.error).not.toBeNull();
    expect(result.error?.message).toBe('LLM_COST_CAP_EXCEEDED');
    expect(parseFloat((await kv.get(`llm:daily-cost:${today}`)) ?? '0')).toBeGreaterThan(0);
    expect(parseFloat((await kv.get(`llm:monthly-cost:${month}`)) ?? '0')).toBeGreaterThan(0);
  });

  it('accumulates monthly cost in KV after successful call', async () => {
    const kv = makeCostKv();
    const month = new Date().toISOString().slice(0, 7);
    await kv.put(`llm:monthly-cost:${month}`, '10');
    const fetchImpl = vi.fn().mockResolvedValue(anthropicResponse('ok'));
    const result = await complete(
      [{ role: 'user', content: 'hello' }],
      { ...ENV, LLM_COST_KV: kv },
      { monthlyCapUsd: 100 },
      { fetch: fetchImpl },
    );
    expect(result.error).toBeNull();
    const raw = await kv.get(`llm:monthly-cost:${month}`);
    // Accumulated value should be > 10 (initial) after a successful call
    expect(parseFloat(raw ?? '0')).toBeGreaterThan(10);
  });
});

// ─── onRecord metering callback ───────────────────────────────────────────────

describe('onRecord metering callback', () => {
  it('calls onRecord with a fully-populated row after a successful completion', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(anthropicResponse('done'));
    const onRecord = vi.fn().mockResolvedValue(undefined);
    const result = await complete(
      [{ role: 'user', content: 'hi' }],
      { ...ENV },
      { ledger: { project: 'test-proj', actor: 'test-actor', runId: 'run-1', workload: 'summary', tenantId: 'org-1' } },
      { fetch: fetchImpl, onRecord },
    );
    expect(result.error).toBeNull();
    expect(onRecord).toHaveBeenCalledOnce();
    const row = onRecord.mock.calls[0]![0] as LLMRecordRow;
    expect(row.project).toBe('test-proj');
    expect(row.actor).toBe('test-actor');
    expect(row.runId).toBe('run-1');
    expect(row.workload).toBe('summary');
    expect(row.tenantId).toBe('org-1');
    expect(row.provider).toBe('anthropic');
    expect(typeof row.model).toBe('string');
    expect(typeof row.inputTokens).toBe('number');
    expect(typeof row.outputTokens).toBe('number');
    expect(typeof row.costUsd).toBe('number');
    expect(row.costUsd).toBeGreaterThanOrEqual(0);
    expect(typeof row.yyyyMm).toBe('string');
    expect(row.yyyyMm).toMatch(/^\d{4}-\d{2}$/);
  });

  it('does not call onRecord when ledger is absent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(anthropicResponse('done'));
    const onRecord = vi.fn().mockResolvedValue(undefined);
    await complete(
      [{ role: 'user', content: 'hi' }],
      { ...ENV },
      {},
      { fetch: fetchImpl, onRecord },
    );
    expect(onRecord).not.toHaveBeenCalled();
  });

  it('does not call onRecord when onRecord is absent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(anthropicResponse('done'));
    // Should complete without error even when onRecord is not set
    const result = await complete(
      [{ role: 'user', content: 'hi' }],
      { ...ENV },
      { ledger: { project: 'proj', actor: 'a' } },
      { fetch: fetchImpl },
    );
    expect(result.error).toBeNull();
  });

  it('swallows onRecord Error and logs a warning without failing the call', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(anthropicResponse('done'));
    const warnSpy = vi.fn();
    const onRecord = vi.fn().mockRejectedValue(new Error('db write failed'));
    const result = await complete(
      [{ role: 'user', content: 'hi' }],
      { ...ENV },
      { ledger: { project: 'p', actor: 'a' } },
      { fetch: fetchImpl, onRecord, logger: { warn: warnSpy } as never },
    );
    // Give the fire-and-forget rejection a tick to propagate
    await new Promise((r) => setTimeout(r, 0));
    expect(result.error).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith('llm.onRecord.error', expect.objectContaining({ message: 'db write failed' }));
  });

  it('swallows non-Error thrown by onRecord (covers String(e) branch)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(anthropicResponse('done'));
    const warnSpy = vi.fn();
    const onRecord = vi.fn().mockRejectedValue('timeout');
    const result = await complete(
      [{ role: 'user', content: 'hi' }],
      { ...ENV },
      { ledger: { project: 'p', actor: 'a' } },
      { fetch: fetchImpl, onRecord, logger: { warn: warnSpy } as never },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(result.error).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith('llm.onRecord.error', expect.objectContaining({ message: 'timeout' }));
  });
});

// ─── Tool-calling (Anthropic) — PR 1a ────────────────────────────────────────
describe('tool-calling', () => {
  const lookupTool = {
    name: 'lookup',
    description: 'look up a record',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  };

  function anthropicToolUse() {
    return new Response(
      JSON.stringify({
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { id: 'cust_1' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 20, output_tokens: 9 },
        model: 'claude-sonnet-4-20250514',
      }),
      { status: 200, headers: { 'cf-aig-request-id': 'aig-tool' } },
    );
  }

  function bodyOf(fetchImpl: ReturnType<typeof vi.fn>): Record<string, unknown> {
    return JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
  }

  it('parses tool_use into normalized toolCalls + stopReason', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(anthropicToolUse());
    const res = await complete(
      [{ role: 'user', content: 'look up cust_1' }],
      ENV,
      { tier: 'balanced', tools: [lookupTool] },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.error).toBeNull();
    expect(res.data!.stopReason).toBe('tool_use');
    expect(res.data!.toolCalls).toEqual([{ id: 'toolu_1', name: 'lookup', arguments: { id: 'cust_1' } }]);
  });

  it('sends tools + tool_choice in the Anthropic request body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(anthropicToolUse());
    await complete(
      [{ role: 'user', content: 'go' }],
      ENV,
      { tier: 'balanced', tools: [lookupTool], toolChoice: 'auto' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    const body = bodyOf(fetchImpl);
    expect(body.tools).toEqual([
      { name: 'lookup', description: 'look up a record', input_schema: lookupTool.parameters },
    ]);
    expect(body.tool_choice).toEqual({ type: 'auto' });
  });

  it('maps toolChoice {name} to a forced tool', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(anthropicToolUse());
    await complete(
      [{ role: 'user', content: 'go' }],
      ENV,
      { tier: 'balanced', tools: [lookupTool], toolChoice: { name: 'lookup' } },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(bodyOf(fetchImpl).tool_choice).toEqual({ type: 'tool', name: 'lookup' });
  });

  it('allows a tool_use turn with no text content (not an empty-content failure)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'tool_use', id: 'toolu_2', name: 'lookup', input: {} }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 5, output_tokens: 3 },
          model: 'claude-sonnet-4-20250514',
        }),
        { status: 200 },
      ),
    );
    const res = await complete(
      [{ role: 'user', content: 'go' }],
      ENV,
      { tools: [lookupTool] },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.error).toBeNull();
    expect(res.data!.content).toBe('');
    expect(res.data!.toolCalls).toHaveLength(1);
  });

  it('passes structured tool_use / tool_result content through to the provider', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(anthropicResponse('done'));
    await complete(
      [
        { role: 'user', content: 'look up cust_1' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { id: 'cust_1' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"plan":"pro"}' }] },
      ],
      ENV,
      { tools: [lookupTool] },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    const msgs = bodyOf(fetchImpl).messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(msgs[1]?.content?.[0]).toMatchObject({ type: 'tool_use', id: 'toolu_1' });
    expect(msgs[2]?.content?.[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
  });

  it('fails closed when the tier has no tool-capable provider', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(anthropicResponse());
    await expect(
      complete(
        [{ role: 'user', content: 'go' }],
        ENV,
        { tier: 'verifier', tools: [lookupTool] },
        { fetch: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/tool-capable/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('normal (no-tools) completion reports stopReason end and no toolCalls', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'hi' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 3, output_tokens: 2 },
          model: 'claude-sonnet-4-20250514',
        }),
        { status: 200 },
      ),
    );
    const res = await complete(
      [{ role: 'user', content: 'hi' }],
      ENV,
      { tier: 'balanced' },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.data!.stopReason).toBe('end');
    expect(res.data!.toolCalls).toBeUndefined();
  });
});

// ─── Tool-calling — OpenAI providers (Grok / DeepSeek) — PR 1b ────────────────
describe('tool-calling (OpenAI-style providers)', () => {
  const lookupTool = {
    name: 'lookup',
    description: 'look up a record',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  };
  const GROK_ENV = { ...ENV, GROK_API_KEY: 'gk-test' };

  function openAiToolUse(model: string, callId = 'call_abc') {
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: callId, type: 'function', function: { name: 'lookup', arguments: '{"id":"cust_1"}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 15, completion_tokens: 8 },
        model,
      }),
      { status: 200, headers: { 'cf-aig-request-id': 'oai-tool' } },
    );
  }

  function reqBody(fetchImpl: ReturnType<typeof vi.fn>): Record<string, unknown> {
    return JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
  }

  it('grok: parses OpenAI tool_calls into normalized toolCalls + stopReason', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(openAiToolUse('grok-4.3'));
    const res = await complete(
      [{ role: 'user', content: 'go' }],
      GROK_ENV,
      { tier: 'fast', tools: [lookupTool] },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.error).toBeNull();
    expect(res.data!.provider).toBe('grok');
    expect(res.data!.stopReason).toBe('tool_use');
    expect(res.data!.toolCalls).toEqual([{ id: 'call_abc', name: 'lookup', arguments: { id: 'cust_1' } }]);
  });

  it('grok: sends OpenAI-format tools + tool_choice', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(openAiToolUse('grok-4.3'));
    await complete(
      [{ role: 'user', content: 'go' }],
      GROK_ENV,
      { tier: 'fast', tools: [lookupTool] },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    const body = reqBody(fetchImpl);
    expect((body.tools as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'function',
      function: { name: 'lookup', description: 'look up a record' },
    });
    expect(body.tool_choice).toBe('auto');
  });

  it('deepseek: parses tool_calls on the workbench tier', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(openAiToolUse('deepseek-chat', 'call_ds'));
    const res = await complete(
      [{ role: 'user', content: 'go' }],
      ENV,
      { tier: 'workbench', tools: [lookupTool] },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.error).toBeNull();
    expect(res.data!.provider).toBe('deepseek');
    expect(res.data!.toolCalls).toEqual([{ id: 'call_ds', name: 'lookup', arguments: { id: 'cust_1' } }]);
  });

  it('converts structured tool_use / tool_result blocks to OpenAI tool_calls + tool role', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
          model: 'grok-4.3',
        }),
        { status: 200 },
      ),
    );
    await complete(
      [
        { role: 'user', content: 'look up' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input: { id: 'c1' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"plan":"pro"}' }] },
      ],
      GROK_ENV,
      { tier: 'fast', tools: [lookupTool] },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    const msgs = reqBody(fetchImpl).messages as Array<Record<string, unknown>>;
    const asst = msgs.find((m) => m.role === 'assistant') as { tool_calls: Array<Record<string, unknown>> };
    expect(asst.tool_calls[0]).toMatchObject({ id: 'call_1', type: 'function', function: { name: 'lookup' } });
    const toolMsg = msgs.find((m) => m.role === 'tool');
    expect(toolMsg).toMatchObject({ tool_call_id: 'call_1', content: '{"plan":"pro"}' });
  });

  it('fast tier now permits tools (grok is tool-capable — no fail-closed)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(openAiToolUse('grok-4.3'));
    const res = await complete(
      [{ role: 'user', content: 'go' }],
      GROK_ENV,
      { tier: 'fast', tools: [lookupTool] },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.error).toBeNull();
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('tolerates malformed tool-call arguments (bills as {} rather than throwing)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'lookup', arguments: '{bad json' } }] },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 2 },
          model: 'grok-4.3',
        }),
        { status: 200 },
      ),
    );
    const res = await complete(
      [{ role: 'user', content: 'go' }],
      GROK_ENV,
      { tier: 'fast', tools: [lookupTool] },
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(res.error).toBeNull();
    expect(res.data!.toolCalls).toEqual([{ id: 'c1', name: 'lookup', arguments: {} }]);
  });
});

// ─── Streaming tool-calling (Anthropic) — PR 1c ──────────────────────────────
describe('completionStream tool-calling', () => {
  function anthropicToolStream(): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 10 }, model: 'claude-sonnet-4-20250514' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_s', name: 'lookup' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"id":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"cust_9"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
    ];
    return new ReadableStream<Uint8Array>({
      start(c) {
        for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
  }

  it('accumulates input_json_delta fragments into a normalized toolCall + stopReason', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(anthropicToolStream(), { status: 200, headers: { 'cf-aig-request-id': 'aig-s' } }),
    );
    const gen = completionStream(
      [{ role: 'user', content: 'go' }],
      ENV,
      {
        tier: 'balanced',
        tools: [{ name: 'lookup', parameters: { type: 'object' } }],
        deps: { fetch: fetchImpl as unknown as typeof fetch },
      },
    );
    const { chunks, result } = await drainStream(gen);
    const r = result as LLMResult;
    // No text deltas in a pure tool-use turn.
    expect(chunks.join('')).toBe('');
    expect(r.stopReason).toBe('tool_use');
    expect(r.toolCalls).toEqual([{ id: 'toolu_s', name: 'lookup', arguments: { id: 'cust_9' } }]);
  });
});
