import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  scheduleVideo,
  getVideoJob,
  getPendingJobs,
  updateJobStatus,
  scorePriority,
  setPerformanceScore,
  toRenderJob,
  VIDEO_CALENDAR_DDL,
  VIDEO_CALENDAR_MIGRATION_STATEMENTS,
} from './index.js';
import type { VideoCalendarRow, ProductionBrief } from './index.js';
import { ValidationError, InternalError, NotFoundError } from '@latimer-woods-tech/errors';

// ---------------------------------------------------------------------------
// Mock @latimer-woods-tech/neon
// ---------------------------------------------------------------------------

vi.mock('@latimer-woods-tech/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const NOW_ISO = '2024-06-01T12:00:00.000Z';

function makeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'row-uuid-001',
    app_id: 'prime_self',
    type: 'marketing',
    brief_key: null,
    composition_id: null,
    topic: 'Q4 launch',
    script: 'Raise your standard.',
    narration_url: null,
    video_url: null,
    stream_uid: null,
    scheduled_at: NOW_ISO,
    status: 'pending',
    performance_score: 50,
    trigger_source: 'cron',
    error: null,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    ...overrides,
  };
}

function makeDb(rows: Record<string, unknown>[][] = [[]]) {
  let callIndex = 0;
  return {
    execute: vi.fn((query: unknown) => {
      void query;
      const result = rows[callIndex % rows.length] ?? [];
      callIndex++;
      return Promise.resolve({ rows: result });
    }),
  };
}

type SqlMockCall = { strings: TemplateStringsArray; values: unknown[] };

function flattenSqlValues(values: unknown[]): unknown[] {
  return values.flatMap((value) => {
    if (value && typeof value === 'object' && 'values' in value && Array.isArray((value as { values: unknown[] }).values)) {
      return flattenSqlValues((value as { values: unknown[] }).values);
    }
    return [value];
  });
}

function firstSqlCall(db: ReturnType<typeof makeDb>): SqlMockCall {
  const call = db.execute.mock.calls[0]?.[0];
  if (!call) throw new Error('Expected db.execute to be called');
  const sqlCall = call as SqlMockCall;
  return { ...sqlCall, values: flattenSqlValues(sqlCall.values) };
}

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// VIDEO_CALENDAR_DDL
// ---------------------------------------------------------------------------

describe('VIDEO_CALENDAR_DDL', () => {
  it('is a non-empty string containing CREATE TABLE', () => {
    expect(typeof VIDEO_CALENDAR_DDL).toBe('string');
    expect(VIDEO_CALENDAR_DDL).toContain('CREATE TABLE IF NOT EXISTS video_calendar');
    expect(VIDEO_CALENDAR_MIGRATION_STATEMENTS.length).toBeGreaterThan(1);
  });

  it('includes all required columns', () => {
    expect(VIDEO_CALENDAR_DDL).toContain('app_id');
    expect(VIDEO_CALENDAR_DDL).toContain('trigger_source');
    expect(VIDEO_CALENDAR_DDL).toContain('performance_score');
    expect(VIDEO_CALENDAR_DDL).toContain('stream_uid');
    expect(VIDEO_CALENDAR_DDL).toContain('idempotency_key');
    expect(VIDEO_CALENDAR_DDL).toContain('brief_key');
    expect(VIDEO_CALENDAR_DDL).toContain('composition_id');
    expect(VIDEO_CALENDAR_DDL).toContain('video_calendar_app_idempotency_idx');
  });
});

// ---------------------------------------------------------------------------
// scheduleVideo
// ---------------------------------------------------------------------------

