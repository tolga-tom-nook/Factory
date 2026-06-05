type Fn<A extends unknown[], R> = (...args: A) => R;

interface MockMeta<A extends unknown[], R> {
  calls: A[];
  results: R[];
}

interface MockFn<A extends unknown[], R> {
  (...args: A): R;
  mock: MockMeta<A, R>;
  mockReturnValue: (value: R) => MockFn<A, R>;
  mockImplementation: (impl: Fn<A, R>) => MockFn<A, R>;
  reset: () => void;
}

/**
 * Creates a lightweight typed mock function compatible with all major test
 * runners. Tracks calls and results without depending on Vitest or Jest.
 *
 * @param impl - Optional initial implementation.
 * @returns A mock function exposing `.mock.calls`, `.mockReturnValue`, etc.
 */
export function createMockFn<A extends unknown[], R>(impl?: Fn<A, R>): MockFn<A, R> {
  let current: Fn<A, R> | undefined = impl;
  const meta: MockMeta<A, R> = { calls: [], results: [] };
  const fn = ((...args: A): R => {
    meta.calls.push(args);
    if (!current) {
      throw new Error('mock has no implementation; call mockReturnValue or mockImplementation');
    }
    const result = current(...args);
    meta.results.push(result);
    return result;
  }) as MockFn<A, R>;
  fn.mock = meta;
  fn.mockReturnValue = (value: R): MockFn<A, R> => {
    current = (() => value) as Fn<A, R>;
    return fn;
  };
  fn.mockImplementation = (next: Fn<A, R>): MockFn<A, R> => {
    current = next;
    return fn;
  };
  fn.reset = (): void => {
    meta.calls.length = 0;
    meta.results.length = 0;
    current = impl;
  };
  return fn;
}

// Re-export money flow testing fixtures
export {
  createMockStripeWebhook,
  createMockCreator,
  createMockEarnings,
  createMockDLQEvent,
  seedDatabase,
  cleanupAfterTest,
  assertDatabaseState,
  randomId,
  type MockCreator,
  type MockEarnings,
  type MockDLQEvent,
  type SeedData,
  type SeedResult,
  type DatabaseStateAssertions,
  type MockStripeWebhookType,
  type SubscriptionStatus,
  type EarningsStatus,
} from './money-flow-fixtures';

// ---------- Domain test fixtures ----------

/**
 * Test user shape used across Factory app suites.
 */
export interface TestUser {
  id: string;
  email: string;
  name: string;
  tenantId: string;
  createdAt: Date;
}

/**
 * Builds a test user fixture with deterministic defaults.
 *
 * @param overrides - Optional field overrides.
 */
