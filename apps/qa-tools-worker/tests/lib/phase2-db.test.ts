/**
 * Unit tests for lib/phase2-db.ts
 *
 * @neondatabase/serverless is mocked — no real DB connection required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { neon } from '@neondatabase/serverless';

vi.mock('@neondatabase/serverless', () => ({
  neon: vi.fn(),
}));

import {
  insertCredential,
  listCredentials,
  getCredentialById,
  deleteCredential,
  touchCredentialUsage,
  insertTemplate,
  listTemplates,
  getTemplateById,
  deleteTemplate,
  upsertNotificationPref,
  getNotificationPref,
  listNotificationPrefs,
} from '../../src/lib/phase2-db.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONN = 'postgresql://user:pass@host/db';

type SqlFn = ReturnType<typeof vi.fn>;

/** Returns a mock sql function that returns the given rows on any call. */
function mockSql(rows: unknown[]): SqlFn {
  const fn = vi.fn().mockResolvedValue(rows);
  vi.mocked(neon).mockReturnValue(fn as unknown as ReturnType<typeof neon>);
  return fn;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sampleCredRow = {
  id: 'cred-1',
  app_id: 'capricast',
  environment: 'production',
  label: 'QA Admin',
  encrypted_payload: 'iv:ct',
  username_hint: 'qa+***@example.com',
  last_used_at: null,
  last_used_by: null,
  created_by: 'user-sub',
  created_at: '2026-05-27T00:00:00Z',
  updated_at: '2026-05-27T00:00:00Z',
};

const sampleTemplateRow = {
  id: 'tmpl-1',
  name: 'WCAG 2 AA Audit',
  description: 'Full accessibility audit',
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

const samplePrefRow = {
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

// ---------------------------------------------------------------------------
// Credential tests
// ---------------------------------------------------------------------------

describe('insertCredential', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the created row', async () => {
    mockSql([sampleCredRow]);
    const row = await insertCredential(CONN, {
      appId: 'capricast',
      environment: 'production',
      label: 'QA Admin',
      encryptedPayload: 'iv:ct',
      usernameHint: 'qa+***@example.com',
      createdBy: 'user-sub',
    });
    expect(row.id).toBe('cred-1');
    expect(row.encrypted_payload).toBe('iv:ct');
  });

  it('throws when DB returns no row', async () => {
    mockSql([]);
    await expect(
      insertCredential(CONN, {
        appId: 'x',
        environment: 'staging',
        label: 'y',
        encryptedPayload: 'z',
      }),
    ).rejects.toThrow('insertCredential returned no row');
  });
});

describe('listCredentials', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns rows without encrypted_payload when filtering by environment', async () => {
    const { encrypted_payload: _enc, ...rest } = sampleCredRow;
    mockSql([rest]);
    const rows = await listCredentials(CONN, 'capricast', 'production');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('cred-1');
  });

  it('returns rows without environment filter', async () => {
    const { encrypted_payload: _enc, ...rest } = sampleCredRow;
    mockSql([rest]);
    const rows = await listCredentials(CONN, 'capricast');
    expect(rows).toHaveLength(1);
  });
});

describe('getCredentialById', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the credential row with encrypted_payload', async () => {
    mockSql([sampleCredRow]);
    const row = await getCredentialById(CONN, 'cred-1');
    expect(row?.encrypted_payload).toBe('iv:ct');
  });

  it('returns null when not found', async () => {
    mockSql([]);
    const row = await getCredentialById(CONN, 'missing');
    expect(row).toBeNull();
  });
});

describe('deleteCredential', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when a row was deleted', async () => {
    mockSql([{ id: 'cred-1' }]);
    expect(await deleteCredential(CONN, 'cred-1')).toBe(true);
  });

  it('returns false when nothing was deleted', async () => {
    mockSql([]);
    expect(await deleteCredential(CONN, 'missing')).toBe(false);
  });
});

