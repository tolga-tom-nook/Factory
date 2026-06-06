> 📘 **Canonical architecture:** [`docs/architecture/FACTORY_V1.md`](./docs/architecture/FACTORY_V1.md). Read it to understand the system. [`docs/supervisor/FRIDGE.md`](./docs/supervisor/FRIDGE.md) overrides these Standing Orders.

> 🗺️ **Where to look first** (in order):
> 1. [`docs/STATE.md`](./docs/STATE.md) — auto-generated daily; current stage, live numbers, recent decisions, open follow-up debt, oldest APPROVED PRs. **Read this first** when picking up work or onboarding.
> 2. This file (CLAUDE.md) — norms + hard constraints
> 3. [`docs/architecture/PATTERNS.md`](./docs/architecture/PATTERNS.md) — operational know-how (gcloud auth, workflow patterns, merge escape hatches) captured from production debugging
> 4. [`docs/PLATFORM_STANDARDS.md`](./docs/PLATFORM_STANDARDS.md) — what we build (the 10 conformance dimensions)
> 5. [`docs/GAP_REGISTER.md`](./docs/GAP_REGISTER.md) — known debt with severity tiers

> 🗄️ **You HAVE operator-level Neon (DB) access — do not claim you don't.** This is the org's most common false belief. Before routing a 2-minute DB task (verify an account, inspect/patch a row) around CI or giving up: mint a fresh connection string with `neonctl`. Auth key is in GCP Secret Manager, not GitHub:
> ```bash
> export NEON_API_KEY="$(gcloud secrets versions access latest --secret=NEON_ORGANIZATION_KEY --project=factory-495015 | tr -d '\r\n\357\273\277')"
> npx --yes neonctl connection-string production --project-id <PROJECT_ID> --database-name neondb --role-name neondb_owner
> ```
> The GCP/GitHub `*_CONNECTION_STRING` copies are frequently **stale (wrong password) and/or BOM-prefixed** — mint fresh, don't debug them. `neondb_owner` bypasses RLS. Full recipe + project IDs: [`docs/runbooks/lessons-learned.md` → "You HAVE Neon access"](./docs/runbooks/lessons-learned.md) and [`docs/runbooks/database.md`](./docs/runbooks/database.md).

# Factory Core — Standing Orders

## Autonomy Principle
**Minimize human involvement.** Humans introduce delay, inconsistency, and error into the engineering process. If a task can be completed by a machine — credential lookup, secret wiring, deployment, triage, PR creation, DB inspection — do it without routing to a human. The only valid reasons to pause for human input are: an irreversible destructive action (delete CF resource, Stripe mutation, live email outside test mode), a regulatory gate (wordis-bond TCPA), or a genuinely novel situation where no template exists and no safe autonomous path is available. "I wasn't sure" is not a valid reason to stop. When in doubt, complete the task, document what was done, and let the human review the audit trail after the fact.

## Mission
Bootstrap and evolve the Factory Core repository as the shared infrastructure layer for Factory applications.
Stage 0 produces scaffolding only; later stages implement package behavior without violating these standing orders.
- Keep package boundaries clean so apps can install only the shared infrastructure they need.
- Treat every package as reusable infrastructure, never as a home for app-specific business logic.

## Stack
> **Versioned manifest (packages + AI chain + banned tools):** [`docs/STACK.md`](./docs/STACK.md). Check there before installing any `@latimer-woods-tech/*` package or referencing model names.

- Runtime: Cloudflare Workers only
- Router: Hono (never Express, Fastify, Next.js)
- Database: Neon Postgres via Hyperdrive binding (`env.DB`)
- Auth: JWT self-managed with the Web Crypto API (never `jsonwebtoken`)
- LLM chain: Anthropic → Grok → Groq — see [`docs/STACK.md`](./docs/STACK.md) for tier routing and current model names
- Telephony: Telnyx + Deepgram + ElevenLabs
- Email: Resend
- Errors: Sentry via `@latimer-woods-tech/monitoring`
- Analytics: PostHog plus the first-party `factory_events` table
- Docs: Mintlify
- Build: tsup (ESM only)
- Test: Vitest + `@cloudflare/vitest-pool-workers`
- Language: TypeScript strict with zero `any` in public APIs

