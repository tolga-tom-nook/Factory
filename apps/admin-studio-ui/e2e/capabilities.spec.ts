import { expect, test } from '@playwright/test';

const token = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'eyJ1c2VySWQiOiJ1c2VyXzEiLCJ1c2VyRW1haWwiOiJvcGVyYXRvckBmYWN0b3J5LmRldiIsInJvbGUiOiJhZG1pbiJ9',
  'signature',
].join('.');

function json(data: unknown) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(data),
  };
}

// Minimal fixtures matching the real backend contract from
// apps/admin-studio/src/routes/capabilities.ts. The Playwright test mocks
// the API surface so the staged workflow can be driven end-to-end without
// a live Worker.

const recipeFixture = {
  id: 'outbound-dialer-importer',
  summary: 'Outbound dialer workflow with CSV import landing and ingestion flow.',
  goal: 'Launch governed outbound calling for imported contact lists.',
  maturity: 'beta',
  primitives: ['telephony', 'crm', 'analytics'],
  optionalPrimitives: ['compliance'],
  expectedSurfaces: ['/health', '/api/campaigns', '/api/imports'],
  smokeChecks: [
    { path: '/health', expectedStatus: 200, expectContains: 'ok' },
    { path: '/api/imports', expectedStatus: 200 },
  ],
};

const planFixture = {
  schemaVersion: '1.0.0',
  kind: 'plan',
  recipe: {
    id: recipeFixture.id,
    version: '1.0.0',
    maturity: recipeFixture.maturity,
    summary: recipeFixture.summary,
    goal: recipeFixture.goal,
  },
  packages: [
    { primitiveId: 'analytics', package: '@latimer-woods-tech/analytics', versionRange: '^0.1.0' },
    { primitiveId: 'crm', package: '@latimer-woods-tech/crm', versionRange: '^0.1.0' },
    { primitiveId: 'telephony', package: '@latimer-woods-tech/telephony', versionRange: '^0.1.0' },
  ],
  env: {
    secrets: ['CRM_API_KEY', 'IMPORT_BUCKET_TOKEN', 'JWT_SECRET'],
    vars: ['ENVIRONMENT', 'WORKER_DOMAIN', 'WORKER_NAME'],
    policyTags: ['analytics', 'crm', 'telephony'],
  },
  bindings: {
    required: ['AUTH_RATE_LIMITER', 'CRM_SEGMENTS', 'DB', 'FLAGS', 'FLAG_TELEMETRY', 'IMPORT_BUCKET'],
    optional: ['ANALYTICS'],
  },
  expectedSurfaces: recipeFixture.expectedSurfaces,
  smokeChecks: recipeFixture.smokeChecks,
  constraints: ['Use a branded custom domain.', 'Verify import smoke checks before production.'],
  scaffold: {
    entryScript: 'packages/deploy/scripts/scaffold.mjs',
    stagingFirst: true,
    requiredSecrets: ['JWT_SECRET'],
    requiredBindings: ['AUTH_RATE_LIMITER', 'CRM_SEGMENTS', 'DB', 'FLAGS', 'FLAG_TELEMETRY', 'IMPORT_BUCKET'],
    requiredVars: ['ENVIRONMENT', 'WORKER_DOMAIN', 'WORKER_NAME'],
  },
};

const resolutionFixture = {
  concept: {
    id: 'outbound-dialer-campaign',
    displayName: 'Outbound Dialer Campaign',
    approvalTier: 'golden',
  },
  recipe: recipeFixture,
  parameters: {
    workerDomain: 'dialer.example.com',
    campaignSource: 'csv-import',
    enableVoiceSynthesis: true,
  },
  nextStep: { action: 'compile-recipe-plan', recipeId: recipeFixture.id },
  resolution: { strategy: 'parameter-rules', matchedRuleId: 'csv-import-uses-importer' },
};

const handoffId = '11111111-2222-3333-4444-555555555555';
const handoffHash = 'a'.repeat(64);
const provisionRequestId = '99999999-8888-7777-6666-555555555555';

