/**
 * Unit tests for lib/audit.ts
 *
 * All I/O dependencies (db, browser-agent, r2) are mocked so tests are
 * fully deterministic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InternalError } from '@latimer-woods-tech/errors';

// ---------------------------------------------------------------------------
// Mocks — hoisted before imports
// ---------------------------------------------------------------------------

vi.mock('../../src/lib/db.js', () => ({
  markRunStarted: vi.fn().mockResolvedValue(undefined),
  updateRun: vi.fn().mockResolvedValue(undefined),
  insertResults: vi.fn().mockResolvedValue(undefined),
  // Phase 2: needed by retry logic
  insertRun: vi.fn().mockResolvedValue('retry-run-id'),
  getRunById: vi.fn().mockResolvedValue({
    id: 'run-id',
    attempt_number: 1,
    max_attempts: 1,  // Default: no retry (maxAttempts=1 stops retry loop)
    created_by: null,
    tags: [],
    ci_context: null,
    template_id: null,
  }),
}));

vi.mock('../../src/lib/phase2-db.js', () => ({
  getCredentialById: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/lib/crypto.js', () => ({
  decryptCredential: vi.fn().mockResolvedValue({ username: 'u', password: 'p' }),
  validateCredentialPayload: vi.fn().mockReturnValue({ username: 'u', password: 'p' }),
}));

vi.mock('../../src/lib/browser-agent.js', () => ({
  dispatchAudit: vi.fn(),
  mapAxeImpact: vi.fn((impact: string | null) => impact ?? 'moderate'),
  buildRemediationHint: vi.fn((help: string, url: string) => (url ? `${help} — ${url}` : help)),
}));

vi.mock('../../src/lib/r2.js', () => ({
  uploadViewportScreenshots: vi.fn().mockResolvedValue({}),
  buildR2Prefix: vi.fn().mockReturnValue('qa-tools/capricast/run-1'),
  validateScreenshotBase64: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { resolveTargetUrl, runAudit } from '../../src/lib/audit.js';
import { markRunStarted, updateRun, insertResults } from '../../src/lib/db.js';
import { dispatchAudit } from '../../src/lib/browser-agent.js';
import type { CreateRunRequest, VisualReviewResult, AxeViolation } from '../../src/types.js';
import type { Env } from '../../src/env.js';
import type { AuditDispatchResult } from '../../src/lib/browser-agent.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: { connectionString: 'postgresql://test:test@localhost/test' },
    QA_TOOLS_R2: {} as unknown as R2Bucket,
    RATE_LIMIT_KV: {} as unknown as KVNamespace,
    QA_TOOLS_JWT_SECRET: 'secret',
    BROWSER_AGENT_SA_KEY: JSON.stringify({
      client_email: 'sa@test.com',
      private_key: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
    }),
    BROWSER_AGENT_URL: 'https://browser-agent.test',
    BROWSER_AGENT_AUDIENCE: 'https://browser-agent.test',
    ENVIRONMENT: 'development',
    ...overrides,
  };
}

const baseRequest: CreateRunRequest = {
  appId: 'capricast',
  environment: 'production',
  testType: 'a11y',
  profile: 'fast',
};

/** A fully valid empty VisualReviewResult. */
const emptyReview: VisualReviewResult = {
  url: 'https://capricast.com',
  reviewedAt: new Date().toISOString(),
  viewports: [],
  consoleErrors: [],
  pageErrors: [],
  failedRequests: [],
  review: null,
  axeViolations: [],
};

function makeDispatchResult(overrides: Partial<VisualReviewResult> = {}, durationMs = 3000): AuditDispatchResult {
  return {
    visualReview: { ...emptyReview, ...overrides },
    durationMs,
  };
}