## Hard Constraints
**These constraints apply to production code (Cloudflare Workers runtime only).** GitHub Actions scripts (`.github/scripts/**/*.mjs`) run on Node.js and are exempt from these Cloudflare constraints.
- No `process.env` anywhere; use Hono or Worker bindings (`c.env.VAR` / `env.VAR`)
- No Node.js built-ins such as `fs`, `path`, or `crypto`; use platform-safe APIs
- No CommonJS `require()`; use ESM `import` / `export` only
- No `Buffer`; use `Uint8Array`, `TextEncoder`, or `TextDecoder`
- No raw `fetch` without explicit error handling
- No secrets in source code or in `wrangler.jsonc` `vars`
- No `*.workers.dev` URLs in any user-facing HTML, JS, or API client code — every user-facing worker endpoint must have a branded custom domain (e.g. `api.selfprime.net`, `api.itsjusus.com`). The `.workers.dev` URL is the CF infrastructure fallback and must never be exposed to end users or hardcoded in frontend assets. Check `docs/service-registry.yml` for the canonical `url` field; use that, never `workers_dev_url`.

## Sub-Agent Isolation (STOP — read before invoking the Agent tool)
**Any sub-agent invoked via the `Agent` tool that does anything beyond pure read-only research MUST be spawned with `isolation: "worktree"`.** Without it, parallel agents share the same working tree — they will `git checkout` over each other's edits, `git reset --hard` will wipe another agent's in-flight uncommitted work, and background processes (wrangler deploys, builds) get killed mid-flight by another agent's branch operation.

Read-only exceptions (no isolation needed): `Explore`, `claude-code-guide`, `Plan`, `statusline-setup`. Everything else — including `general-purpose` and the default `claude` agent when given write tasks — must isolate.

Pattern: `Agent({ subagent_type: "general-purpose", isolation: "worktree", description: "...", prompt: "..." })`.

This rule exists because of repeated, expensive failures: see `docs/runbooks/git-hooks.md` for the local safety net that catches the wrong-branch commit class of errors, and enable it per-clone with `git config core.hooksPath .githooks`.

## Worker Rename Protocol (STOP — read this before changing any wrangler.jsonc `name`)
Never rename a worker without completing this checklist in order:
1. Open `docs/service-registry.yml` and find the worker's `consumers` list
2. Search every listed file for the old `workers.dev` URL (e.g. `grep -r "prime-self.adrper79.workers.dev"`)
3. Update ALL consumer files to use the new URL
4. Commit, push, and deploy consumers — verify via `curl` before continuing
5. Update `name` in `wrangler.jsonc` — remove any stale `migrations` blocks that don't apply to the new name
6. Deploy the worker — verify `/health` returns `200` via `curl`
7. Update `docs/service-registry.yml` with the new name and URL

Cloudflare workers.dev URLs are account-scoped: `{name}.{account-subdomain}.workers.dev`.
For this account: `{name}.adrper79.workers.dev`. Never use the short form `{name}.workers.dev`.

## Verification Requirement (STOP — read this before declaring anything "working")
Never declare a fix "done" or "working" based on CI green alone.
A fix is done when you have run `curl` and observed the expected HTTP status code with your own eyes.
- After deploying a Worker: `curl https://{name}.adrper79.workers.dev/health` must return `200`
- After deploying Pages: `curl https://{custom-domain}/` must return `200`
- After fixing a login flow: `curl -X POST .../auth/login` with bad creds must return `401` (not `000` or `5xx`)
CI green = code compiled. `curl` 200 = it actually works. These are not the same thing.