describe('touchCredentialUsage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('executes an UPDATE without throwing', async () => {
    mockSql([]);
    await expect(touchCredentialUsage(CONN, 'cred-1', 'user-sub')).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Template tests
// ---------------------------------------------------------------------------

describe('insertTemplate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the created template row', async () => {
    const customTemplate = { ...sampleTemplateRow, id: 'tmpl-custom', is_system: false };
    mockSql([customTemplate]);
    const row = await insertTemplate(CONN, {
      name: 'My Template',
      testType: 'a11y',
      profile: 'full',
      createdBy: 'user-sub',
    });
    expect(row.id).toBe('tmpl-custom');
    expect(row.is_system).toBe(false);
  });

  it('throws when DB returns no row', async () => {
    mockSql([]);
    await expect(
      insertTemplate(CONN, { name: 'x', testType: 'a11y', profile: 'full' }),
    ).rejects.toThrow('insertTemplate returned no row');
  });
});

describe('listTemplates', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns templates when appId is provided', async () => {
    mockSql([sampleTemplateRow]);
    const rows = await listTemplates(CONN, 'capricast');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_system).toBe(true);
  });

  it('returns all templates when no appId', async () => {
    mockSql([sampleTemplateRow]);
    const rows = await listTemplates(CONN);
    expect(rows).toHaveLength(1);
  });
});

describe('getTemplateById', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the template', async () => {
    mockSql([sampleTemplateRow]);
    const row = await getTemplateById(CONN, 'tmpl-1');
    expect(row?.name).toBe('WCAG 2 AA Audit');
  });

  it('returns null when not found', async () => {
    mockSql([]);
    expect(await getTemplateById(CONN, 'missing')).toBeNull();
  });
});

describe('deleteTemplate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns false when template does not exist', async () => {
    // First call (SELECT is_system) returns []
    const fn = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([]);
    vi.mocked(neon).mockReturnValue(fn as unknown as ReturnType<typeof neon>);
    expect(await deleteTemplate(CONN, 'missing')).toBe(false);
  });

  it('throws NotFoundError when template is a system template', async () => {
    const fn = vi.fn()
      .mockResolvedValueOnce([{ is_system: true }])
      .mockResolvedValue([]);
    vi.mocked(neon).mockReturnValue(fn as unknown as ReturnType<typeof neon>);
    await expect(deleteTemplate(CONN, 'sys-id')).rejects.toThrow('system template');
  });

  it('returns true when custom template is deleted', async () => {
    const fn = vi.fn()
      .mockResolvedValueOnce([{ is_system: false }])
      .mockResolvedValue([{ id: 'tmpl-custom' }]);
    vi.mocked(neon).mockReturnValue(fn as unknown as ReturnType<typeof neon>);
    expect(await deleteTemplate(CONN, 'tmpl-custom')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Notification pref tests
// ---------------------------------------------------------------------------

describe('upsertNotificationPref', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the upserted row', async () => {
    mockSql([samplePrefRow]);
    const row = await upsertNotificationPref(CONN, {
      appId: 'capricast',
      environment: 'production',
      slackWebhookUrl: 'https://hooks.slack.com/x',
    });
    expect(row.app_id).toBe('capricast');
    expect(row.slack_webhook_url).toBe('https://hooks.slack.com/x');
  });

  it('throws when DB returns no row', async () => {
    mockSql([]);
    await expect(
      upsertNotificationPref(CONN, { appId: 'x', environment: 'staging' }),
    ).rejects.toThrow('upsertNotificationPref returned no row');
  });
});

describe('getNotificationPref', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the pref when found', async () => {
    mockSql([samplePrefRow]);
    const row = await getNotificationPref(CONN, 'capricast', 'production');
    expect(row?.min_severity_to_notify).toBe('serious');
  });

  it('returns null when not found', async () => {
    mockSql([]);
    expect(await getNotificationPref(CONN, 'capricast', 'staging')).toBeNull();
  });
});

describe('listNotificationPrefs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns all prefs for an app', async () => {
    mockSql([samplePrefRow]);
    const rows = await listNotificationPrefs(CONN, 'capricast');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.environment).toBe('production');
  });
});
