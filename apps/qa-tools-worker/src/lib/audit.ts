/**
 * Core audit dispatch and result processing for qa-tools-worker.
 *
 * This module owns the full lifecycle of an async audit run:
 *   1. Mark run as 'running'
 *   2. Resolve target URL from appId + environment (or customUrl)
 *   3. Dispatch to browser-agent
 *   4. Upload screenshots to R2
 *   5. Normalize browser-agent results → InsertResultParams[]
 *   6. Insert results into Neon
 *   7. Update run status (passed/failed/error/flaky)
 *   8. Fire notifications (Slack) if configured
 *
 * Called exclusively via ctx.waitUntil() — never blocks the HTTP response.
 */

import { InternalError } from '@latimer-woods-tech/errors';
import type { Env } from '../env.js';
import type { CreateRunRequest, AxeViolation } from '../types.js';
import { APP_URLS, PROFILE_DEFAULTS } from '../types.js';
import {
  markRunStarted,
  updateRun,
  insertResults,
  insertRun,
  getRunById,
  type InsertResultParams,
} from './db.js';
import {
  dispatchAudit,
  mapAxeImpact,
  buildRemediationHint,
  type AuditAuth,
} from './browser-agent.js';
import {
  uploadViewportScreenshots,
  buildR2Prefix,
  validateScreenshotBase64,
} from './r2.js';
import { getCredentialById } from './phase2-db.js';
import { decryptCredential } from './crypto.js';

// ---------------------------------------------------------------------------
// Target URL resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the URL to audit from the run request.
 * Precedence: customUrl > environment-specific APP_URLS entry.
 */
export function resolveTargetUrl(request: CreateRunRequest): string {
  if (request.customUrl) return request.customUrl;
  if (request.environment === 'custom') {
    throw new InternalError('customUrl is required when environment is "custom"');
  }
  const appUrls = APP_URLS[request.appId];
  return request.environment === 'staging' ? appUrls.staging : appUrls.production;
}

// ---------------------------------------------------------------------------
// Main async dispatch
// ---------------------------------------------------------------------------

/**
 * Runs a full audit cycle for a given run ID.
 * Designed to be called via ctx.waitUntil(runAudit(...)).
 *
 * On any error: updates the run status to 'error' with the error message.
 * Never throws — all exceptions are swallowed after DB update to prevent
 * the Worker from hanging on unhandled rejections inside waitUntil.
 */