## Package Dependency Order
1. `@latimer-woods-tech/errors` (no deps)
2. `@latimer-woods-tech/monitoring` (deps: errors)
3. `@latimer-woods-tech/logger` (deps: errors, monitoring)
4. `@latimer-woods-tech/realtime` (deps: errors) — Cloudflare Durable Object WebSocket Hibernation API base class
5. `@latimer-woods-tech/auth` (deps: errors, logger)
6. `@latimer-woods-tech/neon` (deps: errors, logger)
7. `@latimer-woods-tech/stripe` (deps: errors, logger, neon)
8. `@latimer-woods-tech/llm` (deps: errors, logger)
9. `@latimer-woods-tech/telephony` (deps: errors, logger, llm)
10. `@latimer-woods-tech/analytics` (deps: errors, neon)
11. `@latimer-woods-tech/deploy` (no deps; scripts only)
12. `@latimer-woods-tech/testing` (no deps; mock factories)
13. `@latimer-woods-tech/email` (deps: errors, logger)
14. `@latimer-woods-tech/copy` (deps: llm)
15. `@latimer-woods-tech/content` (deps: neon, copy)
16. `@latimer-woods-tech/social` (deps: content)
17. `@latimer-woods-tech/seo` (no deps)
18. `@latimer-woods-tech/crm` (deps: neon, analytics)
19. `@latimer-woods-tech/compliance` (deps: neon)
20. `@latimer-woods-tech/admin` (deps: auth, analytics)
21. `@latimer-woods-tech/video` (deps: errors) — Cloudflare Stream + R2 wrappers
22. `@latimer-woods-tech/schedule` (deps: errors, neon, video) — video production calendar + priority scoring
23. `@latimer-woods-tech/validation` (no deps; deterministic output quality gates)
24. `@latimer-woods-tech/browser` (deps: errors, logger) — Workers-compatible Browser Run package wrapper
25. `@latimer-woods-tech/bodygraph` (no deps) — canonical Energy Blueprint body-graph engine; runtime-agnostic SVG-string renderer (film/web/PDF share it)

## Video Production Pipeline

The automated video engine runs **outside Workers** (needs real Chromium + ffmpeg). End-to-end pipeline is operational as of 2026-05-20; first live video at https://capricast.com/watch/5209dd21-71a8-4ee4-afeb-0c030ade1a70.

```
PostHog engagement signals
  → scorePriority() → schedule-worker video_calendar row
  → apps/video-cron (hourly cron Worker) → workflow_dispatch
  → .github/workflows/render-video.yml:
      1. LLM headline + narration script (Anthropic Claude Haiku 4.5)
      2. ElevenLabs narration (MP3 → R2)
      3. Remotion render (MP4)
      4. ffmpeg encode (H.264 baseline + AAC)
      5. MP4 → R2
      6. Cloudflare Stream `/copy` + poll until ready
      7. POST /api/admin/videos/import on Capricast worker
      8. PATCH schedule-worker job → status=done
  → Capricast watch page renders enriched VideoObject JSON-LD with
    transcript, twitter:player card, author/publisher/interactionStatistic
```

**Operational runbook (read this before debugging):** [`docs/runbooks/video-pipeline.md`](./docs/runbooks/video-pipeline.md) — full secret matrix, manual test recipe, and the load-bearing gotchas list (GCP secret UTF-8 BOM trap, broken Drizzle ledger, Capricast Pages project named `videoking`, etc.).

> ⚠️ **Correction (2026-06-02):** the long-claimed "dead `ANTHROPIC_API_KEY`" is a MYTH — live-tested, both `ANTHROPIC_API_KEY` and `LATIMER_ANTHROPIC_API` GCP SM secrets are valid. LLM failures previously blamed on a "stale key" were actually a **non-existent CF AI Gateway returning 401** (CF 401s an unknown gateway name, which looks identical to a bad key from inside `@latimer-woods-tech/llm`). See [`docs/runbooks/lessons-learned.md` → "AI Gateway ghosts"](./docs/runbooks/lessons-learned.md). The `verify-ai-gateway.mjs` deploy preflight now hard-fails on a ghost gateway.

