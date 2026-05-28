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
   * Public Google OAuth client id used for the operator sign-in policy.
   * Same credential source as Admin Studio (`ADMIN_STUDIO_GOOGLE_CLIENT_ID`).
   */
  GOOGLE_CLIENT_ID?: string;

  /**
   * JSON map of allowlisted operator emails to QA roles/app access.
   * Same credential source as Admin Studio (`ADMIN_STUDIO_ALLOWED_USERS_JSON`).
   */
  QA_TOOLS_ALLOWED_USERS_JSON?: string;

  /** Workspace domain required for Google sign-in. */
  QA_TOOLS_GOOGLE_WORKSPACE_DOMAIN?: string;

  /** Break-glass bootstrap operator email; sourced from FACTORY_USER. */
  QA_TOOLS_ADMIN_EMAIL?: string;

  /** SHA-256 hex digest of break-glass bootstrap password; sourced from FACTORY_PW. */
  QA_TOOLS_ADMIN_PASSWORD_SHA256?: string;

  /** Comma-separated browser origins allowed to call this API. */
  ALLOWED_ORIGINS?: string;

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

  /** Runtime environment label: development | staging | production. */
  ENVIRONMENT: string;
}