export async function runAudit(
  runId: string,
  request: CreateRunRequest,
  env: Env,
): Promise<void> {
  const connectionString = env.DB.connectionString;
  const startMs = Date.now();

  try {
    await markRunStarted(connectionString, runId);

    const targetUrl = resolveTargetUrl(request);
    const profile = PROFILE_DEFAULTS[request.profile];

    // Phase 2: resolve authentication credentials if requested
    let auth: AuditAuth | undefined;
    if (request.testConfig?.includeAuthentication && request.testConfig.credentialId) {
      auth = await resolveCredentialAuth(
        connectionString,
        request.testConfig.credentialId,
        env.QA_TOOLS_ENCRYPT_KEY,
      );
    }

    // visual-review with runAxe=true
    // This gets us: axe violations + desktop screenshot in one call
    const { visualReview, durationMs } = await dispatchAudit(
      env.BROWSER_AGENT_URL,
      env.BROWSER_AGENT_AUDIENCE,
      env.BROWSER_AGENT_SA_KEY,
      {
        targetUrl,
        profile: request.profile,
        steps: request.testConfig?.scenario?.steps,
        runAxe: true,
        auth,
      },
    );

    // Upload screenshots to R2
    const r2Prefix = buildR2Prefix(request.appId, runId);
    const screenshotKeys: Record<string, string> = {};
    if (visualReview.viewports.length > 0) {
      const validViewports = visualReview.viewports.filter((vp) => {
        if (!vp.screenshotBase64) return false;
        try { validateScreenshotBase64(vp.screenshotBase64); return true; }
        catch { return false; }
      });
      if (validViewports.length > 0) {
        Object.assign(
          screenshotKeys,
          await uploadViewportScreenshots(env.QA_TOOLS_R2, request.appId, runId, validViewports),
        );
      }
    }

    // Build normalized result rows
    const results: InsertResultParams[] = [];

    // --- axe violations ---
    const axeViolations = visualReview.axeViolations ?? [];
    for (const v of axeViolations) {
      results.push(normalizeAxeViolation(runId, v, targetUrl, screenshotKeys['desktop']));
    }

    // --- console errors (Phase 1: store as 'info' findings) ---
    for (const ce of visualReview.consoleErrors.slice(0, 20)) {
      results.push({
        runId,
        category: 'console-errors',
        severity: ce.type === 'error' ? 'moderate' : 'minor',
        title: `Console ${ce.type}: ${ce.text.slice(0, 120)}`,
        description: ce.text,
        url: targetUrl,
        remediationHint: ce.location ? `At ${ce.location}` : undefined,
      });
    }

    // --- failed network requests ---
    for (const req of visualReview.failedRequests.slice(0, 20)) {
      const severity = req.status >= 500 ? 'serious' : 'minor';
      results.push({
        runId,
        category: 'network',
        violationId: `http-${String(req.status)}`,
        severity,
        title: `${req.method} ${req.url} → ${String(req.status)}`,
        description: `Network request returned ${String(req.status)}`,
        url: req.url,
        remediationHint: req.status >= 500 ? 'Investigate server-side error' : 'Check API endpoint availability',
      });
    }

    // Compute summary counts
    const violationsCount = results.filter((r) =>
      r.severity !== 'pass' && r.severity !== 'info',
    ).length;
    const passesCount = results.filter((r) => r.severity === 'pass').length;
    const warningsCount = results.filter((r) => r.severity === 'info').length;

    // Determine final status based on thresholds
    const thresholds = request.testConfig?.thresholds;
    const violationsMax = thresholds?.violationsMax;
    const criticalViolations = results.filter((r) => r.severity === 'critical').length;
    const seriousViolations = results.filter((r) => r.severity === 'serious').length;

    let finalStatus: 'passed' | 'failed' = 'passed';
    if (violationsMax !== undefined && violationsCount > violationsMax) finalStatus = 'failed';
    else if (criticalViolations > 0) finalStatus = 'failed';
    else if (profile.maxAttempts === 1 && seriousViolations > 0) finalStatus = 'failed';

    // Persist results to Neon
    await insertResults(connectionString, results);

    await updateRun(connectionString, {
      id: runId,
      status: finalStatus,
      completedAt: new Date(),
      durationMs: durationMs ?? (Date.now() - startMs),
      violationsCount,
      passesCount,
      warningsCount,
      r2Prefix,
    });

    // Send Slack notification if configured
    if (
      env.SLACK_QA_WEBHOOK_URL &&
      request.testConfig?.notifyOnComplete?.includes('slack') &&
      finalStatus === 'failed'
    ) {
      await notifySlack(
        env.SLACK_QA_WEBHOOK_URL,
        request.appId,
        request.environment,
        runId,
        violationsCount,
        env.ENVIRONMENT,
      ).catch(() => { /* Never fail the audit because Slack is down */ });
    }

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Log to stderr for Cloudflare logpush
    console.error(`[qa-tools] runAudit failed for runId=${runId}:`, message);

    await updateRun(connectionString, {
      id: runId,
      status: 'error',
      completedAt: new Date(),
      durationMs: Date.now() - startMs,
      errorMessage: message.slice(0, 500),
    }).catch(() => { /* Best-effort DB update on error path */ });

    // Auto-retry: if this run has remaining attempts, dispatch a new one.
    // The retry inherits the same request, increments attempt_number,
    // and sets parent_run_id → current run for audit trail grouping.
    await maybeDispatchRetry(connectionString, runId, request, env)
      .catch((retryErr: unknown) => {
        // Never let a retry failure surface — the original error is already recorded.
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        console.error(`[qa-tools] retry dispatch failed for parentRunId=${runId}:`, retryMsg);
      });
  }
}

// ---------------------------------------------------------------------------
// Credential resolution (Phase 2)
// ---------------------------------------------------------------------------

/**
 * Fetches and decrypts a stored credential for authenticated audit scenarios.
 * Returns null (no auth) when the encrypt key or credential is unavailable.
 * Throws InternalError if the credential exists but cannot be decrypted.
 */
