export { SupervisorDO } from './supervisor.do';
export { LockDO } from './lock.do';
import { handleSlackEvents } from './tools/slack.js';

export interface Env {
  SUPERVISOR: DurableObjectNamespace;
  LOCK: DurableObjectNamespace;
  MEMORY: D1Database;
  LLM_LEDGER: D1Database;
  AI_GATEWAY_BASE_URL: string;
  ANTHROPIC_API_KEY: string;
  GROQ_API_KEY: string;
  GROK_API_KEY?: string;
  VERTEX_ACCESS_TOKEN: string;
  VERTEX_PROJECT: string;
  VERTEX_LOCATION: string;
  PER_RUN_CAP_CENTS?: string;
  JWT_SECRET: string;
  /** GitHub App numeric ID. Set via `wrangler secret put FACTORY_APP_ID`. */
  FACTORY_APP_ID: string;
  /** GitHub App RSA private key PEM. Set via `wrangler secret put FACTORY_APP_PRIVATE_KEY`. */
  FACTORY_APP_PRIVATE_KEY: string;
  /** GitHub App installation ID for Latimer-Woods-Tech/factory. Set via `wrangler secret put FACTORY_APP_INSTALLATION_ID`. */
  FACTORY_APP_INSTALLATION_ID: string;
  /** Pushover application token. Set via `wrangler secret put PUSHOVER_TOKEN`. */
  PUSHOVER_TOKEN: string;
  /** Pushover user key. Set via `wrangler secret put PUSHOVER_USER_KEY`. */
  PUSHOVER_USER_KEY: string;
  /** Slack signing secret for /slack/events verification. Set via `wrangler secret put SLACK_SIGNING_SECRET`. */
  SLACK_SIGNING_SECRET: string;
  /** Slack user ID of the workspace owner — only DMs from this user create GitHub issues. */
  SLACK_OWNER_USER_ID: string;
  /** factory-cross-repo worker base URL (e.g., https://factory-cross-repo-worker.example.com). Set via `wrangler secret put FACTORY_CROSS_REPO_URL`. */
  FACTORY_CROSS_REPO_URL?: string;
  /** factory-cross-repo Bearer token for authentication. Set via `wrangler secret put FACTORY_CROSS_REPO_TOKEN`. */
  FACTORY_CROSS_REPO_TOKEN?: string;
  /** factory-core-api base URL for push-on-write run mirroring (P1.9). Set via `wrangler secret put FACTORY_CORE_API_URL`. */
  FACTORY_CORE_API_URL?: string;
  /** Service key for POST /v1/runs/mirror on factory-core-api. Set via `wrangler secret put SUPERVISOR_PUSH_KEY`. */
  SUPERVISOR_PUSH_KEY?: string;
  /** Service key guarding privileged HTTP routes (/run, /plan, /scheduled, /state, /aos/status, /capabilities). Set via `wrangler secret put SUPERVISOR_API_KEY`. */
  SUPERVISOR_API_KEY?: string;
}

/** Constant-time string comparison — guards against timing side-channels. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Factory Supervisor — entrypoint.
 *
 * Routes every request to the singleton SupervisorDO. The DO is the single
 * source of truth for run state; this worker is a thin HTTP/cron/queue
 * fan-in that forwards to the DO.
 *
 * Phase 1 (SUP-3.4): scaffold only — DO stubs, tool registry stub, memory
 * stub, planner stubs. Phase 2 (SUP-3.5): scheduled Sauna runs wired through.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health probes stay public — CI post-deploy checks and the synthetic
    // monitor curl /health with no credentials.
    if (url.pathname === '/health') {
      const stub = env.SUPERVISOR.get(env.SUPERVISOR.idFromName('singleton'));
      return stub.fetch(request);
    }

    // Slack carries its own request-signature verification.
    if (url.pathname === '/slack/events' && request.method === 'POST') {
      return handleSlackEvents(request, env);
    }

    // Every other route (/run, /plan, /scheduled, /state, /aos/status, /capabilities) is
    // privileged — runs spend LLM budget and can open PRs — so require the
    // supervisor service key. Fail closed (503) when it is not configured.
    if (!env.SUPERVISOR_API_KEY) {
      return Response.json({ error: 'supervisor api auth not configured' }, { status: 503 });
    }
    const auth = request.headers.get('authorization');
    const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token || !timingSafeEqual(token, env.SUPERVISOR_API_KEY)) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }

    const stub = env.SUPERVISOR.get(env.SUPERVISOR.idFromName('singleton'));
    return stub.fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const id = env.SUPERVISOR.idFromName('singleton');
    const stub = env.SUPERVISOR.get(id);
    ctx.waitUntil(
      stub.fetch(new Request('https://supervisor/scheduled', { method: 'POST' })).then(() => undefined),
    );
  },
} satisfies ExportedHandler<Env>;
