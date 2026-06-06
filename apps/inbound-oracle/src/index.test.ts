import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const completeMock = vi.hoisted(() => vi.fn());

vi.mock('@latimer-woods-tech/llm', () => ({
  complete: completeMock,
}));

vi.mock('@latimer-woods-tech/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  generateRequestId: () => 'req-test',
}));

import app, { type Env } from './index.js';

function makeBucket(overrides: Partial<R2Bucket> = {}): R2Bucket {
  return {
    get: vi.fn(() => Promise.resolve(null)),
    put: vi.fn(() => Promise.resolve()),
    delete: vi.fn(),
    head: vi.fn(),
    list: vi.fn(),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
    ...overrides,
  } as unknown as R2Bucket;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    AUDIO_BUCKET: makeBucket(),
    ENVIRONMENT: 'test',
    TELNYX_FROM_NUMBER: '+15045204977',
    ELEVENLABS_VOICE_ID: 'voice-test',
    AUDIO_PUBLIC_BASE_URL: 'https://inbound-oracle.test',
    TELNYX_API_KEY: 'telnyx-test-key',
    ELEVENLABS_API_KEY: 'eleven-test-key',
    AI_GATEWAY_BASE_URL: 'https://gateway.ai.cloudflare.com/v1/test/test',
    ANTHROPIC_API_KEY: 'anthropic-test-key',
    GROQ_API_KEY: 'groq-test-key',
    VERTEX_ACCESS_TOKEN: 'vertex-test-token',
    VERTEX_PROJECT: 'factory-495015',
    VERTEX_LOCATION: 'us-central1',
    ...overrides,
  } as unknown as Env;
}

function inboundBody(text = 'Date: June 5 1985. Time: 8:30 AM. City: Brooklyn, NY.') {
  return {
    data: {
      event_type: 'message.received',
      payload: {
        id: 'msg-test',
        direction: 'inbound',
        from: { phone_number: '+17062677235' },
        to: [{ phone_number: '+15045204977' }],
        text,
      },
    },
  };
}

async function postWebhook(body: unknown, env = makeEnv()): Promise<Response> {
  return app.request('/webhook/telnyx', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }, env);
}

async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  completeMock.mockReset();
  completeMock.mockResolvedValue({ data: { content: 'You are likely a Generator with a theme of sustainable devotion. Your full chart reveals where burnout starts before your mind explains it. Unlock the exact mechanics inside your chart to move with less resistance.' } });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('inbound-oracle health', () => {
  it('returns the health envelope', async () => {
    const res = await app.request('/health', {}, makeEnv());
    expect(res.status).toBe(200);
    await expect(jsonOf(res)).resolves.toEqual({ ok: true, service: 'inbound-oracle', env: 'test' });
  });
});

describe('Telnyx webhook validation', () => {
  it('rejects malformed JSON', async () => {
    const res = await postWebhook('{bad-json');
    expect(res.status).toBe(400);
    await expect(jsonOf(res)).resolves.toEqual({ ok: false, error: 'invalid_json' });
  });

  it('acknowledges non-message events without side effects', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await postWebhook({ data: { event_type: 'message.finalized', payload: {} } });

    expect(res.status).toBe(200);
    await expect(jsonOf(res)).resolves.toEqual({ ok: true, ignored: true, eventType: 'message.finalized' });
    expect(completeMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects inbound messages without sender number', async () => {
    const res = await postWebhook({ data: { event_type: 'message.received', payload: { text: 'hello' } } });

    expect(res.status).toBe(400);
    await expect(jsonOf(res)).resolves.toEqual({ ok: false, error: 'missing_from_number' });
    expect(completeMock).not.toHaveBeenCalled();
  });
});

describe('SMS to MMS reading pipeline', () => {
  it('generates a reading, stores audio, and sends a Telnyx MMS reply', async () => {
    const put = vi.fn(() => Promise.resolve());
    const env = makeEnv({ AUDIO_BUCKET: makeBucket({ put }) });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
      .mockResolvedValueOnce(Response.json({ data: { id: 'telnyx-msg' } }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await postWebhook(inboundBody(), env);

    expect(res.status).toBe(200);
    await expect(jsonOf(res)).resolves.toEqual({ ok: true });
    expect(completeMock).toHaveBeenCalledWith(
      expect.any(Array),
      env,
      expect.objectContaining({ project: 'inbound-oracle', runId: 'req-test', maxCostUsd: 0.05 }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(1, expect.stringContaining('https://api.elevenlabs.io/v1/text-to-speech/voice-test'), expect.objectContaining({ method: 'POST' }));
    expect(put).toHaveBeenCalledWith(expect.stringMatching(/^readings/.+.mp3$/), expect.any(ArrayBuffer), expect.objectContaining({ httpMetadata: { contentType: 'audio/mpeg' } }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://api.telnyx.com/v2/messages', expect.objectContaining({ method: 'POST' }));
    const telnyxBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(telnyxBody).toMatchObject({ from: '+15045204977', to: '+17062677235' });
    expect(telnyxBody.media_urls[0]).toContain('https://inbound-oracle.test/audio/readings/');
    expect(telnyxBody.text).toContain('https://selfprime.net/checkout');
  });

  it('does not call ElevenLabs or Telnyx when LLM generation fails', async () => {
    completeMock.mockResolvedValueOnce({ error: { message: 'llm unavailable' } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await postWebhook(inboundBody());

    expect(res.status).toBe(500);
    const body = await jsonOf<{ ok: boolean; error: string }>(res);
    expect(body.ok).toBe(false);
    expect(body.error).toContain('LLM completion failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not send Telnyx MMS when ElevenLabs synthesis fails', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('quota exceeded', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await postWebhook(inboundBody());

    expect(res.status).toBe(500);
    const body = await jsonOf<{ error: string }>(res);
    expect(body.error).toContain('ElevenLabs TTS error (429)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not send Telnyx MMS when R2 storage fails', async () => {
    const env = makeEnv({ AUDIO_BUCKET: makeBucket({ put: vi.fn(() => Promise.reject(new Error('r2 down'))) }) });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await postWebhook(inboundBody(), env);

    expect(res.status).toBe(500);
    const body = await jsonOf<{ error: string }>(res);
    expect(body.error).toBe('r2 down');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces Telnyx send failures without leaking API keys', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
      .mockResolvedValueOnce(new Response('40010 unregistered traffic', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await postWebhook(inboundBody());

    expect(res.status).toBe(500);
    const body = await jsonOf<{ error: string }>(res);
    expect(body.error).toContain('Telnyx MMS error (400)');
    expect(body.error).not.toContain('telnyx-test-key');
    expect(body.error).not.toContain('eleven-test-key');
  });
});