export function createTestUser(overrides: Partial<TestUser> = {}): TestUser {
  return {
    id: 'user_test_1',
    email: 'tester@thefactory.dev',
    name: 'Factory Tester',
    tenantId: 'tenant_test_1',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

/**
 * Test tenant shape used across Factory app suites.
 */
export interface TestTenant {
  id: string;
  name: string;
  appId: string;
  createdAt: Date;
}

/**
 * Builds a test tenant fixture with deterministic defaults.
 *
 * @param overrides - Optional field overrides.
 */
export function createTestTenant(overrides: Partial<TestTenant> = {}): TestTenant {
  return {
    id: 'tenant_test_1',
    name: 'Test Tenant',
    appId: 'app_test',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

/**
 * Test subscription shape used across Factory app suites.
 */
export interface TestSub {
  id: string;
  customerId: string;
  status: 'active' | 'canceled' | 'past_due' | 'trialing' | 'none';
  tier: string;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
}

/**
 * Builds a test subscription fixture with deterministic defaults.
 *
 * @param overrides - Optional field overrides.
 */
export function createTestSubscription(overrides: Partial<TestSub> = {}): TestSub {
  return {
    id: 'sub_test_1',
    customerId: 'cus_test_1',
    status: 'active',
    tier: 'pro',
    currentPeriodEnd: new Date('2025-12-31T00:00:00Z'),
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

// ---------- Mock factories ----------

/**
 * Mock Neon database with a chainable query builder.
 */
export interface MockNeonDatabase {
  execute: MockFn<[unknown], Promise<unknown>>;
  query: MockFn<[string, ...unknown[]], Promise<{ rows: unknown[] }>>;
  transaction: MockFn<[Fn<[MockNeonDatabase], Promise<unknown>>], Promise<unknown>>;
}

/**
 * Builds a Neon database mock that resolves all calls to empty data.
 */
export function mockNeon(): MockNeonDatabase {
  return {
    execute: createMockFn<[unknown], Promise<unknown>>(() => Promise.resolve(undefined)),
    query: createMockFn<[string, ...unknown[]], Promise<{ rows: unknown[] }>>(() =>
      Promise.resolve({ rows: [] }),
    ),
    transaction: createMockFn<
      [Fn<[MockNeonDatabase], Promise<unknown>>],
      Promise<unknown>
    >((cb) => cb({} as MockNeonDatabase)),
  };
}

/**
 * Mock Stripe client matching the surface used by `@latimer-woods-tech/stripe`.
 */
export interface MockStripeClient {
  webhooks: { constructEventAsync: MockFn<unknown[], Promise<unknown>> };
  subscriptions: { list: MockFn<unknown[], Promise<{ data: unknown[] }>> };
  checkout: { sessions: { create: MockFn<unknown[], Promise<{ url: string }>> } };
}

/**
 * Builds a Stripe client mock with success-by-default handlers.
 */
export function mockStripe(): MockStripeClient {
  return {
    webhooks: {
      constructEventAsync: createMockFn<unknown[], Promise<unknown>>(() =>
        Promise.resolve({ type: 'unknown' }),
      ),
    },
    subscriptions: {
      list: createMockFn<unknown[], Promise<{ data: unknown[] }>>(() =>
        Promise.resolve({ data: [] as unknown[] }),
      ),
    },
    checkout: {
      sessions: {
        create: createMockFn<unknown[], Promise<{ url: string }>>(() =>
          Promise.resolve({ url: 'https://checkout.stripe.com/test' }),
        ),
      },
    },
  };
}

/**
 * Mock LLM client used in tests for code paths that depend on `@latimer-woods-tech/llm`.
 */
export interface MockLLMClient {
  complete: MockFn<unknown[], Promise<{ data: { content: string }; error: null }>>;
}

/**
 * Builds an LLM mock that returns the next canned response per call.
 *
 * @param responses - Optional ordered list of canned response strings.
 */
export function mockLLM(responses: string[] = ['mock response']): MockLLMClient {
  let index = 0;
  return {
    complete: createMockFn<unknown[], Promise<{ data: { content: string }; error: null }>>(
      () => {
        const content = responses[index] ?? responses[responses.length - 1] ?? '';
        index += 1;
        return Promise.resolve({ data: { content }, error: null });
      },
    ),
  };
}

/**
 * Builds a `Request` that resembles a Telnyx call webhook payload.
 *
 * @param event - Event type, e.g. `call.initiated` or `call.answered`.
 */
export function mockTelnyxWebhook(event: string): Request {
  const payload = {
    data: {
      event_type: event,
      payload: { call_control_id: 'cc_test_1', call_leg_id: 'leg_test_1' },
    },
  };
  return new Request('https://example.test/webhooks/telnyx', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/**
 * Mock VoiceSession exposing the public surface from `@latimer-woods-tech/telephony`.
 */
export interface MockVoiceSession {
  start: MockFn<unknown[], Promise<void>>;
  processAudio: MockFn<[ArrayBuffer], Promise<void>>;
  end: MockFn<unknown[], Promise<unknown[]>>;
}

/**
 * Builds a VoiceSession mock with no-op lifecycle methods.
 */
export function mockVoiceSession(): MockVoiceSession {
  return {
    start: createMockFn<unknown[], Promise<void>>(() => Promise.resolve()),
    processAudio: createMockFn<[ArrayBuffer], Promise<void>>(() => Promise.resolve()),
    end: createMockFn<unknown[], Promise<unknown[]>>(() => Promise.resolve([] as unknown[])),
  };
}

/**
 * Mock Resend email client.
 */
export interface MockResendClient {
  send: MockFn<unknown[], Promise<{ id: string }>>;
}

/**
 * Builds a Resend mock that resolves with a fixed id.
 */
export function mockResend(): MockResendClient {
  return {
    send: createMockFn<unknown[], Promise<{ id: string }>>(() =>
      Promise.resolve({ id: 'email_test_1' }),
    ),
  };
}

/**
 * Mock PostHog client.
 */
export interface MockPostHogClient {
  capture: MockFn<unknown[], void>;
  identify: MockFn<unknown[], void>;
}

/**
 * Builds a PostHog mock with no-op capture/identify.
 */
export function mockPostHog(): MockPostHogClient {
  return {
    capture: createMockFn((): void => undefined),
    identify: createMockFn((): void => undefined),
  };
}

/**
 * Mock Sentry client.
 */
export interface MockSentryClient {
  captureException: MockFn<unknown[], string>;
  captureMessage: MockFn<unknown[], string>;
}

/**
 * Builds a Sentry mock that returns a fixed event id.
 */
export function mockSentry(): MockSentryClient {
  return {
    captureException: createMockFn(() => 'event_test_1'),
    captureMessage: createMockFn(() => 'event_test_1'),
  };
}

/**
 * Authenticated principal carried by Hono `c.var.user` in tests.
 */
export interface TokenPayload {
  sub: string;
  tenantId: string;
  roles?: string[];
}

/**
 * Inputs for {@link createTestRequest}.
 */
export interface CreateTestRequestOptions {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  user?: TokenPayload;
}

/**
 * Builds a `Request` aimed at a Hono handler under test.
 *
 * Body is JSON-serialized when provided. The optional `user` is attached
 * as a `x-test-user` header so test middleware can populate the auth context.
 *
 * @param opts - Request options.
 */
export function createTestRequest(opts: CreateTestRequestOptions): Request {
  const headers = new Headers(opts.headers);
  if (opts.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (opts.user) {
    headers.set('x-test-user', JSON.stringify(opts.user));
  }
  const init: RequestInit = {
    method: opts.method,
    headers,
  };
  if (opts.body !== undefined) {
    init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }
  const url = opts.path.startsWith('http') ? opts.path : `https://example.test${opts.path}`;
  return new Request(url, init);
}

// ---------- W360-042: UI Regression Gates ----------

/**
 * Re-export regression testing utilities (Lighthouse, screenshot diffing, performance budgets).
 * See regression-gates README for usage patterns.
 */
export {
  collectLighthouse,
  compareScreenshots,
  captureScreenshots,
  assertLighthouseBudget,
  DEFAULT_PERFORMANCE_BUDGETS,
  type LighthouseMetrics,
  type ScreenshotDiffResult,
  type PerformanceBudget,
  type CapturedScreenshots,
} from './regression-gates.js';export { MockLLM } from './mock-llm.js';
