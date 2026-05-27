/**
 * Phase 2 database access layer — credentials, templates, notification prefs.
 *
 * Uses @neondatabase/serverless tagged-template queries (no Drizzle).
 * All queries are parameterized to prevent SQL injection.
 *
 * See: docs/architecture/QA_TOOLS_ARCHITECTURE.md §3.3, §3.5, §3.6
 */

import { neon } from '@neondatabase/serverless';
import { NotFoundError } from '@latimer-woods-tech/errors';

// ---------------------------------------------------------------------------
// DB factory
// ---------------------------------------------------------------------------

function sql(connectionString: string) {
  return neon(connectionString);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** DB row for qa_tools_credentials. */
export interface CredentialRow {
  id: string;
  app_id: string;
  environment: string;
  label: string;
  encrypted_payload: string;
  username_hint: string | null;
  last_used_at: string | null;
  last_used_by: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** DB row for qa_tools_templates. */
export interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  app_id: string | null;
  test_type: string;
  profile: string;
  test_config: Record<string, unknown>;
  is_ci_default: boolean;
  ci_fail_on_regression: boolean;
  thresholds: Record<string, unknown> | null;
  created_by: string | null;
  is_system: boolean;
  created_at: string;
  updated_at: string;
}

/** DB row for qa_tools_notification_prefs. */
export interface NotificationPrefRow {
  id: string;
  app_id: string;
  environment: string;
  slack_webhook_url: string | null;
  slack_channel: string | null;
  github_assignees: string[];
  auto_create_github_issue: boolean;
  github_repo: string | null;
  github_labels: string[];
  notify_on_pass: boolean;
  notify_on_fail: boolean;
  notify_on_regression: boolean;
  daily_digest_enabled: boolean;
  daily_digest_hour: number;
  min_severity_to_notify: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Credentials CRUD
// ---------------------------------------------------------------------------

/** Create params for inserting a credential row. */
export interface InsertCredentialParams {
  appId: string;
  environment: string;
  label: string;
  encryptedPayload: string;
  usernameHint?: string | null;
  createdBy?: string | null;
}

/**
 * Inserts a new credential row and returns the created row.
 */
export async function insertCredential(
  connectionString: string,
  params: InsertCredentialParams,
): Promise<CredentialRow> {
  const db = sql(connectionString);
  const rows = await db`
    INSERT INTO qa_tools_credentials
      (app_id, environment, label, encrypted_payload, username_hint, created_by)
    VALUES
      (${params.appId}, ${params.environment}, ${params.label},
       ${params.encryptedPayload}, ${params.usernameHint ?? null}, ${params.createdBy ?? null})
    RETURNING *
  `;
  const row = rows[0] as CredentialRow | undefined;
  if (!row) throw new NotFoundError('insertCredential returned no row');
  return row;
}

/**
 * Lists all credentials for a given app + environment.
 * Returns rows WITHOUT the encrypted_payload (use getCredentialById for decryption).
 */
export async function listCredentials(
  connectionString: string,
  appId: string,
  environment?: string,
): Promise<Omit<CredentialRow, 'encrypted_payload'>[]> {
  const db = sql(connectionString);
  const rows = environment
    ? await db`
        SELECT id, app_id, environment, label, username_hint, last_used_at, last_used_by, created_by, created_at, updated_at
        FROM qa_tools_credentials
        WHERE app_id = ${appId} AND environment = ${environment}
        ORDER BY label
      `
    : await db`
        SELECT id, app_id, environment, label, username_hint, last_used_at, last_used_by, created_by, created_at, updated_at
        FROM qa_tools_credentials
        WHERE app_id = ${appId}
        ORDER BY environment, label
      `;
  return rows as Omit<CredentialRow, 'encrypted_payload'>[];
}

/**
 * Fetches a single credential row by id (includes encrypted_payload for decryption).
 */
export async function getCredentialById(
  connectionString: string,
  id: string,
): Promise<CredentialRow | null> {
  const db = sql(connectionString);
  const rows = await db`SELECT * FROM qa_tools_credentials WHERE id = ${id} LIMIT 1`;
  return (rows[0] as CredentialRow) ?? null;
}

/**
 * Deletes a credential by id. Returns true if a row was deleted.
 */
export async function deleteCredential(
  connectionString: string,
  id: string,
): Promise<boolean> {
  const db = sql(connectionString);
  const rows = await db`DELETE FROM qa_tools_credentials WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

/**
 * Records a credential use (timestamp + user).
 * Called during audit dispatch; never throws to avoid blocking audits.
 */
export async function touchCredentialUsage(
  connectionString: string,
  id: string,
  userId: string,
): Promise<void> {
  const db = sql(connectionString);
  await db`
    UPDATE qa_tools_credentials
    SET last_used_at = now(), last_used_by = ${userId}
    WHERE id = ${id}
  `;
}

// ---------------------------------------------------------------------------
// Templates CRUD
// ---------------------------------------------------------------------------

/** Create params for inserting a custom template row. */
export interface InsertTemplateParams {
  name: string;
  description?: string | null;
  appId?: string | null;
  testType: string;
  profile: string;
  testConfig?: Record<string, unknown>;
  isCiDefault?: boolean;
  ciFail?: boolean;
  thresholds?: Record<string, unknown> | null;
  createdBy?: string | null;
}

/**
 * Inserts a user-created (non-system) template.
 */
export async function insertTemplate(
  connectionString: string,
  params: InsertTemplateParams,
): Promise<TemplateRow> {
  const db = sql(connectionString);
  const rows = await db`
    INSERT INTO qa_tools_templates
      (name, description, app_id, test_type, profile, test_config,
       is_ci_default, ci_fail_on_regression, thresholds, created_by, is_system)
    VALUES
      (${params.name}, ${params.description ?? null}, ${params.appId ?? null},
       ${params.testType}, ${params.profile},
       ${JSON.stringify(params.testConfig ?? {})},
       ${params.isCiDefault ?? false}, ${params.ciFail ?? true},
       ${params.thresholds ? JSON.stringify(params.thresholds) : null},
       ${params.createdBy ?? null}, FALSE)
    RETURNING *
  `;
  const row = rows[0] as TemplateRow | undefined;
  if (!row) throw new NotFoundError('insertTemplate returned no row');
  return row;
}

/**
 * Lists templates visible to the caller.
 * Returns system templates + custom templates for the given app_id (or all apps when appId is null).
 */
export async function listTemplates(
  connectionString: string,
  appId?: string | null,
): Promise<TemplateRow[]> {
  const db = sql(connectionString);
  // Return system (global) templates + app-specific custom templates
  const rows = appId
    ? await db`
        SELECT * FROM qa_tools_templates
        WHERE app_id IS NULL OR app_id = ${appId}
        ORDER BY is_system DESC, name
      `
    : await db`
        SELECT * FROM qa_tools_templates
        ORDER BY is_system DESC, app_id NULLS FIRST, name
      `;
  return rows as TemplateRow[];
}

/**
 * Fetches a single template by id.
 */
export async function getTemplateById(
  connectionString: string,
  id: string,
): Promise<TemplateRow | null> {
  const db = sql(connectionString);
  const rows = await db`SELECT * FROM qa_tools_templates WHERE id = ${id} LIMIT 1`;
  return (rows[0] as TemplateRow) ?? null;
}

/**
 * Deletes a custom (non-system) template by id.
 * Returns true if deleted, false if not found.
 * Throws NotFoundError if the template is system-managed.
 */
export async function deleteTemplate(
  connectionString: string,
  id: string,
): Promise<boolean> {
  const db = sql(connectionString);
  // Check system flag first
  const checkRows = await db`SELECT is_system FROM qa_tools_templates WHERE id = ${id} LIMIT 1`;
  const check = checkRows[0] as { is_system: boolean } | undefined;
  if (!check) return false;
  if (check.is_system) {
    throw new NotFoundError(`Template ${id} is a system template and cannot be deleted`);
  }
  const rows = await db`DELETE FROM qa_tools_templates WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Notification prefs CRUD
// ---------------------------------------------------------------------------

/** Upsert params for notification prefs. */
export interface UpsertNotificationPrefParams {
  appId: string;
  environment: string;
  slackWebhookUrl?: string | null;
  slackChannel?: string | null;
  githubAssignees?: string[];
  autoCreateGithubIssue?: boolean;
  githubRepo?: string | null;
  githubLabels?: string[];
  notifyOnPass?: boolean;
  notifyOnFail?: boolean;
  notifyOnRegression?: boolean;
  dailyDigestEnabled?: boolean;
  dailyDigestHour?: number;
  minSeverityToNotify?: string;
}

/**
 * Upserts notification preferences for an app + environment.
 * On conflict, updates all provided fields.
 */
export async function upsertNotificationPref(
  connectionString: string,
  params: UpsertNotificationPrefParams,
): Promise<NotificationPrefRow> {
  const db = sql(connectionString);
  const rows = await db`
    INSERT INTO qa_tools_notification_prefs
      (app_id, environment,
       slack_webhook_url, slack_channel, github_assignees,
       auto_create_github_issue, github_repo, github_labels,
       notify_on_pass, notify_on_fail, notify_on_regression,
       daily_digest_enabled, daily_digest_hour, min_severity_to_notify)
    VALUES
      (${params.appId}, ${params.environment},
       ${params.slackWebhookUrl ?? null}, ${params.slackChannel ?? null},
       ${params.githubAssignees ?? []},
       ${params.autoCreateGithubIssue ?? false},
       ${params.githubRepo ?? null},
       ${params.githubLabels ?? ['qa-findings']},
       ${params.notifyOnPass ?? false}, ${params.notifyOnFail ?? true},
       ${params.notifyOnRegression ?? true},
       ${params.dailyDigestEnabled ?? true}, ${params.dailyDigestHour ?? 9},
       ${params.minSeverityToNotify ?? 'serious'})
    ON CONFLICT (app_id, environment) DO UPDATE SET
      slack_webhook_url       = EXCLUDED.slack_webhook_url,
      slack_channel           = EXCLUDED.slack_channel,
      github_assignees        = EXCLUDED.github_assignees,
      auto_create_github_issue = EXCLUDED.auto_create_github_issue,
      github_repo             = EXCLUDED.github_repo,
      github_labels           = EXCLUDED.github_labels,
      notify_on_pass          = EXCLUDED.notify_on_pass,
      notify_on_fail          = EXCLUDED.notify_on_fail,
      notify_on_regression    = EXCLUDED.notify_on_regression,
      daily_digest_enabled    = EXCLUDED.daily_digest_enabled,
      daily_digest_hour       = EXCLUDED.daily_digest_hour,
      min_severity_to_notify  = EXCLUDED.min_severity_to_notify,
      updated_at              = now()
    RETURNING *
  `;
  const row = rows[0] as NotificationPrefRow | undefined;
  if (!row) throw new NotFoundError('upsertNotificationPref returned no row');
  return row;
}

/**
 * Fetches notification prefs for an app + environment. Returns null if not configured.
 */
export async function getNotificationPref(
  connectionString: string,
  appId: string,
  environment: string,
): Promise<NotificationPrefRow | null> {
  const db = sql(connectionString);
  const rows = await db`
    SELECT * FROM qa_tools_notification_prefs
    WHERE app_id = ${appId} AND environment = ${environment}
    LIMIT 1
  `;
  return (rows[0] as NotificationPrefRow) ?? null;
}

/**
 * Lists all notification pref configurations for a given app.
 */
export async function listNotificationPrefs(
  connectionString: string,
  appId: string,
): Promise<NotificationPrefRow[]> {
  const db = sql(connectionString);
  const rows = await db`
    SELECT * FROM qa_tools_notification_prefs
    WHERE app_id = ${appId}
    ORDER BY environment
  `;
  return rows as NotificationPrefRow[];
}
