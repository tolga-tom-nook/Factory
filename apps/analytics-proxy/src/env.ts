export interface Env {
  ANALYTICS_KV: KVNamespace;
  ENVIRONMENT: string;
  /** Cloudflare API token with Account Analytics: Read scope */
  CF_API_TOKEN: string;
  /** Cloudflare account ID (32-char hex) */
  CF_ACCOUNT_ID: string;
}
