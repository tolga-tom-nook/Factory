/**
 * factory-agent-gateway — Phase 3 of the Agent Runtime.
 *
 * Fronts AgentSessionDO instances with:
 *  - Bearer JWT authentication via @latimer-woods-tech/auth
 *  - Per-tenant Cloudflare native rate limiting (RATE_LIMITER binding)
 *  - Session routing to the AGENT_SESSIONS Durable Object namespace
 *
 * See docs/architecture/AGENT_RUNTIME.md §13 for the gateway design.
 *
 * ## AgentSessionDO
 *
 * `AgentSessionDO` is re-exported from `@latimer-woods-tech/agent` so Cloudflare
 * can bind it as a Durable Object (wrangler looks for the DO class in the Worker's
 * own entry module). The canonical implementation lives in the package — the
 * gateway does not fork it.
 *
 * ## AI_GATEWAY_BASE_URL — CRITICAL trap
 *
 * The `AI_GATEWAY_BASE_URL` var MUST point at the provisioned prime-self gateway:
 *   https://gateway.ai.cloudflare.com/v1/a1c8a33cbe8a3c9e260480433a0dbb06/prime-self
 *
 * DO NOT create a new AI Gateway named "agent-gateway". An unprovisioned (ghost)
 * gateway silently returns 401. The @lwt/llm complete() function falls back to
 * direct-provider calls, losing prompt caching and cost attribution with NO
 * visible error. This broke daily-brief on 2026-06-02 (ghost-gateway incident).
 * Always use the prime-self gateway until a dedicated one is provisioned + curl-verified.
 */

// Re-export AgentSessionDO so the wrangler migrations block can find the class.
// This is required for Cloudflare to bind AGENT_SESSIONS → AgentSessionDO.
// Canonical implementation lives in @latimer-woods-tech/agent — never forked here.
export { AgentSessionDO } from '@latimer-woods-tech/agent';

import { Hono } from 'hono';
import { verifyToken, type TokenPayload } from '@latimer-woods-tech/auth';

/**
 * Cloudflare Worker environment bindings.
 *
 * All secrets are injected via `wrangler secret put` or the sync-worker-secrets.yml
 * workflow — never stored in wrangler.jsonc vars or source code.
 */
export interface Env {
  /** Durable Object namespace for AgentSessionDO instances. */
  AGENT_SESSIONS: DurableObjectNamespace;

  /** D1 database for episodic memory (agent_sessions / agent_turns tables). */
  DB: D1Database;

  /** KV namespace for per-tenant config (reserved for Phase 4 recipe lookup). */
  KV: KVNamespace;

  /**
   * Cloudflare native rate limiter (unsafe binding).
   * Namespace ID 1013 — allocated per docs/runbooks/add-new-app.md registry.
   * TODO(operator): allocate namespace ID 1013 in the Cloudflare dashboard before deploying.
   */
  RATE_LIMITER: {
    limit: (opts: { key: string }) => Promise<{ success: boolean }>;
  };

  /**
   * HS256 signing secret for Bearer JWT verification.
   * Set via: wrangler secret put JWT_SECRET
   */
  JWT_SECRET: string;

  /**
   * AI Gateway base URL — MUST point at the provisioned prime-self gateway.
   * Set in wrangler.jsonc vars (not a secret; not a provider key).
   *
   * CRITICAL TRAP: Do NOT point this at an "agent-gateway"-named gateway that
   * has not been provisioned in the Cloudflare dashboard. An unprovisioned
   * gateway silently 401s → @lwt/llm degrades to direct-provider (no caching).
   */
  AI_GATEWAY_BASE_URL: string;

  /** Anthropic API key — forwarded to @lwt/llm via DO request body. */
  ANTHROPIC_API_KEY: string;

  /** Groq fallback provider key. */
  GROQ_API_KEY: string;

  /** Grok fallback provider key (optional). */
  GROK_API_KEY?: string;

  /** GCP Vertex AI access token (optional, for Gemini tier). */
  VERTEX_ACCESS_TOKEN?: string;

  /** GCP Vertex AI project ID. */
  VERTEX_PROJECT?: string;

  /** GCP Vertex AI region. */
  VERTEX_LOCATION?: string;
}

/** Declare the `user` variable on the Hono context. */
declare module 'hono' {
  interface ContextVariableMap {
    user: TokenPayload;
  }
}

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Health — public, no auth required.
// CI post-deploy checks and synthetic monitors curl /health with no credentials.
// ---------------------------------------------------------------------------

/**
 * GET /health
 *
 * Public health probe. Returns 200 with a JSON body confirming the service name.
 * The operator MUST verify this returns 200 via `curl` after first deploy.
 * CI green != running (CLAUDE.md Verification Requirement).
 */
app.get('/health', (c) => c.json({ ok: true, service: 'agent-gateway' }));

// ---------------------------------------------------------------------------
// Auth middleware — applied to all /sessions/* routes.
// ---------------------------------------------------------------------------

