import type { BrowserWorker } from '@cloudflare/puppeteer';

/**
 * Cloudflare Worker bindings for the synthetic monitor.
 *
 * Configuration values here are non-secret. Any future alert webhook tokens must
 * be added with `wrangler secret put`, never as `wrangler.jsonc` vars.
 */
export interface Env {
  /** Browser Rendering binding */
  BROWSER?: BrowserWorker | null;
  /** R2 Bucket for audit logs */
  AUDIT_LOGS: R2Bucket;
  /** Slack webhook for ops alerts */
  SLACK_WEBHOOK_OPS?: string;
  /** Runtime environment label. */
  ENVIRONMENT: string;
  /** Optional JSON array of monitor targets. Empty or invalid values fall back to defaults. */
  TARGETS_JSON?: string;
  /** Optional service binding for internal schedule-worker checks. */
  SCHEDULE_WORKER?: Fetcher;
  /** Optional service binding for internal video-cron checks. */
  VIDEO_CRON?: Fetcher;
  /** Optional service binding for internal admin-studio staging checks. */
  ADMIN_STUDIO_STAGING?: Fetcher;
  /** Optional service binding for internal prime-self checks. */
  PRIME_SELF?: Fetcher;
  /** KV namespace for writing monitor snapshots. Optional — graceful no-op if absent. */
  MONITOR_KV?: KVNamespace;
  /** Flagship feature-flag binding. */
  FLAGS?: Fetcher;
  /** flag-meter D1 database for flag telemetry. */
  FLAG_TELEMETRY?: D1Database;
}
