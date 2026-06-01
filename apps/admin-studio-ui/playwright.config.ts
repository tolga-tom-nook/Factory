import { defineConfig, devices } from '@playwright/test';

const E2E_PORT = 4174;
const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  use: {
    baseURL: E2E_BASE_URL,
    trace: 'on-first-retry',
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${E2E_PORT}`,
    url: E2E_BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    { name: 'mobile-375x812', use: { browserName: 'chromium', viewport: { width: 375, height: 812 } } },
    { name: 'iphone-12',      use: { ...devices['iPhone 12'] } },
    { name: 'iphone-se3',     use: { ...devices['iPhone SE'] } },
    { name: 'pixel-5',        use: { ...devices['Pixel 5'] } },
    { name: 'ipad-mini',      use: { ...devices['iPad Mini'] } },
    { name: 'desktop-chrome', use: { browserName: 'chromium', viewport: { width: 1280, height: 720 } } },
  ],
});