/**
 * Extracts and verifies the Bearer JWT on every /sessions/* request.
 * Sets `c.var.user` (TokenPayload) for downstream handlers.
 *
 * Rejects with 401 when:
 *  - No Authorization header is present
 *  - The token is malformed, invalid, or expired
 * Rejects with 503 when JWT_SECRET is not configured (fail-closed on misconfiguration).
 */
app.use('/sessions/*', async (c, next) => {
  if (!c.env.JWT_SECRET) {
    return c.json({ error: 'auth not configured' }, 503);
  }

  const authorization = c.req.header('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return c.json({ error: 'Bearer token required' }, 401);
  }

  const token = authorization.slice(7).trim();
  if (!token) {
    return c.json({ error: 'Bearer token required' }, 401);
  }

  try {
    const payload = await verifyToken(token, c.env.JWT_SECRET);
    c.set('user', payload);
  } catch {
    return c.json({ error: 'unauthorized' }, 401);
  }

  await next();
});

// ---------------------------------------------------------------------------
// Rate-limit middleware — applied to all /sessions/* routes.
// ---------------------------------------------------------------------------

/**
 * Per-tenant rate limiting via the Cloudflare native RATE_LIMITER binding.
 * Keyed by JWT subject (user/tenant ID) so each tenant has an independent
 * limit — one abusive tenant cannot exhaust the shared namespace budget.
 *
 * Returns 429 when the per-tenant limit is exceeded.
 */
app.use('/sessions/*', async (c, next) => {
  const user = c.get('user');
  const result = await c.env.RATE_LIMITER.limit({ key: user.sub });
  if (!result.success) {
    return c.json({ error: 'rate limit exceeded' }, 429);
  }

  await next();
});

// ---------------------------------------------------------------------------
// Session routes — forwarded to AgentSessionDO instances.
//
// Each session ID maps to a unique DO instance via idFromName(). The DO handles
// all state management (message history, checkpointing, cost tracking).
// The gateway is intentionally thin: authenticate, rate-limit, route.
// ---------------------------------------------------------------------------

/**
 * Returns the DO stub for the given session ID.
 * The DO is keyed by session ID so each session is isolated.
 */
function getSessionStub(env: Env, sessionId: string): DurableObjectStub {
  const id = env.AGENT_SESSIONS.idFromName(sessionId);
  return env.AGENT_SESSIONS.get(id);
}

/**
 * Builds the LLM env payload to forward to the DO in the request body.
 * The DO cannot hold long-lived env bindings (DO serialization strips them),
 * so the gateway passes env per-request.
 */
function buildLLMEnv(env: Env): Record<string, string | undefined> {
  return {
    AI_GATEWAY_BASE_URL: env.AI_GATEWAY_BASE_URL,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    GROQ_API_KEY: env.GROQ_API_KEY,
    GROK_API_KEY: env.GROK_API_KEY,
    VERTEX_ACCESS_TOKEN: env.VERTEX_ACCESS_TOKEN,
    VERTEX_PROJECT: env.VERTEX_PROJECT,
    VERTEX_LOCATION: env.VERTEX_LOCATION,
  };
}

/**
 * POST /sessions/:id/run
 *
 * Forwards the run request to the AgentSessionDO for `sessionId = :id`.
 * The LLM env bindings are merged into the body so the DO can invoke
 * @lwt/llm without holding serialized env references.
 *
 * Returns: AgentResult (content, stopReason, turns, totalCostUsd, totalTurns)
 * Error codes forwarded from the DO: 400, 409, 429, 500.
 */
app.post('/sessions/:id/run', async (c) => {
  const sessionId = c.req.param('id');
  let rawBody: unknown = null;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  const body: Record<string, unknown> = (typeof rawBody === 'object' && rawBody !== null)
    ? rawBody as Record<string, unknown>
    : {};

  const stub = getSessionStub(c.env, sessionId);
  const doResponse = await stub.fetch('https://do/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, env: buildLLMEnv(c.env) }),
  });

  const responseBody: unknown = await doResponse.json();
  return c.json(responseBody, doResponse.status as 200 | 400 | 409 | 429 | 500);
});

/**
 * GET /sessions/:id/history
 *
 * Returns the full session state (messages, turns, cost, status) from the DO.
 * Useful for session replay, debugging, and building approval UIs.
 */
app.get('/sessions/:id/history', async (c) => {
  const sessionId = c.req.param('id');
  const stub = getSessionStub(c.env, sessionId);
  const doResponse = await stub.fetch('https://do/history');
  const responseBody: unknown = await doResponse.json();
  return c.json(responseBody, doResponse.status as 200 | 404 | 500);
});

/**
 * POST /sessions/:id/reset
 *
 * Resets session state in the DO — clears messages, turns, cost totals.
 * Useful for starting a fresh session without provisioning a new session ID.
 */
app.post('/sessions/:id/reset', async (c) => {
  const sessionId = c.req.param('id');
  const stub = getSessionStub(c.env, sessionId);
  const doResponse = await stub.fetch('https://do/reset', { method: 'POST' });
  const responseBody: unknown = await doResponse.json();
  return c.json(responseBody, doResponse.status as 200 | 500);
});

export default app;
