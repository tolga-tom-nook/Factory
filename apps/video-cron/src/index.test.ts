import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from './index.js';
import type { Env } from './env.js';

const env: Env = {
  DB: { connectionString: 'postgres://example' } as Env['DB'],
  WORKER_API_TOKEN: 'internal-token',
  GITHUB_TOKEN: 'github-token',
  GITHUB_REPO: 'Latimer-Woods-Tech/factory',
  SCHEDULE_WORKER_URL: 'https://schedule-worker.adrper79.workers.dev',
  APP_ID: 'selfprime',
  DEFAULT_COMPOSITION_ID: 'MarketingVideo',
  ENVIRONMENT: 'test',
};

const sampleJob = {
  id: 'job-001',
  appId: 'selfprime',
  type: 'marketing',
  briefKey: undefined,
  compositionId: undefined,
  topic: 'SelfPrime walkthrough',
  script: '',
  status: 'pending',
  createdAt: '2026-04-28T00:00:00.000Z',
  updatedAt: '2026-04-28T00:00:00.000Z',
} as const;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('video-cron', () => {
  it('GET /health returns the health envelope', async () => {
    const res = await worker.fetch(new Request('https://video-cron.example/health'), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: 'ok',
      worker: 'video-cron',
      environment: 'test',
    });
  });

  it('rejects manual trigger without bearer token', async () => {
    const res = await worker.fetch(
      new Request('https://video-cron.example/trigger', { method: 'POST' }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });

  it('fetches app-scoped pending jobs and dispatches the render workflow', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ data: [sampleJob] }))
      .mockResolvedValueOnce(Response.json({ data: { ...sampleJob, status: 'rendering' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const res = await worker.fetch(
      new Request('https://video-cron.example/trigger', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.WORKER_API_TOKEN}` },
      }),
      env,
      {} as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ data: { dispatched: 1, failed: 0 } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://schedule-worker.adrper79.workers.dev/jobs/pending?limit=10&appId=selfprime');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://api.github.com/repos/Latimer-Woods-Tech/factory/actions/workflows/render-video.yml/dispatches');
  });

  it('passes Media Room brief metadata into the render workflow', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({
        data: [{
          ...sampleJob,
          type: 'training',
          briefKey: 'daily-transits-guide',
          compositionId: 'TrainingVideo',
          topic: 'Using Daily Transits Without Overcomplicating Your Day',
        }],
      }))
      .mockResolvedValueOnce(Response.json({ data: { ...sampleJob, status: 'rendering' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const res = await worker.fetch(
      new Request('https://video-cron.example/trigger', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.WORKER_API_TOKEN}` },
      }),
      env,
      {} as ExecutionContext,
    );

    expect(res.status).toBe(200);
    const dispatchInit = fetchMock.mock.calls[2]?.[1];
    const body = JSON.parse(String(dispatchInit?.body));
    expect(body.inputs).toMatchObject({
      job_id: 'job-001',
      composition_id: 'TrainingVideo',
      app_id: 'selfprime',
      topic: 'Using Daily Transits Without Overcomplicating Your Day',
      brief_key: 'daily-transits-guide',
    });
  });

  it('marks jobs failed when GitHub dispatch fails', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ data: [sampleJob] }))
      .mockResolvedValueOnce(Response.json({ data: { ...sampleJob, status: 'rendering' } }))
      .mockResolvedValueOnce(Response.json({ message: 'bad credentials' }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ data: { ...sampleJob, status: 'failed' } }));

    const res = await worker.fetch(
      new Request('https://video-cron.example/trigger', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.WORKER_API_TOKEN}` },
      }),
      env,
      {} as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ data: { dispatched: 0, failed: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3]?.[0]).toBe('https://schedule-worker.adrper79.workers.dev/jobs/job-001');
  });
});