**Secrets are sourced from GCP Secret Manager via WIF**, NOT GitHub Actions repo secrets. The render-video.yml workflow runs `scripts/fetch_gcp_secrets.sh` after authenticating with `google-github-actions/auth@v3`. All workflow env vars are populated from GCP at runtime. New secrets must be created in factory-495015 with `printf '%s'` (NOT `echo`) to avoid the trailing-newline trap, and granted to the `factory-sa@factory-495015.iam.gserviceaccount.com` WIF identity. See the runbook for the full matrix.

Local package dependencies the render step builds (in order): `errors`, `monitoring`, `logger`, `neon`, `llm`, `video`, `schedule`. The `llm` package is what supplies `complete()` — the workflow's `generate-script.mjs` shims `withSystem` locally since the package doesn't export that helper.

**Never** run Remotion or ffmpeg in a Cloudflare Worker — they require Node.js + real compute. The video-cron Worker only dispatches; the actual render runs on `ubuntu-latest` in GitHub Actions.

## Quality Gates
- TypeScript strict: zero errors
- ESLint: zero warnings with `--max-warnings 0`
- Unit coverage: at least 90% lines and functions, at least 85% branches
- Build: `tsup` produces `dist/` with no errors
- JSDoc: at least 90% of exported symbols documented

## Commit Format
Use `<type>(<scope>): <description>`.
Allowed types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `perf`.
Scope must be the package name without the `@latimer-woods-tech/` prefix.
Example: `feat(errors): add ValidationError with field-level context`

## Error Recovery Protocol
If a build fails:
1. Read the full error instead of guessing.
2. Check the Hard Constraints list first; most failures are constraint violations.
3. Fix the root cause; never suppress with `@ts-ignore` or `eslint-disable`.
4. Re-run the full quality gate sequence before continuing.
5. If blocked after two attempts, write `BLOCKED.md`, explain the blocker, and stop.

## Session Start Checklist
Before writing any code:
1. Read `CLAUDE.md` completely.
2. Read the package's existing `src/index.ts`.
3. Run `npm run typecheck` and note existing errors.
4. Run `npm test` and note the current coverage baseline.
5. Check `git log --oneline -10` to understand recent changes.
6. Confirm the phase being built by checking `/prompts/`.

## Documentation Reference

**Before troubleshooting, check these docs first:**

- **Secrets & Tokens**: See [docs/runbooks/github-secrets-and-tokens.md](./docs/runbooks/github-secrets-and-tokens.md)
  - Explains CloudFlare token naming (`CF_API_TOKEN` vs. `CLOUDFLARE_API_TOKEN`)
  - Complete GitHub Secrets inventory
  - Rotation schedules
  - Troubleshooting common auth failures

- **Lessons Learned**: See [docs/runbooks/lessons-learned.md](./docs/runbooks/lessons-learned.md)
  - Common errors with resolutions
  - Hard constraints enforcement
  - Patterns that work (middleware, env setup, error handling)
  - Version & publishing strategy
  - Quality gate checklist

- **Environment Isolation & Verification**: See [docs/runbooks/environment-isolation-and-verification.md](./docs/runbooks/environment-isolation-and-verification.md)
  - How layered config prevents environment mixups (wrangler.jsonc, GitHub Actions, runtime checks)
  - Verification workflow: `/health` endpoint patterns
  - Anti-patterns to avoid (optional fields, wrong secret locations)
  - Pre-deploy verification checklist

- **Deployment**: See [docs/runbooks/deployment.md](./docs/runbooks/deployment.md)
  - Staging vs. production environments
  - Smoke-test procedures
  - Health checks

- **Secret Rotation**: See [docs/runbooks/secret-rotation.md](./docs/runbooks/secret-rotation.md)
  - How to rotate JWT_SECRET, DATABASE_URL, etc.
  - Downtime-free rotation procedures

