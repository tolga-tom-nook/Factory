/**
 * Run management route handlers.
 *
 * POST   /runs                  — Start an audit
 * GET    /runs                  — List runs (filterable)
 * GET    /runs/:id/status       — Poll run status
 * GET    /runs/:id/results      — Detailed findings
 * POST   /runs/:id/create-issue — Export to GitHub
 * POST   /runs/:id/rerun        — Retry / re-run
 * PATCH  /runs/:id/results/:resultId — Acknowledge a finding
 *
 * See: docs/architecture/QA_TOOLS_ARCHITECTURE.md §4
 */

import { Hono } from 'hono';
import { ValidationError, NotFoundError } from '@latimer-woods-tech/errors';
import type { Env } from '../env.js';
import type { CreateRunRequest, Profile, Environment, AppId, TestConfig } from '../types.js';
import { VALID_APP_IDS, PROFILE_DEFAULTS } from '../types.js';
import {
  insertRun,
  updateRun,
  getRunById,
  listRuns,
  getResultsByRunId,
  updateResultStatus,
} from '../lib/db.js';
import { runAudit } from '../lib/audit.js';
import {
  requireAuth,
  assertAppAccess,
  assertRole,
} from '../middleware/auth.js';
import {
  acquireConcurrencySlot,
  releaseConcurrencySlot,
  buildRateLimitHeaders,
} from '../lib/rate-limit.js';

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const runsRouter = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// POST /runs — Start an audit
// ---------------------------------------------------------------------------

runsRouter.post('/', async (c) => {
  const claims = await requireAuth(c.req.header('Authorization'), c.env.QA_TOOLS_JWT_SECRET);
  assertRole(claims, 'qa_runner');

  const body = await c.req.json<CreateRunRequest>().catch(() => {
    throw new ValidationError('JSON body required');
  });

  // Validate appId
  if (!body.appId || !VALID_APP_IDS.includes(body.appId)) {
    throw new ValidationError(`appId must be one of: ${VALID_APP_IDS.join(', ')}`);
  }
  assertAppAccess(claims, body.appId);

  // Validate environment
  const env = body.environment ?? 'production';
  if (!['staging', 'production', 'custom'].includes(env)) {
    throw new ValidationError('environment must be staging, production, or custom');
  }
  if (env === 'custom' && !body.customUrl) {
    throw new ValidationError('customUrl is required when environment is "custom"');
  }

  // Validate profile
  const profile: Profile = body.profile ?? 'full';
  if (!Object.keys(PROFILE_DEFAULTS).includes(profile)) {
    throw new ValidationError(`profile must be one of: ${Object.keys(PROFILE_DEFAULTS).join(', ')}`);
  }

  // Validate test type
  const validTestTypes = ['a11y', 'performance', 'form-validation', 'scenario', 'visual-regression', 'full-audit'];
  const testType = body.testType ?? 'a11y';
  if (!validTestTypes.includes(testType)) {
    throw new ValidationError(`testType must be one of: ${validTestTypes.join(', ')}`);
  }

  const testConfig: TestConfig = body.testConfig ?? {};
  const profileDefaults = PROFILE_DEFAULTS[profile];
  const maxAttempts = testConfig.retryPolicy?.maxAttempts ?? profileDefaults.maxAttempts;

  // Rate limit check
  const rlResult = await acquireConcurrencySlot(c.env.RATE_LIMIT_KV, body.appId);
  if (!rlResult.allowed) {
    return c.json(
      {
        error: 'rate_limited',
        message: `App ${body.appId} already has ${String(PROFILE_DEFAULTS.fast.maxAttempts)} runs in-flight (max 3 concurrent)`,
        retryAfterMs: rlResult.retryAfterMs,
      },
      429,
    );
  }

  const runId = await insertRun(c.env.DB.connectionString, {
    appId: body.appId,
    environment: env,
    customUrl: body.customUrl ?? null,
    testType,
    profile,
    testConfig,
    maxAttempts,
    createdBy: claims.sub,
    tags: testConfig.tags ?? [],
    ciContext: body.ciContext ?? null,
    templateId: testConfig.templateId ?? null,
  });

  const estimatedDurationMs = profileDefaults.estimatedMs;
  const dashboardBase = c.env.ENVIRONMENT === 'production'
    ? 'https://qa.latimerwoods.dev'
    : 'https://staging.qa.latimerwoods.dev';

  // Dispatch audit asynchronously — returns immediately with 202
  c.executionCtx.waitUntil(
    runAudit(runId, { ...body, environment: env, profile }, c.env)
      .finally(() => { void releaseConcurrencySlot(c.env.RATE_LIMIT_KV, body.appId); }),
  );

  const rlHeaders = await buildRateLimitHeaders(c.env.RATE_LIMIT_KV, body.appId, claims);

  return c.json(
    {
      runId,
      status: 'pending',
      profile,
      estimatedDurationMs,
      createdAt: new Date().toISOString(),
      pollUrl: `${dashboardBase}/runs/${runId}/status`,
      resultsUrl: `${dashboardBase}/runs/${runId}`,
    },
    202,
    rlHeaders,
  );
});

