/**
 * Notification preference route handlers (Phase 2).
 *
 * GET /notifications?appId=&environment=  — Get prefs for one app+env (qa_admin)
 * GET /notifications?appId=              — List all prefs for an app (qa_admin)
 * PUT /notifications                     — Upsert prefs (qa_admin)
 *
 * Notification prefs control:
 *   - Slack webhook + channel per app+env
 *   - GitHub issue auto-creation + assignees + labels
 *   - Trigger conditions (on pass / fail / regression)
 *   - Daily digest schedule (enabled flag + hour in UTC)
 *   - Minimum severity threshold for notifications
 *
 * See: docs/architecture/QA_TOOLS_ARCHITECTURE.md §3.6
 */

import { Hono } from 'hono';
import { ValidationError, NotFoundError } from '@latimer-woods-tech/errors';
import type { Env } from '../env.js';
import {
  upsertNotificationPref,
  getNotificationPref,
  listNotificationPrefs,
} from '../lib/phase2-db.js';
import { requireAuth, assertRole } from '../middleware/auth.js';

const notificationsRouter = new Hono<{ Bindings: Env }>();

const VALID_ENVIRONMENTS = ['staging', 'production', 'custom'] as const;
const VALID_SEVERITIES = ['critical', 'serious', 'moderate', 'minor'] as const;
// Widened to `string[]` so .includes() accepts arbitrary string input without casts.
const SEVERITY_VALUES: readonly string[] = VALID_SEVERITIES;

// ---------------------------------------------------------------------------
// GET /notifications?appId=&environment=
// ---------------------------------------------------------------------------

notificationsRouter.get('/', async (c) => {
  const claims = await requireAuth(c.req.header('Authorization'), c.env.QA_TOOLS_JWT_SECRET);
  assertRole(claims, 'qa_admin');

  const appId = c.req.query('appId');
  if (!appId) throw new ValidationError('appId query param is required');

  const environment = c.req.query('environment');

  if (environment) {
    // Single pref for a specific environment
    if (!VALID_ENVIRONMENTS.includes(environment as (typeof VALID_ENVIRONMENTS)[number])) {
      throw new ValidationError('environment must be staging, production, or custom');
    }
    const row = await getNotificationPref(c.env.DB.connectionString, appId, environment);
    if (!row) throw new NotFoundError(`No notification prefs for ${appId}/${environment}`);
    return c.json(serializePref(row));
  }

  // List all environments for this app
  const rows = await listNotificationPrefs(c.env.DB.connectionString, appId);
  return c.json({ prefs: rows.map(serializePref) });
});

// ---------------------------------------------------------------------------
// PUT /notifications
// ---------------------------------------------------------------------------

notificationsRouter.put('/', async (c) => {
  const claims = await requireAuth(c.req.header('Authorization'), c.env.QA_TOOLS_JWT_SECRET);
  assertRole(claims, 'qa_admin');

  const body = await c.req.json<{
    appId?: unknown;
    environment?: unknown;
    slackWebhookUrl?: unknown;
    slackChannel?: unknown;
    githubAssignees?: unknown;
    autoCreateGithubIssue?: unknown;
    githubRepo?: unknown;
    githubLabels?: unknown;
    notifyOnPass?: unknown;
    notifyOnFail?: unknown;
    notifyOnRegression?: unknown;
    dailyDigestEnabled?: unknown;
    dailyDigestHour?: unknown;
    minSeverityToNotify?: unknown;
  }>().catch(() => { throw new ValidationError('JSON body required'); });

  if (typeof body.appId !== 'string' || body.appId.length === 0) {
    throw new ValidationError('appId is required');
  }
  if (!VALID_ENVIRONMENTS.includes(String(body.environment) as (typeof VALID_ENVIRONMENTS)[number])) {
    throw new ValidationError('environment must be staging, production, or custom');
  }

  if (
    body.slackWebhookUrl !== undefined &&
    body.slackWebhookUrl !== null &&
    typeof body.slackWebhookUrl !== 'string'
  ) {
    throw new ValidationError('slackWebhookUrl must be a string or null');
  }
  if (
    body.githubAssignees !== undefined &&
    !Array.isArray(body.githubAssignees)
  ) {
    throw new ValidationError('githubAssignees must be an array');
  }
  if (
    body.githubLabels !== undefined &&
    !Array.isArray(body.githubLabels)
  ) {
    throw new ValidationError('githubLabels must be an array');
  }
  if (
    body.dailyDigestHour !== undefined &&
    body.dailyDigestHour !== null &&
    (typeof body.dailyDigestHour !== 'number' || body.dailyDigestHour < 0 || body.dailyDigestHour > 23)
  ) {
    throw new ValidationError('dailyDigestHour must be an integer 0–23');
  }
  if (
    body.minSeverityToNotify !== undefined &&
    !SEVERITY_VALUES.includes(String(body.minSeverityToNotify))
  ) {
    throw new ValidationError('minSeverityToNotify must be critical, serious, moderate, or minor');
  }

  const row = await upsertNotificationPref(c.env.DB.connectionString, {
    appId: body.appId,
    environment: String(body.environment),
    slackWebhookUrl:
      body.slackWebhookUrl !== undefined
        ? body.slackWebhookUrl
        : undefined,
    slackChannel:
      body.slackChannel !== undefined
        ? body.slackChannel as string | null
        : undefined,
    githubAssignees:
      Array.isArray(body.githubAssignees)
        ? body.githubAssignees as string[]
        : undefined,
    autoCreateGithubIssue:
      body.autoCreateGithubIssue !== undefined
        ? Boolean(body.autoCreateGithubIssue)
        : undefined,
    githubRepo:
      body.githubRepo !== undefined
        ? body.githubRepo as string | null
        : undefined,
    githubLabels:
      Array.isArray(body.githubLabels)
        ? body.githubLabels as string[]
        : undefined,
    notifyOnPass:
      body.notifyOnPass !== undefined
        ? Boolean(body.notifyOnPass)
        : undefined,
    notifyOnFail:
      body.notifyOnFail !== undefined
        ? Boolean(body.notifyOnFail)
        : undefined,
    notifyOnRegression:
      body.notifyOnRegression !== undefined
        ? Boolean(body.notifyOnRegression)
        : undefined,
    dailyDigestEnabled:
      body.dailyDigestEnabled !== undefined
        ? Boolean(body.dailyDigestEnabled)
        : undefined,
    dailyDigestHour:
      typeof body.dailyDigestHour === 'number'
        ? body.dailyDigestHour
        : undefined,
    minSeverityToNotify:
      body.minSeverityToNotify !== undefined
        ? String(body.minSeverityToNotify)
        : undefined,
  });

  return c.json(serializePref(row));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import type { NotificationPrefRow } from '../lib/phase2-db.js';

/** Serializes a NotificationPrefRow for API responses. */
function serializePref(row: NotificationPrefRow) {
  return {
    id: row.id,
    appId: row.app_id,
    environment: row.environment,
    slack: {
      webhookUrl: row.slack_webhook_url,
      channel: row.slack_channel,
    },
    github: {
      assignees: row.github_assignees,
      autoCreateIssue: row.auto_create_github_issue,
      repo: row.github_repo,
      labels: row.github_labels,
    },
    triggers: {
      notifyOnPass: row.notify_on_pass,
      notifyOnFail: row.notify_on_fail,
      notifyOnRegression: row.notify_on_regression,
    },
    digest: {
      enabled: row.daily_digest_enabled,
      hourUtc: row.daily_digest_hour,
    },
    minSeverityToNotify: row.min_severity_to_notify,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export { notificationsRouter };