- **App README Template**: See [docs/APP_README_TEMPLATE.md](./docs/APP_README_TEMPLATE.md)
  - Setup instructions for new developers
  - Local development (.dev.vars) vs. staging vs. production
  - Troubleshooting common issues
  - Use as basis for each app's README.md

- **Getting Started**: See [docs/runbooks/getting-started.md](./docs/runbooks/getting-started.md)
  - First-time local dev setup (clone, `.npmrc`, `.dev.vars`, `wrangler dev`)
  - Running tests and typechecks locally
  - Verifying the health endpoint

- **Add a New Standalone App**: See [docs/runbooks/add-new-app.md](./docs/runbooks/add-new-app.md)
  - Rate limiter ID registry (1001–1008 currently allocated; next is 1009)
  - Step-by-step: scripts, workflows, Hyperdrive UUID extraction, secrets
  - Checklist for the full onboarding flow

- **Database & Migrations**: See [docs/runbooks/database.md](./docs/runbooks/database.md)
  - Neon branch strategy (main / staging / ephemeral PR branches)
  - Running Drizzle migrations
  - Row-level security patterns

- **SLO & Observability**: See [docs/runbooks/slo.md](./docs/runbooks/slo.md)
  - Availability target (99.9%), error budget, alert thresholds
  - Sentry alert rules and PostHog funnel monitoring
  - Incident response tiers (P1–P4)

- **App Transfer**: See [docs/runbooks/transfer.md](./docs/runbooks/transfer.md)
  - Pre-transfer checklist (archive factory_events, confirm no coupling)
  - GitHub repo, Neon database, Cloudflare Worker transfer steps
  - Secret handoff procedure

- **Environment Verification Setup**: See [docs/ENVIRONMENT_VERIFICATION_SETUP.md](./docs/ENVIRONMENT_VERIFICATION_SETUP.md)
  - How to add verification script to each app
  - Automated environment checks before `npm run dev`
  - Catches configuration errors early
  - Ready-to-use `.dev.vars.example` template

- **Phase 6 Execution Checklist**: See [PHASE_6_CHECKLIST.md](./PHASE_6_CHECKLIST.md)
  - Step-by-step infrastructure provisioning (Neon, Hyperdrive, Sentry, PostHog)
  - Database schema setup
  - Rate limiter configuration
  - Centralized secret management
  - Verification checklist before Phase 7
  - Rollback procedures

## Automation Scripts

**Phase 6 Infrastructure:**
- `scripts/phase-6-orchestrator.mjs` — Orchestrates all Phase 6 infrastructure provisioning
  - Validates credentials (GitHub, CloudFlare, Neon)
  - Provisions Neon databases
  - Creates Hyperdrive instances
  - Creates GitHub repositories
  - Wires GitHub + Wrangler secrets
  - Run: `node scripts/phase-6-orchestrator.mjs --dry-run` to test first

- `scripts/phase-6-setup.js` — Legacy: supports manual Phase 6 credential management

**Phase 7 App Scaffolding:**
- `scripts/phase-7-scaffold-template.mjs` — Template for Phase 7 agents to scaffold apps
  - Calls scaffold.mjs to generate app structure
  - Installs app-specific packages
  - Generates Drizzle schemas (canonical per app)
  - Runs migrations
  - Applies RLS policies
  - Commits and pushes scaffolding
  - Run: `npm run phase-7:scaffold -- {app-name} --hyperdrive-id {id} --rate-limiter-id {id}`

- `scripts/phase-7-validate.js` — Validates that app repos are properly scaffolded before Phase 7 agents begin
  - Run: `node scripts/phase-7-validate.js --all`

## Stage Discipline
- Stage 0 stops at scaffolding and repository policy setup only.
- Do not start package implementations until the matching prompt exists in `/prompts/`.
- Preserve the documented dependency order to avoid circular imports between packages.