// ---------------------------------------------------------------------------
// GET /runs — List runs
// ---------------------------------------------------------------------------

runsRouter.get('/', async (c) => {
  const claims = await requireAuth(c.req.header('Authorization'), c.env.QA_TOOLS_JWT_SECRET);
  assertRole(claims, 'qa_viewer');

  const appId = c.req.query('appId');
  if (appId) assertAppAccess(claims, appId);

  // Non-admin viewers are implicitly filtered to their app_ids
  const effectiveAppId = claims.role === 'qa_admin'
    ? appId
    : (appId ?? claims.app_ids?.[0]);

  const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10), 100);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  const { runs, total } = await listRuns(c.env.DB.connectionString, {
    appId: effectiveAppId,
    environment: c.req.query('environment'),
    status: c.req.query('status'),
    limit,
    offset,
  });

  return c.json({ runs, total, limit, offset });
});

// ---------------------------------------------------------------------------
// GET /runs/:id/status — Poll run status
// ---------------------------------------------------------------------------

runsRouter.get('/:id/status', async (c) => {
  const claims = await requireAuth(c.req.header('Authorization'), c.env.QA_TOOLS_JWT_SECRET);

  const run = await getRunById(c.env.DB.connectionString, c.req.param('id'));
  if (!run) throw new NotFoundError('Run not found');
  assertAppAccess(claims, run.app_id);

  const isTerminal = !['pending', 'running'].includes(run.status);

  const response: Record<string, unknown> = {
    runId: run.id,
    status: run.status,
    attemptNumber: run.attempt_number,
    maxAttempts: run.max_attempts,
    profile: run.profile,
  };

  if (!isTerminal) {
    // Approximate progress based on elapsed time vs. estimated duration
    const elapsed = Date.now() - new Date(run.started_at).getTime();
    const profileMs = PROFILE_DEFAULTS[run.profile as Profile]?.estimatedMs ?? 45_000;
    const percent = Math.min(90, Math.round((elapsed / profileMs) * 100));
    response['progress'] = {
      percentComplete: percent,
      estimatedSecondsRemaining: Math.max(0, Math.round((profileMs - elapsed) / 1000)),
      currentPhase: run.status === 'running' ? 'auditing' : 'queued',
    };
  } else {
    response['completedAt'] = run.completed_at;
    response['durationMs'] = run.duration_ms;
    if (run.status === 'failed' || run.status === 'error') {
      response['errorMessage'] = run.error_message;
    }
    if (run.status !== 'error') {
      response['summary'] = {
        totalIssues: run.violations_count,
        passes: run.passes_count,
        warnings: run.warnings_count,
        isRegression: false, // Phase 3: baseline comparison
      };
    }
  }

  return c.json(response);
});

// ---------------------------------------------------------------------------
// GET /runs/:id/results — Detailed findings
// ---------------------------------------------------------------------------

