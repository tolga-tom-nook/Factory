/**
 * Worker environment bindings for qa-tools-worker.
 *
 * Secrets are provisioned via `wrangler secret put`; non-secret config
 * lives in wrangler.jsonc `vars`. Never use process.env — use c.env or env.
 */

export interface Env {
  /**
   * Neon Postgres via Hyperdrive.
   * Use `env.DB.connectionString` to obtain the pooled connection string.
   */
  DB: { readonly connectionString: string };

  /**
   * R2 bucket for screenshots, diff images, JSON exports.
   * Lifecycle policy: 90-day auto-expiry (configure via wrangler r2 lifecycle).
   */
  QA_TOOLS_R2: R2Bucket;

  /**
   * KV namespace for rate-limit state (concurrent run counters per app).
   * TTL: 120s per key (auto-expires if Worker crashes mid-audit).
   */
  RATE_LIMIT_KV: KVNamespace;

  /**
   * HS256 signing key for QA Tools JWTs.
   * Rotate semi-annually. wrangler secret QA_TOOLS_JWT_SECRET.
   */
  QA_TOOLS_JWT_SECRET: string;

  /**
   * GCP service-account JSON (minified, single line) for OIDC token exchange
   * when calling the browser-agent Cloud Run service.
   * wrangler secret BROWSER_AGENT_SA_KEY.
   */
  BROWSER_AGENT_SA_KEY: string;

  /**
   * browser-agent Cloud Run service base URL.
   * e.g. https://browser-agent-891842778224.us-central1.run.app
   * wrangler secret BROWSER_AGENT_URL.
   */
  BROWSER_AGENT_URL: string;

  /**
   * OIDC audience for browser-agent token exchange (same as BROWSER_AGENT_URL).
   * wrangler secret BROWSER_AGENT_AUDIENCE.
   */
  BROWSER_AGENT_AUDIENCE: string;

  /**
   * GitHub PAT (repo:write) for issue creation and PR comments.
   * Optional — feature-flagged off when absent.
   * wrangler secret GITHUB_QA_TOKEN.
   */
  GITHUB_QA_TOKEN?: string;

  /**
   * Slack incoming webhook URL for run notifications and daily digests.
   * Optional — notifications silently skipped when absent.
   * wrangler secret SLACK_QA_WEBHOOK_URL.
   */
  SLACK_QA_WEBHOOK_URL?: string;

  /**
   * Sentry DSN for error reporting.
   * Optional. wrangler secret SENTRY_DSN.
   */
  SENTRY_DSN?: string;

  /**
   * AES-256-GCM encryption key for credential payloads.
   * Must be exactly 64 hex characters (32 bytes).
   * Phase 2: required for credential create/decrypt endpoints.
   * Optional — endpoints that need it emit a 422 if absent.
   * wrangler secret QA_TOOLS_ENCRYPT_KEY.
   */
  QA_TOOLS_ENCRYPT_KEY?: string;

  /** Runtime environment label: development | staging | production. */
  ENVIRONMENT: string;
}
