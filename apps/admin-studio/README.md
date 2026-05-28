# Factory Admin Studio

Browser-based control plane for the Factory monorepo. Operate apps, run tests, edit code with AI, deploy — all without leaving the browser, with **environment-safe** defaults.

> 📘 **Plan & specs**: see [`docs/admin-studio/00-MASTER-PLAN.md`](../../docs/admin-studio/00-MASTER-PLAN.md) and [`docs/admin-studio/01-ENVIRONMENT-SAFETY.md`](../../docs/admin-studio/01-ENVIRONMENT-SAFETY.md).

---

## What's in this folder

This is the **API Worker**. It handles auth, audit, environment context enforcement, and proxies actions to GitHub Actions / Cloudflare / Neon.

The UI lives at [`apps/admin-studio-ui`](../admin-studio-ui/).
Shared types live at [`packages/studio-core`](../../packages/studio-core/).

```
apps/admin-studio/
├── src/
│   ├── index.ts                       # Hono entrypoint
│   ├── env.ts                         # Worker bindings/secrets typing
│   ├── types.ts                       # Hono AppEnv (Bindings + Variables)
│   ├── middleware/
│   │   ├── cors.ts                    # Strict allow-list CORS
│   │   ├── request-id.ts              # X-Request-Id correlation
│   │   ├── env-context.ts             # JWT verify + cross-env attack guard
│   │   ├── audit.ts                   # Append to studio_audit_log
│   │   └── require-confirmation.ts    # Enforce confirmation tier per env+reversibility
│   └── routes/
│       ├── auth.ts                    # POST /auth/login (env-locked JWT)
│       ├── me.ts                      # GET  /me/  current session
│       ├── tests.ts                   # POST /tests/runs (dispatch suites)
│       ├── deploy.ts                  # POST /deploys (tiered confirmation)
│       └── ai.ts                      # POST /ai/chat (LLM proxy)
└── migrations/
    └── 0001_studio_audit_log.sql      # Append-only audit table
```

## Phase A scope (this commit)

✅ **Foundation only** — every file is real, every safeguard wires through, but most routes return stub data. Phases B–H replace stubs with full implementations per the master plan.

What works end-to-end today:

1. `POST /auth/login` — issues an env-locked HS256 JWT (Web Crypto, no `jsonwebtoken`)
2. JWT middleware rejects cross-env tokens with `403 Environment mismatch`
3. Session expiry: 4h prod, 24h staging/local
4. `requireConfirmation` middleware enforces tier-based confirmation per env+reversibility matrix
5. `auditMiddleware` redacts secrets and emits structured log entries
6. UI ([`apps/admin-studio-ui`](../admin-studio-ui/)) login flow forces env selection before sign-in
7. Persistent `EnvironmentBanner` component (gray=local, amber=staging, red=production)
8. `ConfirmDialog` with type-to-confirm + cooldown timer for tier 2/4 actions
9. `/health` returns the worker's bound `STUDIO_ENV` for `curl`-based verification

## Local dev

```bash
# 1. Worker (this folder)
cd apps/admin-studio
cp .dev.vars.example .dev.vars   # fill JWT_SECRET, GITHUB_TOKEN, ANTHROPIC_API_KEY, STUDIO_WEBHOOK_SECRET
npm install
npm run dev                       # → http://localhost:8787

# 2. UI (in another shell)
cd apps/admin-studio-ui
npm install
npm run dev                       # → http://localhost:5173 (proxies /api → :8787)
```

Health check:

```bash
curl http://localhost:8787/health
# { "status":"ok", "env":"local", "service":"admin-studio", ... }
```

## Deploy

```bash
# Staging
npm run deploy:staging
curl https://api.admin.latimerwoods.dev/health

# Production (requires owner role + type-to-confirm in UI)
npm run deploy:production
curl https://api.apunlimited.com/health
```

⚠ Before deploy: set `hyperdrive.id` for both envs in [`wrangler.jsonc`](./wrangler.jsonc) and run `wrangler secret put` for `JWT_SECRET`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, and `STUDIO_WEBHOOK_SECRET`.

## Quality gates

```bash
npm run typecheck     # zero errors
npm test              # 90%+ coverage target
npm run lint          # zero warnings (--max-warnings 0)
```

## Hard constraints (enforced)

- Cloudflare Workers runtime only — no Node.js APIs
- Hono router only
- Web Crypto for JWT — no `jsonwebtoken`
- ESM-only — no `require()`
- All secrets via `wrangler secret put` — never in `wrangler.jsonc` `vars`
- All mutating routes must call `requireConfirmation()` with their reversibility tier

## Roadmap

| Phase | Scope                                                | Status         |
|-------|------------------------------------------------------|----------------|
| A     | Foundation: auth, env safety, audit middleware, UI shell | ✅ this commit |
| B     | Real users + RLS via `@latimer-woods-tech/neon`            | next           |
| C     | GitHub Actions test-runner + SSE streaming           |                |
| D     | Deploy + rollback + secret rotation flows            |                |
| E     | AI chat: Monaco diff editor + repo context + PR proposals |           |
| F     | Multi-app dashboard (Wordis Bond, Cypher, Prime Self, Schedule) |     |
| G     | Two-person approvals + Slack notifications + on-call rotation |       |
| H     | Hidden-needs polish: keyboard shortcuts, command palette, themes |    |

See [`docs/admin-studio/00-MASTER-PLAN.md`](../../docs/admin-studio/00-MASTER-PLAN.md) for the full feature inventory across all 8 tiers.