runsRouter.get('/:id/results', async (c) => {
  const claims = await requireAuth(c.req.header('Authorization'), c.env.QA_TOOLS_JWT_SECRET);

  const run = await getRunById(c.env.DB.connectionString, c.req.param('id'));
  if (!run) throw new NotFoundError('Run not found');
  assertAppAccess(claims, run.app_id);

  const rawResults = await getResultsByRunId(c.env.DB.connectionString, run.id);

  // Group results by category for structured response
  const axe = rawResults.filter((r) => r.category === 'axe').map(formatResult);
  const network = rawResults.filter((r) => r.category === 'network').map(formatResult);
  const consoleErrors = rawResults.filter((r) => r.category === 'console-errors').map(formatResult);
  const customAssertions = rawResults.filter((r) => r.category === 'custom-assertion').map(formatResult);

  return c.json({
    runId: run.id,
    appId: run.app_id,
    environment: run.environment,
    testType: run.test_type,
    profile: run.profile,
    status: run.status,
    durationMs: run.duration_ms,
    completedAt: run.completed_at,
    summary: {
      totalViolations: run.violations_count,
      passes: run.passes_count,
      warnings: run.warnings_count,
    },
    results: {
      axe,
      network,
      consoleErrors,
      customAssertions,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /runs/:id/create-issue — Export to GitHub
// ---------------------------------------------------------------------------

runsRouter.post('/:id/create-issue', async (c) => {
  const claims = await requireAuth(c.req.header('Authorization'), c.env.QA_TOOLS_JWT_SECRET);
  assertRole(claims, 'qa_runner');

  if (!c.env.GITHUB_QA_TOKEN) {
    return c.json({ error: 'GitHub integration not configured' }, 503);
  }

  const run = await getRunById(c.env.DB.connectionString, c.req.param('id'));
  if (!run) throw new NotFoundError('Run not found');
  assertAppAccess(claims, run.app_id);

  type IssueBody = { title?: string; severityFilter?: string; assignees?: string[]; labels?: string[]; repo?: string };
  const body: IssueBody = await c.req.json<IssueBody>().catch(() => ({} as IssueBody));

  const rawResults = await getResultsByRunId(c.env.DB.connectionString, run.id);
  const violations = rawResults.filter((r) => {
    if (r.category === 'axe' && r.severity !== 'pass') return true;
    return false;
  });

  const dashboardBase = c.env.ENVIRONMENT === 'production'
    ? 'https://qa.latimerwoods.dev'
    : 'https://staging.qa.latimerwoods.dev';

  const issueTitle = body.title ??
    `QA Finding: [${run.app_id}] ${String(run.violations_count)} violation(s) on ${run.environment}`;

  const violationLines = violations.slice(0, 20).map((v) =>
    `- \`${v.violation_id ?? v.title}\` [${v.severity}]: ${v.description ?? ''} ${v.selector ? `\`${v.selector}\`` : ''}`,
  ).join('\n');

  const issueBody = [
    `**Automated QA audit** found ${String(violations.length)} violation(s) on **${run.app_id}/${run.environment}**.`,
    '',
    `**Run:** ${dashboardBase}/runs/${run.id}`,
    `**Profile:** ${run.profile}`,
    `**Duration:** ${String(run.duration_ms ?? 0)}ms`,
    '',
    '## Violations',
    violationLines || '_No violations details available._',
    '',
    '---',
    '_Created automatically by QA Tools Platform_',
  ].join('\n');

  const repo = body.repo ?? `Latimer-Woods-Tech/${run.app_id}`;
  const ghResponse = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c.env.GITHUB_QA_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'qa-tools-worker/1.0',
    },
    body: JSON.stringify({
      title: issueTitle,
      body: issueBody,
      labels: body.labels ?? ['qa-findings', 'accessibility', run.app_id],
      assignees: body.assignees ?? [],
    }),
  });

  if (!ghResponse.ok) {
    const text = await ghResponse.text().catch(() => '');
    return c.json({ error: `GitHub API error: ${String(ghResponse.status)} ${text}` }, 502);
  }

  const ghIssueJson: unknown = await ghResponse.json();
  const issue = ghIssueJson as { html_url: string; number: number };

  // Store issue URL on the run
  await updateRun(c.env.DB.connectionString, {
    id: run.id,
    status: run.status as 'pending' | 'running' | 'passed' | 'failed' | 'error' | 'flaky',
    githubIssueUrl: issue.html_url,
  });

  return c.json({ issueUrl: issue.html_url, issueNumber: issue.number });
});

// ---------------------------------------------------------------------------
// POST /runs/:id/rerun — Manual rerun
// ---------------------------------------------------------------------------

runsRouter.post('/:id/rerun', async (c) => {
  const claims = await requireAuth(c.req.header('Authorization'), c.env.QA_TOOLS_JWT_SECRET);
  assertRole(claims, 'qa_runner');

  const originalRun = await getRunById(c.env.DB.connectionString, c.req.param('id'));
  if (!originalRun) throw new NotFoundError('Run not found');
  assertAppAccess(claims, originalRun.app_id);

  type RerunBody = { reason?: string; overrideProfile?: Profile };
  const body: RerunBody = await c.req.json<RerunBody>().catch(() => ({} as RerunBody));
  const profile: Profile = body.overrideProfile ?? (originalRun.profile as Profile);
  const profileDefaults = PROFILE_DEFAULTS[profile];

  const rlResult = await acquireConcurrencySlot(c.env.RATE_LIMIT_KV, originalRun.app_id);
  if (!rlResult.allowed) {
    return c.json({ error: 'rate_limited', retryAfterMs: rlResult.retryAfterMs }, 429);
  }

  const request: CreateRunRequest = {
    appId: originalRun.app_id as AppId,
    environment: originalRun.environment as Environment,
    customUrl: originalRun.custom_url,
    testType: originalRun.test_type,
    profile,
    testConfig: originalRun.test_config as TestConfig,
  };

  const newRunId = await insertRun(c.env.DB.connectionString, {
    appId: originalRun.app_id,
    environment: originalRun.environment as Environment,
    customUrl: originalRun.custom_url,
    testType: originalRun.test_type,
    profile,
    testConfig: originalRun.test_config as TestConfig,
    maxAttempts: profileDefaults.maxAttempts,
    parentRunId: originalRun.id,
    attemptNumber: (originalRun.attempt_number ?? 1) + 1,
    createdBy: claims.sub,
  });

  c.executionCtx.waitUntil(
    runAudit(newRunId, request, c.env)
      .finally(() => { void releaseConcurrencySlot(c.env.RATE_LIMIT_KV, originalRun.app_id); }),
  );

  return c.json({ runId: newRunId, status: 'pending', profile, parentRunId: originalRun.id }, 202);
});

// ---------------------------------------------------------------------------
// PATCH /runs/:id/results/:resultId — Acknowledge a finding
// ---------------------------------------------------------------------------

runsRouter.patch('/:id/results/:resultId', async (c) => {
  const claims = await requireAuth(c.req.header('Authorization'), c.env.QA_TOOLS_JWT_SECRET);
  assertRole(claims, 'qa_runner');

  const run = await getRunById(c.env.DB.connectionString, c.req.param('id'));
  if (!run) throw new NotFoundError('Run not found');
  assertAppAccess(claims, run.app_id);

  const body = await c.req.json<{ status: string }>().catch(() => {
    throw new ValidationError('JSON body required');
  });

  const validStatuses = ['open', 'acknowledged', 'fixed', 'false-positive'];
  if (!validStatuses.includes(body.status)) {
    throw new ValidationError(`status must be one of: ${validStatuses.join(', ')}`);
  }

  await updateResultStatus(
    c.env.DB.connectionString,
    c.req.param('resultId'),
    body.status,
    body.status === 'acknowledged' ? claims.sub : undefined,
  );

  return c.json({ status: body.status });
});

// ---------------------------------------------------------------------------
// Response formatter
// ---------------------------------------------------------------------------

function formatResult(r: Awaited<ReturnType<typeof getResultsByRunId>>[0]) {
  return {
    id: r.id,
    category: r.category,
    violationId: r.violation_id,
    severity: r.severity,
    title: r.title,
    description: r.description,
    remediationHint: r.remediation_hint,
    selector: r.selector,
    url: r.url,
    affectedNodes: r.affected_nodes,
    screenshotKey: r.screenshot_key,
    status: r.status,
    isRegression: r.is_regression,
  };
}

export { runsRouter };