async function resolveCredentialAuth(
  connectionString: string,
  credentialId: string,
  encryptKey: string | undefined,
): Promise<AuditAuth | undefined> {
  if (!encryptKey) {
    // Key not configured — authenticated scenarios will run without credentials.
    // This is a soft-fail: we log a warning rather than blocking the audit.
    console.warn('[qa-tools] QA_TOOLS_ENCRYPT_KEY not set; skipping credential injection');
    return undefined;
  }

  const row = await getCredentialById(connectionString, credentialId);
  if (!row) {
    throw new InternalError(`Credential ${credentialId} not found — cannot authenticate audit`);
  }

  const payload = await decryptCredential(row.encrypted_payload, encryptKey);

  return {
    username: payload.username,
    password: payload.password,
    ...(payload.mfaSecret ? { mfaSecret: payload.mfaSecret } : {}),
  };
}

// ---------------------------------------------------------------------------
// Retry dispatch (Phase 2)
// ---------------------------------------------------------------------------

/**
 * If the failed run has remaining attempts, inserts a new run with
 * attempt_number + 1 and parent_run_id pointing to the current run,
 * then immediately invokes runAudit for the new run.
 *
 * Called from the error path of runAudit — never throws.
 */
async function maybeDispatchRetry(
  connectionString: string,
  failedRunId: string,
  request: CreateRunRequest,
  env: Env,
): Promise<void> {
  const failedRun = await getRunById(connectionString, failedRunId);
  if (!failedRun) return; // Shouldn't happen but guard defensively

  const attemptNumber = failedRun.attempt_number;
  const maxAttempts = failedRun.max_attempts;

  if (attemptNumber >= maxAttempts) return; // No retries remaining

  const backoffMs = request.testConfig?.retryPolicy?.backoffMs ?? 2_000;
  const nextAttempt = attemptNumber + 1;

  console.info(
    `[qa-tools] scheduling retry attempt ${String(nextAttempt)}/${String(maxAttempts)} for parentRunId=${failedRunId} in ${String(backoffMs)}ms`,
  );

  // Wait for backoff before retrying (stays inside waitUntil budget)
  await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));

  const retryRunId = await insertRun(connectionString, {
    appId: request.appId,
    environment: request.environment,
    customUrl: request.customUrl,
    testType: request.testType,
    profile: request.profile,
    testConfig: request.testConfig ?? {},
    maxAttempts,
    attemptNumber: nextAttempt,
    parentRunId: failedRunId,
    createdBy: failedRun.created_by,
    tags: failedRun.tags,
    ciContext: failedRun.ci_context,
    templateId: failedRun.template_id,
  });

  console.info(`[qa-tools] retry run created: runId=${retryRunId}`);

  // runAudit is self-contained and never throws — safe to await in waitUntil
  await runAudit(retryRunId, request, env);
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function normalizeAxeViolation(
  runId: string,
  v: AxeViolation,
  pageUrl: string,
  desktopScreenshotKey?: string,
): InsertResultParams {
  return {
    runId,
    category: 'axe',
    violationId: v.id,
    severity: mapAxeImpact(v.impact),
    title: v.id,
    description: v.description,
    remediationHint: buildRemediationHint(v.help, v.helpUrl),
    selector: v.exampleSelectors[0] ?? null,
    url: pageUrl,
    affectedNodes: v.nodeCount,
    screenshotKey: desktopScreenshotKey ?? null,
  };
}

// ---------------------------------------------------------------------------
// Slack notification
// ---------------------------------------------------------------------------

async function notifySlack(
  webhookUrl: string,
  appId: string,
  environment: string,
  runId: string,
  violationsCount: number,
  workerEnv: string,
): Promise<void> {
  const dashboardBase = workerEnv === 'production'
    ? 'https://qa-tools.lwt.internal'
    : 'https://qa-tools-staging.lwt.internal';

  const body = {
    text: `🔴 QA Audit Failed — ${appId}/${environment}`,
    attachments: [
      {
        color: 'danger',
        title: `${String(violationsCount)} violation${violationsCount !== 1 ? 's' : ''} found`,
        actions: [
          {
            type: 'button',
            text: 'View Results',
            url: `${dashboardBase}/runs/${runId}`,
          },
        ],
      },
    ],
  };

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new InternalError(`Slack webhook failed: ${String(response.status)}`);
  }
}