test('capabilities flow: configure → resolve → preview → handoff → proof gates → staging provision', async ({
  page,
}) => {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path.endsWith('/auth/login') && request.method() === 'POST') {
      await route.fulfill(json({ token, expiresAt: Date.now() + 60 * 60 * 1000 }));
      return;
    }

    if (path.endsWith('/me')) {
      await route.fulfill(
        json({
          env: 'staging',
          user: { id: 'user_1', email: 'operator@factory.dev', role: 'admin' },
          sessionId: 'sess_1',
          envLockedAt: Date.now(),
        }),
      );
      return;
    }

    if (path.endsWith('/capabilities') && request.method() === 'GET') {
      await route.fulfill(
        json({
          generatedAt: '2026-05-23T00:00:00.000Z',
          summary: { primitiveCount: 6, recipeCount: 3, conceptCount: 2, ruleFileCount: 1 },
          concepts: [
            {
              id: 'outbound-dialer-campaign',
              displayName: 'Outbound Dialer Campaign',
              summary: 'Governed outbound dialer setup with routing for CRM segment or CSV import audiences.',
              status: 'approved',
              maturity: 'beta',
              tags: ['telephony', 'crm', 'campaigns'],
              menuVisible: true,
              approvalTier: 'golden',
              parameters: [
                {
                  id: 'workerDomain',
                  type: 'string',
                  description: 'Custom domain for the deployed worker.',
                  required: true,
                  enum: [],
                  default: null,
                  formatHint: 'dialer.example.com',
                },
                {
                  id: 'campaignSource',
                  type: 'string',
                  description: 'Audience source for the campaign.',
                  required: true,
                  enum: ['crm-segment', 'csv-import'],
                  default: 'crm-segment',
                  formatHint: null,
                },
                {
                  id: 'enableVoiceSynthesis',
                  type: 'boolean',
                  description: 'Enable synthesized voice prompts.',
                  required: false,
                  enum: [],
                  default: true,
                  formatHint: null,
                },
              ],
              recipes: [
                {
                  id: 'outbound-dialer',
                  summary: 'CRM-segment driven outbound dialer workflow.',
                  maturity: 'beta',
                  primitives: ['telephony', 'crm', 'analytics'],
                  optionalPrimitives: ['compliance'],
                },
                {
                  id: 'outbound-dialer-importer',
                  summary: 'Outbound dialer workflow with CSV import landing and ingestion flow.',
                  maturity: 'beta',
                  primitives: ['telephony', 'crm', 'analytics'],
                  optionalPrimitives: ['compliance'],
                },
              ],
              sourcePrimitives: ['analytics', 'compliance', 'crm', 'telephony'],
              qualification: {
                requiredCapabilities: ['custom-domain'],
                disallowedEnvironments: ['local'],
              },
            },
          ],
        }),
      );
      return;
    }

    if (path.endsWith('/capabilities/resolve') && request.method() === 'POST') {
      await route.fulfill(json(resolutionFixture));
      return;
    }

    if (path.endsWith('/capabilities/preview') && request.method() === 'POST') {
      await route.fulfill(
        json({
          resolution: resolutionFixture,
          plan: planFixture,
          preview:
            '# Capability Plan Preview — outbound-dialer-importer\n\n**Summary:** ' +
            recipeFixture.summary +
            '\n\n## Packages\n\n- analytics: @latimer-woods-tech/analytics (^0.1.0)\n',
          generatedAt: '2026-05-23T00:00:00.000Z',
          nextStep: {
            action: 'review-plan-preview',
            conceptId: 'outbound-dialer-campaign',
            recipeId: recipeFixture.id,
          },
        }),
      );
      return;
    }

    if (path.endsWith('/capabilities/handoff') && request.method() === 'POST') {
      await route.fulfill(
        json({
          generatedAt: '2026-05-23T00:00:00.000Z',
          handoff: {
            schemaVersion: '1.0.0',
            kind: 'scaffold-handoff',
            conceptId: 'outbound-dialer-campaign',
            recipeId: recipeFixture.id,
            parameters: resolutionFixture.parameters,
            plan: planFixture,
            preview: '# preview',
            nextAction: {
              action: 'generate-scaffold-handoff',
              conceptId: 'outbound-dialer-campaign',
              recipeId: recipeFixture.id,
            },
            id: handoffId,
            hash: handoffHash,
            createdAt: '2026-05-23T00:00:00.000Z',
          },
        }),
      );
      return;
    }

    if (path.endsWith('/capabilities/provision-staging') && request.method() === 'POST') {
      await route.fulfill(
        json({
          request: {
            id: provisionRequestId,
            handoffId,
            status: 'requested',
            requestedAt: '2026-05-23T00:00:00.000Z',
          },
          handoff: {
            id: handoffId,
            hash: handoffHash,
            conceptId: 'outbound-dialer-campaign',
            recipeId: recipeFixture.id,
          },
          nextStep: {
            action: 'await-staging-deployment',
            handoffId,
            requestId: provisionRequestId,
          },
        }),
      );
      return;
    }

    await route.fulfill(json({}));
  });

  // ── Login → /capabilities ──────────────────────────────────────────────
  await page.goto('/login');
  await page.getByRole('button', { name: 'Staging' }).click();
  await page.getByPlaceholder('email').fill('operator@factory.dev');
  await page.getByPlaceholder('password').fill('password');
  await page.getByRole('button', { name: /Sign in to staging/i }).click();
  await expect(page).toHaveURL(/\/overview$/);

  await page.getByRole('link', { name: 'Capabilities' }).click();
  await expect(page.getByRole('heading', { name: 'Capability Design Studio' })).toBeVisible();
  await expect(page.getByText('Staging-first only')).toBeVisible();

  // Concept rail loaded with the seed concept.
  await expect(page.getByRole('button', { name: /Outbound Dialer Campaign/i })).toBeVisible();

  // ── Resolve ────────────────────────────────────────────────────────────
  await page.getByRole('button', { name: /^Resolve Concept$/ }).click();
  await expect(page.getByText('Resolution Result')).toBeVisible();
  await expect(page.getByText(/csv-import-uses-importer/)).toBeVisible();

  // ── Preview ────────────────────────────────────────────────────────────
  await page.getByRole('button', { name: /^Preview Plan$/ }).click();
  await expect(page.getByRole('heading', { name: 'Plan Preview' })).toBeVisible();
  const expectedSurfacesCard = page.locator('h3', { name: 'Expected Surfaces' }).locator('..');
  await expect(expectedSurfacesCard.getByText('/api/imports')).toBeVisible();

  // ── Confirm handoff → Generate ─────────────────────────────────────────
  const handoffConfirm = page.getByLabel(/I reviewed the preview/);
  await handoffConfirm.check();
  await page.getByRole('button', { name: /Generate Scaffold Handoff/ }).click();
  await expect(page.getByRole('heading', { name: 'Scaffold Handoff Package' })).toBeVisible();
  await expect(
    page.locator('dt', { hasText: 'Content hash' }).locator('..').getByText(handoffHash),
  ).toBeVisible();

  // Copy + download buttons should be present.
  await expect(page.getByRole('button', { name: /Copy JSON/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Download/ })).toBeVisible();

  // ── Proof gates → Request staging provision ────────────────────────────
  await expect(page.getByRole('heading', { name: /Proof Gate/ })).toBeVisible();
  await page.getByLabel(/I reviewed the compiled plan/).check();
  await page.getByLabel(/I reviewed the environment contract/).check();
  await page.getByLabel(/I reviewed the smoke expectations/).check();
  await page.getByLabel(/Staging-first only/).last().check();
  await page.getByLabel(/Custom domain ready/).check();

  await page.getByRole('button', { name: /Request Staging Provision/ }).click();
  // Double-confirm panel appears.
  await expect(page.getByText('Confirm staging provision request')).toBeVisible();
  await page.getByRole('button', { name: /Confirm — submit request/ }).click();

  // Success surface.
  await expect(
    page.locator('main').locator('p', { hasText: 'Staging provision request recorded.' }),
  ).toBeVisible();
  await expect(page.locator('main').getByText(provisionRequestId).first()).toBeVisible();
});
