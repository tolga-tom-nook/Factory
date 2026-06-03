import { describe, it, expect, vi, beforeEach } from 'vitest';
import { app } from './index.js';
import type { Env } from './env.js';

const mocks = vi.hoisted(() => ({
  db: { execute: vi.fn() },
  getPendingJobs: vi.fn(),
  getVideoJob: vi.fn(),
  scheduleVideo: vi.fn(),
  updateJobStatus: vi.fn(),
}));

vi.mock('@latimer-woods-tech/neon', () => ({
  createDb: vi.fn(() => mocks.db),
  sql: { raw: vi.fn((statement: string) => ({ statement })) },
}));

vi.mock('@latimer-woods-tech/schedule', () => ({
  VIDEO_CALENDAR_DDL: 'CREATE TABLE IF NOT EXISTS video_calendar (id text);',
  VIDEO_CALENDAR_MIGRATION_STATEMENTS: [
    'CREATE TABLE IF NOT EXISTS video_calendar (id text);',
    'CREATE INDEX IF NOT EXISTS video_calendar_status_idx ON video_calendar (status);',
  ],
  getPendingJobs: mocks.getPendingJobs,
  getVideoJob: mocks.getVideoJob,
  scheduleVideo: mocks.scheduleVideo,
  updateJobStatus: mocks.updateJobStatus,
}));

const env: Env = {
  DB: { connectionString: 'postgres://example' } as Env['DB'],
  WORKER_API_TOKEN: 'internal-token',
  APP_SERVICE_TOKENS: JSON.stringify({ 'selfprime-token': 'selfprime' }),
  ENVIRONMENT: 'test',
  SELFPRIME_DB_URL: 'postgres://test@host/selfprime',
  PRIME_SELF_API_SECRET: 'test-secret',
};

const sampleJob = {
  id: 'job-001',
  appId: 'selfprime',
  type: 'marketing',
  briefKey: null,
  compositionId: null,
  topic: 'SelfPrime walkthrough',
  script: null,
  narrationUrl: null,
  videoUrl: null,
  streamUid: null,
  scheduledAt: new Date('2026-04-28T00:00:00.000Z'),
  status: 'pending',
  performanceScore: 50,
  triggerSource: 'manual',
  idempotencyKey: 'selfprime:walkthrough:001',
  error: null,
  createdAt: new Date('2026-04-28T00:00:00.000Z'),
  updatedAt: new Date('2026-04-28T00:00:00.000Z'),
} as const;

function auth(token = env.WORKER_API_TOKEN): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPendingJobs.mockResolvedValue([sampleJob]);
  mocks.getVideoJob.mockResolvedValue(sampleJob);
  mocks.scheduleVideo.mockResolvedValue(sampleJob);
  mocks.updateJobStatus.mockResolvedValue({ ...sampleJob, status: 'rendering' });
  mocks.db.execute.mockResolvedValue({ rows: [] });
});

describe('schedule-worker', () => {
  it('GET /health returns the health envelope', async () => {
    const res = await app.request('/health', {}, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: 'ok', worker: 'schedule-worker' });
  });

  it('GET /stripe/health returns webhook ingress health', async () => {
    const res = await app.request('/stripe/health', {}, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: 'ok',
      service: 'stripe-ingress',
      worker: 'schedule-worker',
    });
  });

  it('rejects unauthenticated pending-job requests', async () => {
    const res = await app.request('/jobs/pending', {}, env);
    expect(res.status).toBe(401);
  });

  it('filters pending jobs by app scope for app-scoped tokens', async () => {
    const res = await app.request('/jobs/pending?limit=5', { headers: auth('selfprime-token') }, env);
    expect(res.status).toBe(200);
    expect(mocks.getPendingJobs).toHaveBeenCalledWith(mocks.db, 5, 'selfprime');
  });

  it('creates jobs with idempotency keys', async () => {
    const res = await app.request('/jobs', {
      method: 'POST',
      headers: { ...auth('selfprime-token'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: 'selfprime',
        type: 'marketing',
        topic: 'SelfPrime walkthrough',
        triggerSource: 'manual',
        idempotencyKey: 'selfprime:walkthrough:001',
      }),
    }, env);

    expect(res.status).toBe(201);
    expect(mocks.scheduleVideo).toHaveBeenCalledWith(mocks.db, expect.objectContaining({
      appId: 'selfprime',
      idempotencyKey: 'selfprime:walkthrough:001',
    }));
  });

  it('creates jobs from training-library briefs with Media Room metadata', async () => {
    const res = await app.request('/jobs/from-brief', {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: 'prime_self',
        briefKey: 'daily-transits-guide',
        triggerSource: 'manual',
        idempotencyKey: 'prime_self:daily-transits-guide',
      }),
    }, env);

    expect(res.status).toBe(201);
    expect(mocks.scheduleVideo).toHaveBeenCalledWith(mocks.db, expect.objectContaining({
      appId: 'prime_self',
      type: 'training',
      briefKey: 'daily-transits-guide',
      compositionId: 'TrainingVideo',
      topic: 'Using Daily Transits Without Overcomplicating Your Day',
      idempotencyKey: 'prime_self:daily-transits-guide',
    }));
  });

  it('creates landing-page jobs from the Prime Self Media Room catalog', async () => {
    const res = await app.request('/jobs/from-brief', {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: 'prime_self',
        briefKey: 'homepage-welcome',
        triggerSource: 'manual',
        idempotencyKey: 'prime_self:homepage-welcome',
      }),
    }, env);

    expect(res.status).toBe(201);
    expect(mocks.scheduleVideo).toHaveBeenCalledWith(mocks.db, expect.objectContaining({
      appId: 'prime_self',
      type: 'marketing',
      briefKey: 'homepage-welcome',
      compositionId: 'MarketingVideo',
      topic: 'See Your Pattern Clearly',
      idempotencyKey: 'prime_self:homepage-welcome',
    }));
  });

  it('blocks app-scoped tokens from creating jobs for another app', async () => {
    const res = await app.request('/jobs', {
      method: 'POST',
      headers: { ...auth('selfprime-token'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: 'videoking',
        type: 'marketing',
        topic: 'Wrong app',
        triggerSource: 'manual',
      }),
    }, env);

    expect(res.status).toBe(401);
    expect(mocks.scheduleVideo).not.toHaveBeenCalled();
  });

  it('updates job status within app scope', async () => {
    const res = await app.request('/jobs/job-001', {
      method: 'PATCH',
      headers: { ...auth('selfprime-token'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'rendering' }),
    }, env);

    expect(res.status).toBe(200);
    expect(mocks.updateJobStatus).toHaveBeenCalledWith(
      mocks.db,
      'job-001',
      'rendering',
      expect.any(Object),
      'selfprime',
    );
  });

  it('allows only the internal token to run migrations', async () => {
    const denied = await app.request('/migrate', { method: 'POST', headers: auth('selfprime-token') }, env);
    expect(denied.status).toBe(401);

    const allowed = await app.request('/migrate', { method: 'POST', headers: auth() }, env);
    expect(allowed.status).toBe(200);
    expect(mocks.db.execute).toHaveBeenCalledTimes(2);
  });
});
