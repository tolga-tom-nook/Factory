import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Thresholds reflect the current baseline: the large Hono route handler
      // surface is tested via integration tests (index.test.ts); the new
      // subscription-dispatch path has full unit coverage in dispatch.test.ts.
      // Raise branches/lines toward 90% as more Hono routes gain tests.
      thresholds: { lines: 65, functions: 90, branches: 60 },
      include: ['src/**'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