describe('scheduleVideo', () => {
  const brief: ProductionBrief = {
    appId: 'prime_self',
    type: 'marketing',
    topic: 'Q4 launch',
    triggerSource: 'cron',
  };

  it('inserts a row and returns a typed VideoCalendarRow', async () => {
    const db = makeDb([[makeRow()]]);
    const row = await scheduleVideo(db as unknown as Parameters<typeof scheduleVideo>[0], brief);

    expect(row.id).toBe('row-uuid-001');
    expect(row.appId).toBe('prime_self');
    expect(row.status).toBe('pending');
    expect(db.execute).toHaveBeenCalledOnce();
  });

  it('throws ValidationError when appId is blank', async () => {
    const db = makeDb();
    await expect(
      scheduleVideo(db as unknown as Parameters<typeof scheduleVideo>[0], { ...brief, appId: '  ' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError when topic is blank', async () => {
    const db = makeDb();
    await expect(
      scheduleVideo(db as unknown as Parameters<typeof scheduleVideo>[0], { ...brief, topic: '' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws InternalError when INSERT returns no row', async () => {
    const db = makeDb([[]]);
    await expect(
      scheduleVideo(db as unknown as Parameters<typeof scheduleVideo>[0], brief),
    ).rejects.toBeInstanceOf(InternalError);
  });

  it('uses provided scheduledAt date', async () => {
    const scheduledAt = new Date('2024-12-31T00:00:00Z');
    const db = makeDb([[makeRow({ scheduled_at: scheduledAt.toISOString() })]]);
    const row = await scheduleVideo(db as unknown as Parameters<typeof scheduleVideo>[0], {
      ...brief,
      scheduledAt,
    });
    expect(row.scheduledAt).toEqual(scheduledAt);
  });

  it('accepts an idempotency key for retry-safe creation', async () => {
    const db = makeDb([[makeRow({ idempotency_key: 'selfprime:video:001' })]]);
    const row = await scheduleVideo(db as unknown as Parameters<typeof scheduleVideo>[0], {
      ...brief,
      idempotencyKey: 'selfprime:video:001',
    });

    expect(row.idempotencyKey).toBe('selfprime:video:001');
    const firstCall = firstSqlCall(db);
    expect(firstCall.values).toContain('selfprime:video:001');
  });

  it('stores Media Room brief metadata when provided', async () => {
    const db = makeDb([[makeRow({ brief_key: 'daily-transits-guide', composition_id: 'TrainingVideo' })]]);
    const row = await scheduleVideo(db as unknown as Parameters<typeof scheduleVideo>[0], {
      ...brief,
      type: 'training',
      briefKey: 'daily-transits-guide',
      compositionId: 'TrainingVideo',
    });

    expect(row.briefKey).toBe('daily-transits-guide');
    expect(row.compositionId).toBe('TrainingVideo');
    const firstCall = firstSqlCall(db);
    expect(firstCall.values).toContain('daily-transits-guide');
    expect(firstCall.values).toContain('TrainingVideo');
  });

  it('throws ValidationError when idempotencyKey is blank', async () => {
    const db = makeDb();
    await expect(
      scheduleVideo(db as unknown as Parameters<typeof scheduleVideo>[0], { ...brief, idempotencyKey: '  ' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// getVideoJob
// ---------------------------------------------------------------------------

describe('getVideoJob', () => {
  it('returns a typed row when found', async () => {
    const db = makeDb([[makeRow()]]);
    const row = await getVideoJob(db as unknown as Parameters<typeof getVideoJob>[0], 'row-uuid-001');
    expect(row.id).toBe('row-uuid-001');
    expect(row.type).toBe('marketing');
  });

  it('accepts an optional app scope', async () => {
    const db = makeDb([[makeRow()]]);
    await getVideoJob(db as unknown as Parameters<typeof getVideoJob>[0], 'row-uuid-001', 'prime_self');
    const firstCall = firstSqlCall(db);
    expect(firstCall.values).toContain('prime_self');
  });

  it('throws NotFoundError when no row exists', async () => {
    const db = makeDb([[]]);
    await expect(
      getVideoJob(db as unknown as Parameters<typeof getVideoJob>[0], 'missing-id'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// getPendingJobs
// ---------------------------------------------------------------------------

describe('getPendingJobs', () => {
  it('returns all pending rows', async () => {
    const db = makeDb([[makeRow(), makeRow({ id: 'row-uuid-002' })]]);
    const rows = await getPendingJobs(db as unknown as Parameters<typeof getPendingJobs>[0]);
    expect(rows).toHaveLength(2);
  });

  it('returns empty array when no pending jobs', async () => {
    const db = makeDb([[]]);
    const rows = await getPendingJobs(db as unknown as Parameters<typeof getPendingJobs>[0]);
    expect(rows).toHaveLength(0);
  });

  it('accepts an optional app scope', async () => {
    const db = makeDb([[makeRow()]]);
    await getPendingJobs(db as unknown as Parameters<typeof getPendingJobs>[0], 10, 'selfprime');
    const firstCall = firstSqlCall(db);
    expect(firstCall.values).toContain('selfprime');
  });

  it('throws ValidationError when limit is zero', async () => {
    const db = makeDb();
    await expect(
      getPendingJobs(db as unknown as Parameters<typeof getPendingJobs>[0], 0),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError when limit exceeds 100', async () => {
    const db = makeDb();
    await expect(
      getPendingJobs(db as unknown as Parameters<typeof getPendingJobs>[0], 101),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// updateJobStatus
// ---------------------------------------------------------------------------

describe('updateJobStatus', () => {
  it('returns updated row on success', async () => {
    const updated = makeRow({ status: 'done', stream_uid: 'uid-abc' });
    const db = makeDb([[updated]]);
    const row = await updateJobStatus(
      db as unknown as Parameters<typeof updateJobStatus>[0],
      'row-uuid-001',
      'done',
      { streamUid: 'uid-abc' },
    );
    expect(row.status).toBe('done');
    expect(row.streamUid).toBe('uid-abc');
  });

  it('accepts an optional app scope', async () => {
    const updated = makeRow({ status: 'rendering' });
    const db = makeDb([[updated]]);
    await updateJobStatus(
      db as unknown as Parameters<typeof updateJobStatus>[0],
      'row-uuid-001',
      'rendering',
      {},
      'selfprime',
    );
    const firstCall = firstSqlCall(db);
    expect(firstCall.values).toContain('selfprime');
  });

  it('throws NotFoundError when UPDATE matches no row', async () => {
    const db = makeDb([[]]);
    await expect(
      updateJobStatus(db as unknown as Parameters<typeof updateJobStatus>[0], 'gone', 'failed'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// scorePriority
// ---------------------------------------------------------------------------

describe('scorePriority', () => {
  it('returns a number between 0 and 100', () => {
    const score = scorePriority({
      completionRate: 60,
      ctaClickRate: 20,
      uniqueViewers: 2000,
      ageInDays: 30,
    });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('produces a higher score for lower engagement', () => {
    const low = scorePriority({ completionRate: 10, ctaClickRate: 5, uniqueViewers: 1000, ageInDays: 60 });
    const high = scorePriority({ completionRate: 90, ctaClickRate: 80, uniqueViewers: 100, ageInDays: 1 });
    expect(low).toBeGreaterThan(high);
  });

  it('caps score at 100 for extreme inputs', () => {
    const score = scorePriority({
      completionRate: 0,
      ctaClickRate: 0,
      uniqueViewers: 1_000_000,
      ageInDays: 365,
    });
    expect(score).toBe(100);
  });

  it('returns 0 for perfect engagement and brand new video', () => {
    const score = scorePriority({
      completionRate: 100,
      ctaClickRate: 100,
      uniqueViewers: 0,
      ageInDays: 0,
    });
    expect(score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// setPerformanceScore
// ---------------------------------------------------------------------------

describe('setPerformanceScore', () => {
  it('resolves when update succeeds', async () => {
    const db = makeDb([[{ id: 'row-uuid-001' }]]);
    await expect(
      setPerformanceScore(db as unknown as Parameters<typeof setPerformanceScore>[0], 'row-uuid-001', 75),
    ).resolves.toBeUndefined();
  });

  it('throws ValidationError when score is negative', async () => {
    const db = makeDb();
    await expect(
      setPerformanceScore(db as unknown as Parameters<typeof setPerformanceScore>[0], 'id', -1),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError when score exceeds 100', async () => {
    const db = makeDb();
    await expect(
      setPerformanceScore(db as unknown as Parameters<typeof setPerformanceScore>[0], 'id', 101),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws NotFoundError when no row is updated', async () => {
    const db = makeDb([[]]);
    await expect(
      setPerformanceScore(db as unknown as Parameters<typeof setPerformanceScore>[0], 'gone', 50),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// toRenderJob
// ---------------------------------------------------------------------------

describe('toRenderJob', () => {
  const row: VideoCalendarRow = {
    id: 'row-uuid-001',
    appId: 'prime_self',
    type: 'marketing',
    briefKey: 'daily-transits-guide',
    compositionId: 'TrainingVideo',
    topic: 'Q4 launch',
    script: 'Raise your standard.',
    narrationUrl: 'https://r2.example.com/narration.mp3',
    videoUrl: 'https://r2.example.com/video.mp4',
    streamUid: 'uid-abc',
    scheduledAt: new Date(NOW_ISO),
    status: 'done',
    performanceScore: 75,
    triggerSource: 'cron',
    idempotencyKey: 'prime_self:video:001',
    error: null,
    createdAt: new Date(NOW_ISO),
    updatedAt: new Date(NOW_ISO),
  };

  it('converts a row to a RenderJob', () => {
    const job = toRenderJob(row);
    expect(job.id).toBe('row-uuid-001');
    expect(job.appId).toBe('prime_self');
    expect(job.briefKey).toBe('daily-transits-guide');
    expect(job.compositionId).toBe('TrainingVideo');
    expect(job.script).toBe('Raise your standard.');
    expect(job.narrationUrl).toBe('https://r2.example.com/narration.mp3');
    expect(job.streamUid).toBe('uid-abc');
    expect(typeof job.createdAt).toBe('string');
  });

  it('converts null script to empty string', () => {
    const job = toRenderJob({ ...row, script: null });
    expect(job.script).toBe('');
  });

  it('converts null optional fields to undefined', () => {
    const job = toRenderJob({ ...row, narrationUrl: null, videoUrl: null, streamUid: null, error: null });
    expect(job.narrationUrl).toBeUndefined();
    expect(job.videoUrl).toBeUndefined();
    expect(job.streamUid).toBeUndefined();
    expect(job.error).toBeUndefined();
  });
});