function makeAxeViolation(overrides: Partial<AxeViolation> = {}): AxeViolation {
  return {
    id: 'color-contrast',
    description: 'Ensure sufficient color contrast',
    impact: 'critical',
    help: 'Fix the color contrast',
    helpUrl: 'https://dequeuniversity.com/rules/axe/4.3/color-contrast',
    tags: ['wcag2aa', 'wcag143'],
    exampleSelectors: ['button.submit'],
    nodeCount: 3,
    viewport: 'desktop',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveTargetUrl
// ---------------------------------------------------------------------------

describe('resolveTargetUrl', () => {
  it('returns customUrl when provided', () => {
    const url = resolveTargetUrl({ ...baseRequest, customUrl: 'https://custom.example.com' });
    expect(url).toBe('https://custom.example.com');
  });

  it('returns production URL for capricast', () => {
    const url = resolveTargetUrl({ ...baseRequest, environment: 'production' });
    expect(url).toBe('https://capricast.com');
  });

  it('returns staging URL for selfprime', () => {
    const url = resolveTargetUrl({ ...baseRequest, appId: 'selfprime', environment: 'staging' });
    expect(url).toBe('https://staging.selfprime.net');
  });

  it('returns production URL for all four apps', () => {
    const apps: CreateRunRequest['appId'][] = ['selfprime', 'capricast', 'cipherofhealing', 'xicocity'];
    for (const appId of apps) {
      const url = resolveTargetUrl({ ...baseRequest, appId, environment: 'production' });
      expect(url.startsWith('https://')).toBe(true);
    }
  });

  it('throws InternalError for custom environment without customUrl', () => {
    expect(() => resolveTargetUrl({ ...baseRequest, environment: 'custom' })).toThrow(InternalError);
  });
});

// ---------------------------------------------------------------------------
// runAudit
// ---------------------------------------------------------------------------

describe('runAudit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(markRunStarted).mockResolvedValue(undefined);
    vi.mocked(updateRun).mockResolvedValue(undefined);
    vi.mocked(insertResults).mockResolvedValue(undefined);
  });

  it('marks run started then updates to passed with no violations', async () => {
    vi.mocked(dispatchAudit).mockResolvedValue(makeDispatchResult());

    await runAudit('run-1', baseRequest, makeEnv());

    expect(markRunStarted).toHaveBeenCalledWith(
      'postgresql://test:test@localhost/test',
      'run-1',
    );
    expect(updateRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ id: 'run-1', status: 'passed' }),
    );
  });

  it('sets status to failed when critical axe violations exist', async () => {
    vi.mocked(dispatchAudit).mockResolvedValue(
      makeDispatchResult({ axeViolations: [makeAxeViolation({ impact: 'critical' })] }),
    );

    await runAudit('run-2', baseRequest, makeEnv());

    expect(updateRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('normalizes console errors and network failures into results', async () => {
    vi.mocked(dispatchAudit).mockResolvedValue(
      makeDispatchResult({
        consoleErrors: [
          { type: 'error', text: 'Uncaught TypeError: cannot read property', location: 'app.js:100' },
          { type: 'warning', text: 'Deprecated API', location: 'app.js:200' },
        ],
        failedRequests: [
          { method: 'GET', url: 'https://api.capricast.com/data', status: 500 },
          { method: 'POST', url: 'https://api.capricast.com/track', status: 400 },
        ],
      }),
    );

    await runAudit('run-3', baseRequest, makeEnv());

    expect(insertResults).toHaveBeenCalledOnce();
    const [_conn, results] = vi.mocked(insertResults).mock.calls[0]!;
    // 2 console errors + 2 network failures = 4 results
    expect(results).toHaveLength(4);
    // 500 → 'serious' severity
    const serverError = results.find((r) => r.violationId === 'http-500');
    expect(serverError?.severity).toBe('serious');
    // 400 → 'minor' severity
    const clientError = results.find((r) => r.violationId === 'http-400');
    expect(clientError?.severity).toBe('minor');
  });

  it('truncates console errors and network requests to 20 each', async () => {
    vi.mocked(dispatchAudit).mockResolvedValue(
      makeDispatchResult({
        consoleErrors: Array.from({ length: 25 }, (_, i) => ({
          type: 'error' as const,
          text: `Error ${String(i)}`,
          location: `app.js:${String(i)}`,
        })),
        failedRequests: Array.from({ length: 25 }, (_, i) => ({
          method: 'GET',
          url: `https://api.example.com/path-${String(i)}`,
          status: 404,
        })),
      }),
    );

    await runAudit('run-4', baseRequest, makeEnv());

    const [_conn, results] = vi.mocked(insertResults).mock.calls[0]!;
    expect(results).toHaveLength(40); // 20 + 20
  });

  it('updates run to error status when browser-agent throws', async () => {
    vi.mocked(dispatchAudit).mockRejectedValue(new Error('browser-agent timeout'));

    await runAudit('run-5', baseRequest, makeEnv());

    expect(updateRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        status: 'error',
        errorMessage: expect.stringContaining('timeout'),
      }),
    );
  });

  it('never throws even when DB updateRun fails on error path', async () => {
    vi.mocked(dispatchAudit).mockRejectedValue(new Error('boom'));
    vi.mocked(updateRun).mockRejectedValue(new Error('DB also down'));

    await expect(runAudit('run-6', baseRequest, makeEnv())).resolves.toBeUndefined();
  });

  it('respects violationsMax threshold from testConfig', async () => {
    vi.mocked(dispatchAudit).mockResolvedValue(
      makeDispatchResult({
        axeViolations: [
          makeAxeViolation({ id: 'a', impact: 'minor' }),
          makeAxeViolation({ id: 'b', impact: 'minor' }),
          makeAxeViolation({ id: 'c', impact: 'minor' }),
        ],
      }),
    );

    // violationsMax = 2 → should fail because 3 > 2
    await runAudit('run-7', {
      ...baseRequest,
      testConfig: { thresholds: { violationsMax: 2 } },
    }, makeEnv());

    expect(updateRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('passes when violations ≤ violationsMax', async () => {
    vi.mocked(dispatchAudit).mockResolvedValue(
      makeDispatchResult({
        axeViolations: [
          makeAxeViolation({ id: 'a', impact: 'minor' }),
        ],
      }),
    );

    // violationsMax = 2 → 1 violation → should pass
    await runAudit('run-7b', {
      ...baseRequest,
      testConfig: { thresholds: { violationsMax: 2 } },
    }, makeEnv());

    expect(updateRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'passed' }),
    );
  });

  it('sends Slack notification when configured and audit fails', async () => {
    vi.mocked(dispatchAudit).mockResolvedValue(
      makeDispatchResult({ axeViolations: [makeAxeViolation({ impact: 'critical' })] }),
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );

    await runAudit('run-8', {
      ...baseRequest,
      testConfig: { notifyOnComplete: ['slack'] },
    }, makeEnv({ SLACK_QA_WEBHOOK_URL: 'https://hooks.slack.com/test' }));

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://hooks.slack.com/test',
      expect.objectContaining({ method: 'POST' }),
    );

    fetchSpy.mockRestore();
  });

  it('does not send Slack when run passes', async () => {
    vi.mocked(dispatchAudit).mockResolvedValue(makeDispatchResult());

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await runAudit('run-9', {
      ...baseRequest,
      testConfig: { notifyOnComplete: ['slack'] },
    }, makeEnv({ SLACK_QA_WEBHOOK_URL: 'https://hooks.slack.com/test' }));

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('uploads screenshots when viewports have base64 data', async () => {
    const { uploadViewportScreenshots } = await import('../../src/lib/r2.js');

    vi.mocked(dispatchAudit).mockResolvedValue(
      makeDispatchResult({
        viewports: [
          { viewport: 'desktop', width: 1280, height: 720, screenshotBase64: btoa('PNG screenshot data') },
        ],
      }),
    );

    await runAudit('run-10', baseRequest, makeEnv());

    expect(uploadViewportScreenshots).toHaveBeenCalledOnce();
  });
});
