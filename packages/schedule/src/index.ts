import { sql } from '@latimer-woods-tech/neon';
import type { FactoryDb } from '@latimer-woods-tech/neon';
import { ValidationError, InternalError, NotFoundError } from '@latimer-woods-tech/errors';
import type { RenderJob, RenderJobType, RenderJobStatus } from '@latimer-woods-tech/video';

// Re-export the job types so consumers only need one import
export type { RenderJob, RenderJobType, RenderJobStatus } from '@latimer-woods-tech/video';

// Practitioner Studio entitlements + Stripe webhook (W360-005)
// Re-exported from @latimer-woods-tech/neon where they live alongside drizzle-orm
export {
  studioPlanTable,
  studioCustomerTable,
  studioSubscriptionTable,
  studioCreditLedgerTable,
  studioEntitlementTable,
  studioPlanTables,
  type StudioPlan,
  type StudioPlanInsert,
  type StudioCustomer,
  type StudioCustomerInsert,
  type StudioSubscription,
  type StudioSubscriptionInsert,
  type StudioCreditLedgerEntry,
  type StudioCreditLedgerInsert,
  type CreditLedgerOperationType,
  type StudioEntitlement,
  type StudioEntitlementInsert,
  type EntitlementPolicy,
  evaluateEntitlementPolicy,
  getEntitlementPolicy,
  debitCreditsForRender,
  grantCredits,
  refundCredits,
  getTotalAvailableCredits,
  entitlementService,
  handleStripeWebhook,
  verifyStripeSignature,
  isEventProcessed,
  recordProcessedEvent,
  handleSubscriptionCreated,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  refreshEntitlements,
  type StripeEvent,
  type StripeSubscription,
  type StripeCustomer,
  type StripeInvoice,
} from '@latimer-woods-tech/neon';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/**
 * What triggered the creation of a scheduled video.
 *
 * - `cron`               — Fired by a Cloudflare Worker cron schedule
 * - `git_tag`            — Triggered by a git release tag (e.g. a new feature deploy)
 * - `feedback_threshold` — Triggered when PostHog engagement drops below SLO
 * - `manual`             — Created directly by an operator or API call
 */
export type TriggerSource = 'cron' | 'git_tag' | 'feedback_threshold' | 'manual';

/**
 * A row in the `video_calendar` database table.
 */
export interface VideoCalendarRow {
  /** UUID primary key. */
  id: string;
  /** Factory application identifier (e.g. `'prime_self'`). */
  appId: string;
  /** Type of video to produce. */
  type: RenderJobType;
  /** Optional Media Room source brief key for deterministic render inputs. */
  briefKey: string | null;
  /** Optional Remotion composition id for workflow dispatch. */
  compositionId: string | null;
  /** Short descriptive topic for the script generator. */
  topic: string;
  /** Full narration script (populated after LLM generation). */
  script: string | null;
  /** URL or R2 key of the generated narration audio file. */
  narrationUrl: string | null;
  /** URL or R2 key of the rendered MP4. */
  videoUrl: string | null;
  /** Cloudflare Stream UID after registration. */
  streamUid: string | null;
  /** When this video is scheduled to go live. */
  scheduledAt: Date;
  /** Current pipeline status. */
  status: RenderJobStatus;
  /**
   * Normalised engagement score from PostHog (0–100).
   * Higher = more urgent to rebuild or replace.
   */
  performanceScore: number;
  /** What triggered this calendar entry. */
  triggerSource: TriggerSource;
  /** Optional retry-safe key supplied by the caller. */
  idempotencyKey: string | null;
  /** ISO 8601 error message when status is 'failed'. */
  error: string | null;
  /** Row creation timestamp. */
  createdAt: Date;
  /** Row last-updated timestamp. */
  updatedAt: Date;
}

/**
 * Input required to schedule a new video production job.
 */
export interface ProductionBrief {
  /** Factory application identifier. */
  appId: string;
  /** Category of video to produce. */
  type: RenderJobType;
  /** Optional Media Room source brief key for deterministic render inputs. */
  briefKey?: string;
  /** Optional Remotion composition id for workflow dispatch. */
  compositionId?: string;
  /** Short descriptive topic for the script generator. */
  topic: string;
  /** When this video should go live (defaults to now). */
  scheduledAt?: Date;
  /** What caused this job to be created. */
  triggerSource: TriggerSource;
  /** Optional initial priority score between 0 and 100. */
  performanceScore?: number;
  /** Optional app-scoped idempotency key for retry-safe job creation. */
  idempotencyKey?: string;
}

