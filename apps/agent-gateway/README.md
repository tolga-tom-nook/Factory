# factory-agent-gateway

Phase 3 of the Factory Agent Runtime (see `docs/architecture/AGENT_RUNTIME.md`).

A Hono Worker that fronts `AgentSessionDO` instances with Bearer JWT authentication,
per-tenant Cloudflare rate limiting, and DO-backed session routing.

**Do NOT deploy this Worker until all operator checklist items below are complete.**
An incomplete deploy will result in a broken worker or silent LLM degradation.

---

## Architecture

```
Client → Bearer JWT → RATE_LIMITER check → AGENT_SESSIONS DO
```

- `GET  /health` — public, no auth
- `POST /sessions/:id/run` — forwards to AgentSessionDO `/run`
- `GET  /sessions/:id/history` — forwards to AgentSessionDO `/history`
- `POST /sessions/:id/reset` — forwards to AgentSessionDO `/reset`

---

## Operator Deploy Checklist

### 1. Rate-Limiter ID Allocation

The `RATE_LIMITER` binding uses namespace ID **1013** (production).
You MUST allocate this in the Cloudflare dashboard before deploying:

```
Cloudflare Dashboard → Workers & Pages → Rate Limiting → New Rate Limiter
  Name: agent-gateway-prod
  Type: "Simple"
  Rate: 100 requests / 60 seconds
  Key: (configured in wrangler.jsonc)
```

After creating it, update `docs/runbooks/add-new-app.md` with the new entry:

```markdown
| agent-gateway (prod) | `RATE_LIMITER` | 1013 | 100/m/user | /sessions/* authed routes |
```

Also allocate a separate staging rate-limiter (next ID after 1013) and update
`wrangler.jsonc` `env.staging.unsafe.bindings[0].namespace_id`.

### 2. D1 Database — Create and Apply Migration

```bash
# Create the D1 database
wrangler d1 create agent-gateway-memory
# → note the database_id UUID in the output

# Replace the TODO placeholder in wrangler.jsonc
# (both top-level and env.production)
sed -i 's/TODO_REPLACE_WITH_D1_UUID/<actual-uuid>/g' wrangler.jsonc

# Apply the episodic memory schema from @latimer-woods-tech/agent
wrangler d1 execute agent-gateway-memory --remote --file=./migrations/001_agent_sessions.sql
```

The migration SQL is defined in `@latimer-woods-tech/agent`'s documentation:

```sql
CREATE TABLE IF NOT EXISTS agent_sessions (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  user_id      TEXT,
  project      TEXT NOT NULL,
  summary      TEXT NOT NULL,
  stop_reason  TEXT NOT NULL,
  total_turns  INTEGER NOT NULL DEFAULT 0,
  cost_usd     REAL NOT NULL DEFAULT 0,
  tool_names   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_user
  ON agent_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_project
  ON agent_sessions (project, created_at DESC);
```

### 3. KV Namespace — Create

```bash
wrangler kv:namespace create "agent-gateway-config"
# → note the id UUID

# Replace TODO placeholders in wrangler.jsonc
sed -i 's/TODO_REPLACE_WITH_KV_NAMESPACE_UUID/<actual-uuid>/g' wrangler.jsonc
```

### 4. Branded Custom Domain

Replace the `TODO_REPLACE_BRANDED_DOMAIN` placeholder in `wrangler.jsonc`
`env.production.routes` with a real branded domain (e.g. `agents.latwoodtech.work`).

**NEVER expose `*.workers.dev` URLs in user-facing code** — see `CLAUDE.md` hard constraints.

### 5. Secrets — Set via wrangler secret put

Set each secret individually — never in `wrangler.jsonc` vars or source code:

```bash
wrangler secret put JWT_SECRET            --env production  # 32-byte random base64
wrangler secret put ANTHROPIC_API_KEY     --env production  # Anthropic provider key
wrangler secret put GROQ_API_KEY          --env production  # Groq fallback key
wrangler secret put GROK_API_KEY          --env production  # Grok fallback (optional)
wrangler secret put VERTEX_ACCESS_TOKEN   --env production  # GCP Vertex (optional)
```

Generate a JWT secret:
```bash
openssl rand -base64 32
```

### 6. AI_GATEWAY_BASE_URL — CRITICAL: point at prime-self

**WARNING: Do NOT create a new AI Gateway named "agent-gateway".**

The `AI_GATEWAY_BASE_URL` var in `wrangler.jsonc` already points at the provisioned
`prime-self` AI Gateway. Leave it as-is:

```
https://gateway.ai.cloudflare.com/v1/a1c8a33cbe8a3c9e260480433a0dbb06/prime-self
```

An unprovisioned ("ghost") gateway — one that exists in the URL but has NOT been
created in the Cloudflare dashboard — silently returns 401. The `@lwt/llm` complete()
function falls back to direct-provider calls, losing prompt caching and cost attribution
with NO visible error. This broke `daily-brief` on 2026-06-02 (ghost-gateway incident).

If you later want a dedicated `agent-gateway` gateway: provision it in the CF dashboard
first, then update the URL, then `curl`-verify it returns non-401 before deploying.

### 7. Deploy

```bash
# Staging first
wrangler deploy --env staging

# Verify health
curl https://factory-agent-gateway.adrper79.workers.dev/health
# Expected: {"ok":true,"service":"agent-gateway"}

# Production (only after staging is verified)
wrangler deploy --env production

# Verify health on the branded domain
curl https://TODO_REPLACE_BRANDED_DOMAIN/health
# Expected: {"ok":true,"service":"agent-gateway"}
```

A fix is done when you have run `curl` and observed `200` with your own eyes.
CI green = code compiled. curl 200 = it actually works. These are NOT the same.

### 8. Update the Rate-Limiter Registry

After allocating rate-limiter IDs, update `docs/runbooks/add-new-app.md` with the
new entries so the next developer knows the next available ID.

---

## Local Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src --max-warnings 0
npm test            # vitest run --coverage
npm run dev         # wrangler dev (requires .dev.vars for secrets)
```

Create `.dev.vars` (never commit this file):

```ini
JWT_SECRET=dev-jwt-secret-at-least-32-chars-long
ANTHROPIC_API_KEY=your-anthropic-key
GROQ_API_KEY=your-groq-key
```

---

## Testing

Tests run in Vitest (Node/jsdom) without miniflare — DO forwarding is mocked.
To add a test: import the `app` and `Env` from `./index.js`, construct an `Env`
with mock DO stubs, and call `app.request(path, init, env)`.

Coverage gates: 90% lines/functions, 85% branches (see `CLAUDE.md`).
