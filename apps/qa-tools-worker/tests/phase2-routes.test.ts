/**
 * Integration tests for Phase 2 route handlers.
 *
 * Tests: /credentials, /templates, /notifications
 *
 * All external dependencies (DB, crypto) are mocked — no real DB required.
 * Uses the full Hono app so middleware (auth, error handling) is exercised.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — hoisted by Vitest before any import below
// ---------------------------------------------------------------------------

vi.mock('../src/lib/phase2-db.js', () => ({
  insertCredential: vi.fn(),
  listCredentials: vi.fn(),
  getCredentialById: vi.fn(),
  deleteCredential: vi.fn(),
  insertTemplate: vi.fn(),
  listTemplates: vi.fn(),
  getTemplateById: vi.fn(),
  deleteTemplate: vi.fn(),
  upsertNotificationPref: vi.fn(),
  getNotificationPref: vi.fn(),
  listNotificationPrefs: vi.fn(),
}));

vi.mock('../src/lib/crypto.js', () => ({
  encryptCredential: vi.fn().mockResolvedValue('aabbcc112233:deadbeef'),
  decryptCredential: vi.fn().mockResolvedValue({
    username: 'qa@example.com',
    password: 'p4ss',
    mfaSecret: 'SECRET',
  }),
  validateCredentialPayload: vi.fn().mockImplementation((raw: unknown) => {
    const p = raw as Record<string, unknown>;
    return { username: p['username'], password: p['password'] };
  }),
}));

// The audit and DB mocks are needed because the main app also imports them.
vi.mock('../src/lib/db.js', () => ({
  insertRun: vi.fn(),
  updateRun: vi.fn(),
  markRunStarted: vi.fn(),
  getRunById: vi.fn(),
  listRuns: vi.fn(),
  getLatestRun: vi.fn(),
  countOpenViolations: vi.fn(),
  insertResults: vi.fn(),
  getResultsByRunId: vi.fn(),
  updateResultStatus: vi.fn(),
}));

vi.mock('../src/lib/audit.js', () => ({
  runAudit: vi.fn().mockResolvedValue(undefined),
  resolveTargetUrl: vi.fn().mockReturnValue('https://capricast.com'),
}));

// ---------------------------------------------------------------------------
// Imports (after mock setup)
// ---------------------------------------------------------------------------

import app from '../src/index.js';
import { mintQaJwt } from '../src/middleware/auth.js';
import {
  insertCredential,
  listCredentials,
  getCredentialById,
  deleteCredential,
  insertTemplate,
  listTemplates,
  getTemplateById,
  deleteTemplate,
  upsertNotificationPref,
  getNotificationPref,
  listNotificationPrefs,
} from '../src/lib/phase2-db.js';
import { encryptCredential, decryptCredential, validateCredentialPayload } from '../src/lib/crypto.js';

// ---------------------------------------------------------------------------
// Constants + helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = 'test-secret-for-unit-tests';
const NOW_S = Math.floor(Date.now() / 1000);

const MOCK_ENV = {
  DB: { connectionString: 'postgresql://user:pass@host/db' },
  QA_TOOLS_R2: {},
  RATE_LIMIT_KV: {},
  QA_TOOLS_JWT_SECRET: TEST_SECRET,
  BROWSER_AGENT_SA_KEY: '{}',
  BROWSER_AGENT_URL: 'https://browser.example.com',
  BROWSER_AGENT_AUDIENCE: 'https://browser.example.com',
  QA_TOOLS_ENCRYPT_KEY: 'a'.repeat(64),
  ENVIRONMENT: 'test',
};

async function makeToken(role: string, sub = 'user-sub'): Promise<string> {
  return mintQaJwt(
    { sub, email: `${role}@example.com`, role: role as 'qa_admin', exp: NOW_S + 3600 },
    TEST_SECRET,
  );
}

async function req(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    MOCK_ENV,
  );
}

// ---------------------------------------------------------------------------
// Credential fixtures
// ---------------------------------------------------------------------------

const credRow = {
  id: 'cred-1',
  app_id: 'capricast',
  environment: 'production',
  label: 'QA Admin',
  encrypted_payload: 'aabbcc112233:deadbeef',
  username_hint: 'qa+***@example.com',
  last_used_at: null,
  last_used_by: null,
  created_by: 'user-sub',
  created_at: '2026-05-27T00:00:00Z',
  updated_at: '2026-05-27T00:00:00Z',
};

// ---------------------------------------------------------------------------
// /credentials
// ---------------------------------------------------------------------------

describe('POST /credentials', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a credential and returns 201', async () => {
    vi.mocked(validateCredentialPayload).mockReturnValue({ username: 'qa@example.com', password: 'pw' });
    vi.mocked(encryptCredential).mockResolvedValue('iv:ct');
    vi.mocked(insertCredential).mockResolvedValue(credRow);

    const token = await makeToken('qa_admin');
    const res = await req('POST', '/credentials', token, {
      appId: 'capricast',
      environment: 'production',
      label: 'QA Admin',
      username: 'qa@example.com',
      password: 'pw',
    });

    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body['id']).toBe('cred-1');
    expect(body['usernameHint']).toBe('qa+***@example.com');
    // encrypted_payload must never be in response
    expect(body['encrypted_payload']).toBeUndefined();
    expect(body['encryptedPayload']).toBeUndefined();
  });

  it('returns 422 when appId is missing', async () => {
    const token = await makeToken('qa_admin');
    const res = await req('POST', '/credentials', token, {
      environment: 'production',
      label: 'x',
      username: 'u',
      password: 'p',
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 when environment is invalid', async () => {
    const token = await makeToken('qa_admin');
    const res = await req('POST', '/credentials', token, {
      appId: 'capricast',
      environment: 'invalid',
      label: 'x',
      username: 'u',
      password: 'p',
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 when QA_TOOLS_ENCRYPT_KEY is missing', async () => {
    const token = await makeToken('qa_admin');
    const res = await app.fetch(
      new Request('http://localhost/credentials', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appId: 'capricast',
          environment: 'production',
          label: 'x',
          username: 'u',
          password: 'p',
        }),
      }),
      { ...MOCK_ENV, QA_TOOLS_ENCRYPT_KEY: undefined },
    );
    expect(res.status).toBe(422);
  });

  it('returns 401 for non-admin role', async () => {
    const token = await makeToken('qa_viewer');
    const res = await req('POST', '/credentials', token, {
      appId: 'capricast',
      environment: 'production',
      label: 'x',
      username: 'u',
      password: 'p',
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /credentials', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns credential list', async () => {
    const { encrypted_payload: _enc, ...rest } = credRow;
    vi.mocked(listCredentials).mockResolvedValue([rest]);

    const token = await makeToken('qa_admin');
    const res = await req('GET', '/credentials?appId=capricast', token);
    expect(res.status).toBe(200);
    const body = await res.json() as { credentials: unknown[] };
    expect(body.credentials).toHaveLength(1);
  });

  it('returns 422 when appId query param is missing', async () => {
    const token = await makeToken('qa_admin');
    const res = await req('GET', '/credentials', token);
    expect(res.status).toBe(422);
  });
});

describe('GET /credentials/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns credential metadata without encrypted_payload', async () => {
    vi.mocked(getCredentialById).mockResolvedValue(credRow);

    const token = await makeToken('qa_admin');
    const res = await req('GET', '/credentials/cred-1', token);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['id']).toBe('cred-1');
    expect(body['encryptedPayload']).toBeUndefined();
  });

  it('returns 404 when credential not found', async () => {
    vi.mocked(getCredentialById).mockResolvedValue(null);

    const token = await makeToken('qa_admin');
    const res = await req('GET', '/credentials/missing', token);
    expect(res.status).toBe(404);
  });
});

describe('DELETE /credentials/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes and returns { deleted: true }', async () => {
    vi.mocked(deleteCredential).mockResolvedValue(true);

    const token = await makeToken('qa_admin');
    const res = await req('DELETE', '/credentials/cred-1', token);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['deleted']).toBe(true);
  });

  it('returns 404 when credential not found', async () => {
    vi.mocked(deleteCredential).mockResolvedValue(false);

    const token = await makeToken('qa_admin');
    const res = await req('DELETE', '/credentials/missing', token);
    expect(res.status).toBe(404);
  });
});

describe('POST /credentials/:id/test', () => {
  beforeEach(() => vi.clearAllMocks());

  it('verifies decrypt and returns username + flags', async () => {
    vi.mocked(getCredentialById).mockResolvedValue(credRow);
    vi.mocked(decryptCredential).mockResolvedValue({
      username: 'qa@example.com',
      password: 'secret',
      mfaSecret: 'MFA',
    });

    const token = await makeToken('qa_admin');
    const res = await req('POST', '/credentials/cred-1/test', token);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(body['username']).toBe('qa@example.com');
    expect(body['hasMfa']).toBe(true);
    // password must never appear in response
    expect(body['password']).toBeUndefined();
  });

  it('returns 404 when credential not found', async () => {
    vi.mocked(getCredentialById).mockResolvedValue(null);

    const token = await makeToken('qa_admin');
    const res = await req('POST', '/credentials/missing/test', token);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// /templates
// ---------------------------------------------------------------------------

const templateRow = {
  id: 'tmpl-1',
  name: 'WCAG 2 AA Audit',
  description: 'Full a11y audit',
  app_id: null,
  test_type: 'a11y',
  profile: 'a11y',
  test_config: {},
  is_ci_default: false,
  ci_fail_on_regression: true,
  thresholds: { violations_max: 0 },
  created_by: null,
  is_system: true,
  created_at: '2026-05-27T00:00:00Z',
  updated_at: '2026-05-27T00:00:00Z',
};

describe('POST /templates', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a template and returns 201', async () => {
    const custom = { ...templateRow, id: 'tmpl-custom', is_system: false };
    vi.mocked(insertTemplate).mockResolvedValue(custom);

    const token = await makeToken('qa_admin');
    const res = await req('POST', '/templates', token, {
      name: 'My Template',
      testType: 'a11y',
      profile: 'full',
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body['id']).toBe('tmpl-custom');
    expect(body['isSystem']).toBe(false);
  });

  it('returns 422 when name is missing', async () => {
    const token = await makeToken('qa_admin');
    const res = await req('POST', '/templates', token, { testType: 'a11y' });
    expect(res.status).toBe(422);
  });

  it('returns 422 for invalid testType', async () => {
    const token = await makeToken('qa_admin');
    const res = await req('POST', '/templates', token, {
      name: 'x',
      testType: 'invalid-type',
    });
    expect(res.status).toBe(422);
  });

  it('returns 401 for qa_viewer', async () => {
    const token = await makeToken('qa_viewer');
    const res = await req('POST', '/templates', token, { name: 'x', testType: 'a11y' });
    expect(res.status).toBe(401);
  });
});

describe('GET /templates', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns template list', async () => {
    vi.mocked(listTemplates).mockResolvedValue([templateRow]);

    const token = await makeToken('qa_viewer');
    const res = await req('GET', '/templates?appId=capricast', token);
    expect(res.status).toBe(200);
    const body = await res.json() as { templates: unknown[] };
    expect(body.templates).toHaveLength(1);
  });
});

describe('GET /templates/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the template', async () => {
    vi.mocked(getTemplateById).mockResolvedValue(templateRow);

    const token = await makeToken('qa_viewer');
    const res = await req('GET', '/templates/tmpl-1', token);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['name']).toBe('WCAG 2 AA Audit');
    expect(body['isSystem']).toBe(true);
  });

  it('returns 404 when not found', async () => {
    vi.mocked(getTemplateById).mockResolvedValue(null);

    const token = await makeToken('qa_viewer');
    const res = await req('GET', '/templates/missing', token);
    expect(res.status).toBe(404);
  });
});

describe('DELETE /templates/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes a custom template', async () => {
    vi.mocked(deleteTemplate).mockResolvedValue(true);

    const token = await makeToken('qa_admin');
    const res = await req('DELETE', '/templates/tmpl-custom', token);
    expect(res.status).toBe(200);
    expect((await res.json() as Record<string, unknown>)['deleted']).toBe(true);
  });

  it('returns 404 when template not found', async () => {
    vi.mocked(deleteTemplate).mockResolvedValue(false);

    const token = await makeToken('qa_admin');
    const res = await req('DELETE', '/templates/missing', token);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// /notifications
// ---------------------------------------------------------------------------

const prefRow = {
  id: 'pref-1',
  app_id: 'capricast',
  environment: 'production',
  slack_webhook_url: 'https://hooks.slack.com/x',
  slack_channel: '#qa',
  github_assignees: [],
  auto_create_github_issue: false,
  github_repo: null,
  github_labels: ['qa-findings'],
  notify_on_pass: false,
  notify_on_fail: true,
  notify_on_regression: true,
  daily_digest_enabled: true,
  daily_digest_hour: 9,
  min_severity_to_notify: 'serious',
  created_at: '2026-05-27T00:00:00Z',
  updated_at: '2026-05-27T00:00:00Z',
};

describe('GET /notifications (single pref)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns pref for a specific environment', async () => {
    vi.mocked(getNotificationPref).mockResolvedValue(prefRow);

    const token = await makeToken('qa_admin');
    const res = await req('GET', '/notifications?appId=capricast&environment=production', token);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['appId']).toBe('capricast');
    expect((body['slack'] as Record<string, unknown>)['channel']).toBe('#qa');
  });

  it('returns 404 when pref not found', async () => {
    vi.mocked(getNotificationPref).mockResolvedValue(null);

    const token = await makeToken('qa_admin');
    const res = await req('GET', '/notifications?appId=capricast&environment=staging', token);
    expect(res.status).toBe(404);
  });

  it('returns 422 for invalid environment value', async () => {
    const token = await makeToken('qa_admin');
    const res = await req('GET', '/notifications?appId=capricast&environment=bad', token);
    expect(res.status).toBe(422);
  });
});

describe('GET /notifications (list)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns all prefs for an app', async () => {
    vi.mocked(listNotificationPrefs).mockResolvedValue([prefRow]);

    const token = await makeToken('qa_admin');
    const res = await req('GET', '/notifications?appId=capricast', token);
    expect(res.status).toBe(200);
    const body = await res.json() as { prefs: unknown[] };
    expect(body.prefs).toHaveLength(1);
  });

  it('returns 422 when appId is missing', async () => {
    const token = await makeToken('qa_admin');
    const res = await req('GET', '/notifications', token);
    expect(res.status).toBe(422);
  });
});

describe('PUT /notifications', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upserts and returns the pref', async () => {
    vi.mocked(upsertNotificationPref).mockResolvedValue(prefRow);

    const token = await makeToken('qa_admin');
    const res = await req('PUT', '/notifications', token, {
      appId: 'capricast',
      environment: 'production',
      slackWebhookUrl: 'https://hooks.slack.com/x',
      slackChannel: '#qa',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['appId']).toBe('capricast');
  });

  it('returns 422 when appId is missing', async () => {
    const token = await makeToken('qa_admin');
    const res = await req('PUT', '/notifications', token, { environment: 'production' });
    expect(res.status).toBe(422);
  });

  it('returns 422 for invalid environment', async () => {
    const token = await makeToken('qa_admin');
    const res = await req('PUT', '/notifications', token, {
      appId: 'capricast',
      environment: 'bad-env',
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 for invalid dailyDigestHour', async () => {
    const token = await makeToken('qa_admin');
    const res = await req('PUT', '/notifications', token, {
      appId: 'capricast',
      environment: 'production',
      dailyDigestHour: 25,
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 for invalid minSeverityToNotify', async () => {
    const token = await makeToken('qa_admin');
    const res = await req('PUT', '/notifications', token, {
      appId: 'capricast',
      environment: 'production',
      minSeverityToNotify: 'invalid',
    });
    expect(res.status).toBe(422);
  });

  it('returns 401 for qa_viewer', async () => {
    const token = await makeToken('qa_viewer');
    const res = await req('PUT', '/notifications', token, {
      appId: 'capricast',
      environment: 'production',
    });
    expect(res.status).toBe(401);
  });

  it('returns 422 when slackWebhookUrl is not string or null', async () => {
    const token = await makeToken('qa_admin');
    const res = await req('PUT', '/notifications', token, {
      appId: 'capricast',
      environment: 'production',
      slackWebhookUrl: 12345,
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 when githubAssignees is not an array', async () => {
    const token = await makeToken('qa_admin');
    const res = await req('PUT', '/notifications', token, {
      appId: 'capricast',
      environment: 'production',
      githubAssignees: 'not-an-array',
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 when githubLabels is not an array', async () => {
    const token = await makeToken('qa_admin');
    const res = await req('PUT', '/notifications', token, {
      appId: 'capricast',
      environment: 'production',
      githubLabels: 'not-an-array',
    });
    expect(res.status).toBe(422);
  });

  it('accepts null slackWebhookUrl to clear the webhook', async () => {
    vi.mocked(upsertNotificationPref).mockResolvedValue({
      ...prefRow,
      slack_webhook_url: null,
    });
    const token = await makeToken('qa_admin');
    const res = await req('PUT', '/notifications', token, {
      appId: 'capricast',
      environment: 'production',
      slackWebhookUrl: null,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect((body['slack'] as Record<string, unknown>)['webhookUrl']).toBeNull();
  });

  it('accepts all optional fields at once', async () => {
    vi.mocked(upsertNotificationPref).mockResolvedValue(prefRow);
    const token = await makeToken('qa_admin');
    const res = await req('PUT', '/notifications', token, {
      appId: 'capricast',
      environment: 'production',
      slackWebhookUrl: 'https://hooks.slack.com/x',
      slackChannel: '#qa',
      githubAssignees: ['adrper79'],
      autoCreateGithubIssue: true,
      githubRepo: 'Latimer-Woods-Tech/capricast',
      githubLabels: ['qa-findings'],
      notifyOnPass: false,
      notifyOnFail: true,
      notifyOnRegression: true,
      dailyDigestEnabled: true,
      dailyDigestHour: 8,
      minSeverityToNotify: 'critical',
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Template POST — additional branch coverage
// ---------------------------------------------------------------------------

describe('POST /templates — branch coverage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 422 for invalid profile', async () => {
    const token = await makeToken('qa_admin');
    const res = await req('POST', '/templates', token, {
      name: 'x',
      testType: 'a11y',
      profile: 'super-fast-invalid',
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 when testConfig is an array', async () => {
    const token = await makeToken('qa_admin');
    const res = await req('POST', '/templates', token, {
      name: 'x',
      testType: 'a11y',
      testConfig: ['bad'],
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 when thresholds is an array', async () => {
    const token = await makeToken('qa_admin');
    const res = await req('POST', '/templates', token, {
      name: 'x',
      testType: 'a11y',
      thresholds: [0],
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 when testType is missing', async () => {
    const token = await makeToken('qa_admin');
    const res = await req('POST', '/templates', token, { name: 'x' });
    expect(res.status).toBe(422);
  });

  it('accepts valid testConfig and thresholds objects', async () => {
    const custom = {
      id: 'tmpl-c2',
      name: 'Custom With Config',
      description: null,
      app_id: 'capricast',
      test_type: 'a11y',
      profile: 'fast',
      test_config: { checks: ['axe-core'] },
      is_ci_default: true,
      ci_fail_on_regression: false,
      thresholds: { violations_max: 5 },
      created_by: 'user-sub',
      is_system: false,
      created_at: '2026-05-27T00:00:00Z',
      updated_at: '2026-05-27T00:00:00Z',
    };
    vi.mocked(insertTemplate).mockResolvedValue(custom);

    const token = await makeToken('qa_admin');
    const res = await req('POST', '/templates', token, {
      name: 'Custom With Config',
      testType: 'a11y',
      profile: 'fast',
      appId: 'capricast',
      testConfig: { checks: ['axe-core'] },
      isCiDefault: true,
      ciFail: false,
      thresholds: { violations_max: 5 },
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body['isCiDefault']).toBe(true);
    expect(body['ciFail']).toBe(false);
  });
});
