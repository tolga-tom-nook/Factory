# Stack Manifest

> **Machine-readable. Auto-updated by CI on every package publish.**
> External tooling versions are hand-maintained here.
> Downstream repos: pointer to this file in `CLAUDE.md` — do NOT copy-paste; copies drift.

*Last updated: 2026-06-05 (auto-update: see `.github/workflows/update-stack-manifest.yml`)*

---

## Shared Packages (`@latimer-woods-tech/*`)

<!-- AUTO-UPDATED-START -->
| Package | Version | Status |
|---------|---------|--------|
| `@latimer-woods-tech/admin` | `0.3.0` | stable |
| `@latimer-woods-tech/agent` | `0.6.0` | stable |
| `@latimer-woods-tech/analytics` | `0.2.0` | stable |
| `@latimer-woods-tech/auth` | `0.2.0` | stable |
| `@latimer-woods-tech/biome-config` | `0.1.0` | stable |
| `@latimer-woods-tech/bodygraph` | `0.1.0` | stable |
| `@latimer-woods-tech/browser` | `0.1.0` | stable |
| `@latimer-woods-tech/compliance` | `0.3.0` | stable |
| `@latimer-woods-tech/content` | `0.2.0` | stable |
| `@latimer-woods-tech/copy` | `0.2.0` | stable |
| `@latimer-woods-tech/creator` | `0.1.0` | stable |
| `@latimer-woods-tech/crm` | `0.3.0` | stable |
| `@latimer-woods-tech/deploy` | `0.2.0` | stable |
| `@latimer-woods-tech/design-system` | `0.1.0` | stable |
| `@latimer-woods-tech/design-tokens` | `0.2.0` | stable |
| `@latimer-woods-tech/email` | `0.2.0` | stable |
| `@latimer-woods-tech/entitlements` | `0.1.0` | stable |
| `@latimer-woods-tech/errors` | `0.1.0` | stable |
| `@latimer-woods-tech/eslint-config` | `0.1.0` | stable |
| `@latimer-woods-tech/flags` | `0.1.0` | stable |
| `@latimer-woods-tech/llm` | `0.4.4` | stable |
| `@latimer-woods-tech/llm-meter` | `0.2.4` | stable |
| `@latimer-woods-tech/logger` | `0.3.0` | stable |
| `@latimer-woods-tech/monitoring` | `0.2.1` | stable |
| `@latimer-woods-tech/neon` | `0.2.3` | stable |
| `@latimer-woods-tech/protocol` | `0.1.0` | stable |
| `@latimer-woods-tech/realtime` | `0.1.0` | stable |
| `@latimer-woods-tech/schedule` | `0.2.3` | stable |
| `@latimer-woods-tech/seo` | `0.2.0` | stable |
| `@latimer-woods-tech/social` | `0.2.0` | stable |
| `@latimer-woods-tech/stripe` | `0.2.0` | stable |
| `@latimer-woods-tech/studio-core` | `0.1.0` | stable |
| `@latimer-woods-tech/telephony` | `0.3.0` | stable |
| `@latimer-woods-tech/testing` | `0.3.0` | stable |
| `@latimer-woods-tech/tsconfig-base` | `0.1.0` | stable |
| `@latimer-woods-tech/ui` | `0.2.0` | stable |
| `@latimer-woods-tech/validation` | `0.1.0` | stable |
| `@latimer-woods-tech/video` | `0.3.0` | stable |
| `@latimer-woods-tech/video-studio` | `0.1.0` | stable |
<!-- AUTO-UPDATED-END -->

---

## Runtime & Infrastructure

| Layer | Technology | Notes |
|-------|-----------|-------|
| **Runtime** | Cloudflare Workers | Compatibility date in each `wrangler.jsonc` |
| **Router** | Hono 4.x | Never Express, Fastify, or Next.js |
| **Build** | tsup | ESM only |
| **Test** | Vitest + `@cloudflare/vitest-pool-workers` | Real CF bindings in tests |
| **Database** | Neon Postgres via Hyperdrive | `env.DB` binding; Drizzle ORM |
| **Auth** | JWT / Web Crypto API | Self-managed — never `jsonwebtoken` |
| **Docs** | Mintlify | Deployed from `docs/` on every push to `main` |
| **Registry** | npm | `@latimer-woods-tech/*` public scope |
| **Storage** | Cloudflare R2 | S3-compatible; video assets, static files |
| **Realtime** | Cloudflare Durable Objects | `@latimer-woods-tech/realtime` |
| **Language** | TypeScript strict | Zero `any` in public APIs |

---

## AI / LLM Chain

All calls go through **Cloudflare AI Gateway** — mandatory, no direct vendor hits.  
Tier routing lives in `@latimer-woods-tech/llm` (`fast | balanced | smart | verifier`).

| Tier | Provider / Model | Notes |
|------|-----------------|-------|
| **smart** | Anthropic — Claude Opus 4.7 | Managed Agents GA; primary for complex reasoning |
| **balanced** | Anthropic — Claude Sonnet | Default for most tasks |
| **fast** | Groq — `llama-3.3-70b-versatile` | Low-latency; streaming |
| **verifier** | Groq — `llama-4-maverick` | Output validation and grounding check; replaces `llama-3.3-70b-versatile` (verifier role) |
| **long-context (>150k tokens)** | Gemini 2.5 Pro | Auto-fallback in `@latimer-woods-tech/llm` |
| **xAI / Grok** | Grok 3 | Active — check `@latimer-woods-tech/llm` for current tier assignment |
| **gateway** | Cloudflare AI Gateway | All tiers route through this; no exceptions |

---

## Vendor Services

| Service | Provider | Package |
|---------|----------|---------|
| Telephony | Telnyx + Deepgram + ElevenLabs | `@latimer-woods-tech/telephony` |
| Email | Resend | `@latimer-woods-tech/email` |
| Error tracking | Sentry (org: `latwood-tech`) | `@latimer-woods-tech/monitoring` |
| Analytics | PostHog + `factory_events` D1 | `@latimer-woods-tech/analytics` |
| Payments | Stripe (restricted keys per app) | `@latimer-woods-tech/stripe` |
| Infrastructure / DNS | Cloudflare | — |

---

## Banned Tools

**Never use these** in any Factory app or package:

| Banned | Use instead |
|--------|-------------|
| Express, Fastify, Next.js | Hono on Cloudflare Workers |
| `jsonwebtoken` | Web Crypto API (self-managed JWT) |
| Node.js built-ins (`fs`, `path`, `crypto`) | Cloudflare Workers-compatible APIs |
| `require()` / CommonJS | ESM `import` / `export` only |
| `Buffer` | `Uint8Array`, `TextEncoder`, `TextDecoder` |
| `process.env` | Hono/Worker bindings (`c.env.VAR`) |
| `axios` | `fetch` with explicit error handling |

---

## Consuming Shared Packages

1. Check the versions table above before pinning in `package.json`
2. Read per-package Mintlify docs for consumption guides
3. Follow the dependency install order in `CLAUDE.md` (Package Dependency Order section)
4. New app? See [`docs/NEW_APP_CHECKLIST.md`](./NEW_APP_CHECKLIST.md)

---

*Auto-update script: [`scripts/update-stack-manifest.js`](../scripts/update-stack-manifest.js)*  
*Trigger: [`.github/workflows/update-stack-manifest.yml`](../.github/workflows/update-stack-manifest.yml) — fires after every package publish*  
*Doc health check: [`.github/workflows/doc-freshness-audit.yml`](../.github/workflows/doc-freshness-audit.yml) — weekly, Monday 9 AM UTC*