// ---------------------------------------------------------------------------
// DDL helper
// ---------------------------------------------------------------------------

/**
 * SQL DDL that creates the `video_calendar` table if it does not exist.
 * Run this during your database migration step or app bootstrap.
 *
 * @example
 * ```ts
 * await db.execute(VIDEO_CALENDAR_DDL);
 * ```
 */
export const VIDEO_CALENDAR_MIGRATION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS video_calendar (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id           TEXT NOT NULL,
  type             TEXT NOT NULL CHECK (type IN ('marketing', 'training', 'walkthrough')),
  brief_key        TEXT,
  composition_id   TEXT,
  topic            TEXT NOT NULL,
  script           TEXT,
  narration_url    TEXT,
  video_url        TEXT,
  stream_uid       TEXT,
  scheduled_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'rendering', 'uploading', 'done', 'failed')),
  performance_score INTEGER NOT NULL DEFAULT 0 CHECK (performance_score BETWEEN 0 AND 100),
  trigger_source   TEXT NOT NULL CHECK (trigger_source IN ('cron', 'git_tag', 'feedback_threshold', 'manual')),
  idempotency_key   TEXT,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`,
  'ALTER TABLE video_calendar ADD COLUMN IF NOT EXISTS idempotency_key TEXT;',
  'ALTER TABLE video_calendar ADD COLUMN IF NOT EXISTS brief_key TEXT;',
  'ALTER TABLE video_calendar ADD COLUMN IF NOT EXISTS composition_id TEXT;',
  'CREATE INDEX IF NOT EXISTS video_calendar_status_idx ON video_calendar (status);',
  'CREATE INDEX IF NOT EXISTS video_calendar_app_id_idx ON video_calendar (app_id);',
  'CREATE INDEX IF NOT EXISTS video_calendar_brief_key_idx ON video_calendar (app_id, brief_key);',
  'CREATE INDEX IF NOT EXISTS video_calendar_scheduled_at_idx ON video_calendar (scheduled_at);',
  `CREATE UNIQUE INDEX IF NOT EXISTS video_calendar_app_idempotency_idx
  ON video_calendar (app_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;`,
] as const;

export const VIDEO_CALENDAR_DDL = VIDEO_CALENDAR_MIGRATION_STATEMENTS.join('\n\n');

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

/** @internal Map a raw DB row to a typed VideoCalendarRow. */
function toRow(raw: Record<string, unknown>): VideoCalendarRow {
  return {
    id: raw['id'] as string,
    appId: raw['app_id'] as string,
    type: raw['type'] as RenderJobType,
    briefKey: (raw['brief_key'] as string | null) ?? null,
    compositionId: (raw['composition_id'] as string | null) ?? null,
    topic: raw['topic'] as string,
    script: (raw['script'] as string | null) ?? null,
    narrationUrl: (raw['narration_url'] as string | null) ?? null,
    videoUrl: (raw['video_url'] as string | null) ?? null,
    streamUid: (raw['stream_uid'] as string | null) ?? null,
    scheduledAt: new Date(raw['scheduled_at'] as string),
    status: raw['status'] as RenderJobStatus,
    performanceScore: raw['performance_score'] as number,
    triggerSource: raw['trigger_source'] as TriggerSource,
    idempotencyKey: (raw['idempotency_key'] as string | null) ?? null,
    error: (raw['error'] as string | null) ?? null,
    createdAt: new Date(raw['created_at'] as string),
    updatedAt: new Date(raw['updated_at'] as string),
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Inserts a new video production job into the `video_calendar` table.
 * The job starts with `status = 'pending'` and is picked up by the next
 * `processQueue` invocation.
 *
 * @example
 * ```ts
 * const job = await scheduleVideo(db, {
 *   appId: 'prime_self',
 *   type: 'marketing',
 *   topic: 'Q4 launch — peak performance challenge',
 *   triggerSource: 'cron',
 * });
 * console.log(job.id); // UUID
 * ```
 */
export async function scheduleVideo(
  db: FactoryDb,
  brief: ProductionBrief,
): Promise<VideoCalendarRow> {
  if (!brief.appId.trim()) throw new ValidationError('appId is required');
  if (!brief.topic.trim()) throw new ValidationError('topic is required');
  if (brief.performanceScore !== undefined && (brief.performanceScore < 0 || brief.performanceScore > 100)) {
    throw new ValidationError('performanceScore must be between 0 and 100', { performanceScore: brief.performanceScore });
  }
  if (brief.idempotencyKey !== undefined && !brief.idempotencyKey.trim()) {
    throw new ValidationError('idempotencyKey must not be blank when provided');
  }

  const scheduledAt = brief.scheduledAt ?? new Date();
  const performanceScore = brief.performanceScore ?? 0;
  const idempotencyKey = brief.idempotencyKey?.trim() || null;
  const briefKey = brief.briefKey?.trim() || null;
  const compositionId = brief.compositionId?.trim() || null;

  const rows = await db.execute(
    sql`
      INSERT INTO video_calendar (
        app_id, type, brief_key, composition_id, topic, scheduled_at,
        performance_score, trigger_source, idempotency_key
      )
      VALUES (
        ${brief.appId},
        ${brief.type},
        ${briefKey},
        ${compositionId},
        ${brief.topic},
        ${scheduledAt.toISOString()},
        ${performanceScore},
        ${brief.triggerSource},
        ${idempotencyKey}
      )
      ON CONFLICT (app_id, idempotency_key) WHERE idempotency_key IS NOT NULL
      DO UPDATE SET updated_at = video_calendar.updated_at
      RETURNING
        id, app_id, type, brief_key, composition_id, topic, script, narration_url, video_url, stream_uid,
        scheduled_at, status, performance_score, trigger_source, idempotency_key, error,
        created_at, updated_at
    `,
  );

  const row = rows.rows[0];
  if (!row) throw new InternalError('scheduleVideo: INSERT returned no row', { brief });
  return toRow(row);
}

/**
 * Retrieves a single `video_calendar` row by its UUID.
 * Throws `NotFoundError` if no matching row exists.
 *
 * @example
 * ```ts
 * const job = await getVideoJob(db, 'a1b2c3d4-...');
 * ```
 */
export async function getVideoJob(
  db: FactoryDb,
  id: string,
  appId?: string,
): Promise<VideoCalendarRow> {
  const appScope = appId?.trim() || null;
  const scopeFilter = appScope ? sql`AND app_id = ${appScope}` : sql``;
  const rows = await db.execute(
    sql`
      SELECT
        id, app_id, type, brief_key, composition_id, topic, script, narration_url, video_url, stream_uid,
        scheduled_at, status, performance_score, trigger_source, idempotency_key, error,
        created_at, updated_at
      FROM video_calendar
      WHERE id = ${id}
        ${scopeFilter}
      LIMIT 1
    `,
  );

  const row = rows.rows[0];
  if (!row) throw new NotFoundError(`Video job not found: ${id}`, { id });
  return toRow(row);
}

/**
 * Returns up to `limit` pending jobs ordered by priority score descending,
 * then by `scheduled_at` ascending (oldest first within equal scores).
 *
 * @example
 * ```ts
 * const queue = await getPendingJobs(db, 5);
 * for (const job of queue) {
 *   await dispatchRender(job);
 * }
 * ```
 */
export async function getPendingJobs(
  db: FactoryDb,
  limit = 10,
  appId?: string,
): Promise<VideoCalendarRow[]> {
  if (limit < 1 || limit > 100) {
    throw new ValidationError('limit must be between 1 and 100', { limit });
  }

  const appScope = appId?.trim() || null;
  const scopeFilter = appScope ? sql`AND app_id = ${appScope}` : sql``;
  const rows = await db.execute(
    sql`
      SELECT
        id, app_id, type, brief_key, composition_id, topic, script, narration_url, video_url, stream_uid,
        scheduled_at, status, performance_score, trigger_source, idempotency_key, error,
        created_at, updated_at
      FROM video_calendar
      WHERE status = 'pending'
        AND scheduled_at <= NOW()
        ${scopeFilter}
      ORDER BY performance_score DESC, scheduled_at ASC
      LIMIT ${limit}
    `,
  );

  return rows.rows.map((r) => toRow(r));
}

/**
 * Updates the status and optional fields of a `video_calendar` row.
 * Automatically sets `updated_at = NOW()`.
 *
 * @example
 * ```ts
 * await updateJobStatus(db, job.id, 'done', {
 *   streamUid: video.uid,
 *   videoUrl: 'https://r2.example.com/renders/job_01.mp4',
 * });
 * ```
 */
export async function updateJobStatus(
  db: FactoryDb,
  id: string,
  status: RenderJobStatus,
  updates: {
    script?: string;
    narrationUrl?: string;
    videoUrl?: string;
    streamUid?: string;
    error?: string;
  } = {},
  appId?: string,
): Promise<VideoCalendarRow> {
  const appScope = appId?.trim() || null;
  const scopeFilter = appScope ? sql`AND app_id = ${appScope}` : sql``;
  const rows = await db.execute(
    sql`
      UPDATE video_calendar
      SET
        status        = ${status},
        script        = COALESCE(${updates.script ?? null}, script),
        narration_url = COALESCE(${updates.narrationUrl ?? null}, narration_url),
        video_url     = COALESCE(${updates.videoUrl ?? null}, video_url),
        stream_uid    = COALESCE(${updates.streamUid ?? null}, stream_uid),
        error         = ${updates.error ?? null},
        updated_at    = NOW()
      WHERE id = ${id}
        ${scopeFilter}
      RETURNING
        id, app_id, type, brief_key, composition_id, topic, script, narration_url, video_url, stream_uid,
        scheduled_at, status, performance_score, trigger_source, idempotency_key, error,
        created_at, updated_at
    `,
  );

  const row = rows.rows[0];
  if (!row) throw new NotFoundError(`Video job not found for update: ${id}`, { id, status });
  return toRow(row);
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * PostHog engagement metrics used to score a video's production priority.
 */
export interface EngagementMetrics {
  /** 0–100 watch-completion rate (percentage of viewers who watched to the end). */
  completionRate: number;
  /** 0–100 click-through rate on the primary call-to-action. */
  ctaClickRate: number;
  /** Number of unique viewers in the scoring window. */
  uniqueViewers: number;
  /**
   * Age of the video in days.
   * Older videos are deprioritised to encourage freshness.
   */
  ageInDays: number;
}

/**
 * Calculates a normalised priority score (0–100) for producing a new or
 * replacement video. Higher scores bubble to the top of the render queue.
 *
 * Scoring formula:
 * - Base score = `(100 − completionRate) × 0.5 + (100 − ctaClickRate) × 0.3`
 *   (poor engagement → higher urgency)
 * - Viewer bonus = `min(uniqueViewers / 1000, 10)` (more viewers → higher impact)
 * - Age bonus = `min(ageInDays / 30, 10)` (older → higher urgency, capped at 10)
 * - Final = clamped to [0, 100]
 *
 * @example
 * ```ts
 * const score = scorePriority({
 *   completionRate: 40,  // only 40% finish the video
 *   ctaClickRate: 10,
 *   uniqueViewers: 5000,
 *   ageInDays: 90,
 * });
 * // score ≈ 87
 * ```
 */
export function scorePriority(metrics: EngagementMetrics): number {
  const base =
    (100 - metrics.completionRate) * 0.5 + (100 - metrics.ctaClickRate) * 0.3;
  const viewerBonus = Math.min(metrics.uniqueViewers / 1000, 10);
  const ageBonus = Math.min(metrics.ageInDays / 30, 10);
  const raw = base + viewerBonus + ageBonus;
  return Math.round(Math.min(100, Math.max(0, raw)));
}

/**
 * Updates the `performance_score` field on a `video_calendar` row.
 * Call this after computing a fresh score from PostHog metrics.
 *
 * @example
 * ```ts
 * const score = scorePriority(metrics);
 * await setPerformanceScore(db, jobId, score);
 * ```
 */
export async function setPerformanceScore(
  db: FactoryDb,
  id: string,
  score: number,
): Promise<void> {
  if (score < 0 || score > 100) {
    throw new ValidationError('score must be between 0 and 100', { id, score });
  }

  const rows = await db.execute(
    sql`
      UPDATE video_calendar
      SET performance_score = ${score}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING id
    `,
  );

  if (!rows.rows[0]) {
    throw new NotFoundError(`Video job not found for score update: ${id}`, { id });
  }
}

// ---------------------------------------------------------------------------
// RenderJob conversion
// ---------------------------------------------------------------------------

/**
 * Converts a `VideoCalendarRow` into a `RenderJob` for dispatch to the
 * GitHub Actions render workflow.
 *
 * @example
 * ```ts
 * const job = toRenderJob(row);
 * await triggerRenderWorkflow(job);
 * ```
 */
export function toRenderJob(row: VideoCalendarRow): RenderJob {
  return {
    id: row.id,
    appId: row.appId,
    type: row.type,
    briefKey: row.briefKey ?? undefined,
    compositionId: row.compositionId ?? undefined,
    topic: row.topic,
    script: row.script ?? '',
    narrationUrl: row.narrationUrl ?? undefined,
    videoUrl: row.videoUrl ?? undefined,
    streamUid: row.streamUid ?? undefined,
    status: row.status,
    error: row.error ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
