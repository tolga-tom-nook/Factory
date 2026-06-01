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

test('mobile smoke flow: login → overview → ai → code → audit', async ({ page }) => {
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

    if (path.endsWith('/observability/sentry/issues')) {
      await route.fulfill(json({ configured: true, env: 'staging', issues: [] }));
      return;
    }

    if (path.endsWith('/observability/posthog/tiles')) {
      await route.fulfill(json({ configured: true, tiles: [] }));
      return;
    }

    if (path.endsWith('/observability/telemetry-coverage')) {
      await route.fulfill(json({ env: 'staging', apps: [] }));
      return;
    }

    if (path.endsWith('/apps/health')) {
      await route.fulfill(json({ env: 'staging', results: [] }));
      return;
    }

    if (path.endsWith('/apps/versions')) {
      await route.fulfill(json({ env: 'staging', configured: true, results: [] }));
      return;
    }

    if (path.endsWith('/observability/synthetic/journey')) {
      await route.fulfill(
        json({ configured: true, outageClass: 'ok', probes: [], trend: [], checkedAt: new Date().toISOString() }),
      );
      return;
    }

    if (path.endsWith('/repo/branches')) {
      await route.fulfill(
        json({
          branches: [
            { name: 'main', protected: true, isDefault: true },
            { name: 'feature/mobile', protected: false, isDefault: false },
          ],
        }),
      );
      return;
    }

    if (path.endsWith('/repo/tree')) {
      await route.fulfill(
        json({
          nodes: [{ path: 'src/index.ts', type: 'blob' }],
          truncated: false,
        }),
      );
      return;
    }

    if (path.endsWith('/repo/file')) {
      await route.fulfill(
        json({
          file: {
            path: 'src/index.ts',
            ref: 'main',
            sha: 'blob-sha-1',
            binary: false,
            size: 26,
            text: 'export const smoke = true;\n',
          },
        }),
      );
      return;
    }

    if (path.endsWith('/audit')) {
      await route.fulfill(json({ rows: [], nextCursor: null }));
      return;
    }

    if (path.endsWith('/ai/chat') && request.method() === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'data: {"type":"token","delta":"stubbed mobile reply"}\n\n',
      });
      return;
    }

    await route.fulfill(json({}));
  });

  await page.goto('/login');

  await page.getByRole('button', { name: 'Staging' }).click();
  await page.getByPlaceholder('email').fill('operator@factory.dev');
  await page.getByPlaceholder('password').fill('password');
  await page.getByRole('button', { name: /Sign in to staging/i }).click();

  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByRole('heading', { name: 'Overview' }).first()).toBeVisible();

  await page.getByRole('link', { name: 'AI Chat' }).click();
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();

  const composer = page.getByPlaceholder(/Ask…/i);
  await composer.fill('hello from mobile smoke');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('stubbed mobile reply')).toBeVisible();
  await expect(composer).toBeVisible();

  await page.getByRole('link', { name: 'Code' }).click();
  await page.getByRole('button', { name: 'src' }).click();
  await page.getByRole('button', { name: 'index.ts' }).click();
  await expect(page.getByPlaceholder('Commit message')).toBeVisible();

  await page.getByRole('link', { name: 'Audit Log' }).click();
  await expect(page.getByRole('heading', { name: 'Audit Log' })).toBeVisible();
});
