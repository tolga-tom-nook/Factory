> 📘 **Canonical architecture:** [`docs/architecture/FACTORY_V1.md`](./docs/architecture/FACTORY_V1.md). Read it to understand the system. [`docs/supervisor/FRIDGE.md`](./docs/supervisor/FRIDGE.md) overrides these Standing Orders.

> 🗺️ **Where to look first** (in order):
> 1. [`docs/STATE.md`](./docs/STATE.md) — auto-generated daily; current stage, live numbers, recent decisions, open follow-up debt, oldest APPROVED PRs. **Read this first** when picking up work or onboarding.
> 2. This file (CLAUDE.md) — norms + hard constraints
> 3. [`docs/architecture/PATTERNS.md`](./docs/architecture/PATTERNS.md) — operational know-how (gcloud auth, workflow patterns, merge escape hatches) captured from production debugging
> 4. [`docs/PLATFORM_STANDARDS.md`](./docs/PLATFORM_STANDARDS.md) — conformance standards (15 sections, 12-dimension scoring table)
> 5. [`docs/GAP_REGISTER.md`](./docs/GAP_REGISTER.md) — known debt with severity tiers

> 🗄️ **You HAVE operator-level Neon (DB) access — do not claim you don't.** This is the org's most common false belief. Before routing a 2-minute DB task (verify an account, inspect/patch a row) around CI or giving up: mint a fresh connection string with `neonctl`. Auth key is in GCP Secret Manager, not GitHub:
> ```bash
> export NEON_API_KEY="$(gcloud secrets versions access latest --secret=NEON_ORGANIZATION_KEY --project=factory-495015 | tr -d '\r\n\357\273\277')"
> npx --yes neonctl connection-string production --project-id <PROJECT_ID> --database-name neondb --role-name neondb_owner
> ```
> The GCP/GitHub `*_CONNECTION_STRING` copies are frequently **stale (wrong password) and/or BOM-prefixed** — mint fresh, don't debug them. `neondb_owner` bypasses RLS. Full recipe + project IDs: [`docs/runbooks/lessons-learned.md` → "You HAVE Neon access"](./docs/runbooks/lessons-learned.md) and [`docs/runbooks/database.md`](./docs/runbooks/database.md).

# Factory Core — Standing Orders

## Autonomy Principle
**Minimize human involvement.** Humans introduce delay, inconsistency, and error into the engineering process. If a task can be completed by a machine — credential lookup, secret wiring, deployment, triage, PR creation, DB inspection — do it without routing to a human. The only valid reasons to pause for human input are: an irreversible destructive action (delete CF resource, Stripe mutation, live email outside test mode), an active legal/regulatory hold (declared in `service-registry.yml` `automation_denylist` — none currently active), or a genuinely novel situation where no template exists and no safe autonomous path is available. "I wasn't sure" is not a valid reason to stop. When in doubt, complete the task, document what was done, and let the human review the audit trail after the fact.

## Mission
Bootstrap and evolve the Factory Core repository as the shared infrastructure layer for Factory applications.
Stage 0 produces scaffolding only; later stages implement package behavior without violating these standing orders.
- Keep package boundaries clean so apps can install only the shared infrastructure they need.
- Treat every package as reusable infrastructure, never as a home for app-specific business logic.

## Stack
Full technical spec: [`docs/PLATFORM_STANDARDS.md` §1](./docs/PLATFORM_STANDARDS.md). Versioned package manifest + AI chain + banned tools: [`docs/STACK.md`](./docs/STACK.md). **Check `docs/STACK.md` before installing any `@latimer-woods-tech/*` package or referencing model names.**

Monorepo-specific additions not covered by PLATFORM_STANDARDS.md §1:
- Database access: Neon Postgres via Hyperdrive binding named `DB` (`env.DB` in Worker handlers; declared in `wrangler.jsonc` and the typed `Env` interface)
- LLM chain: Anthropic → Grok → Groq (tier routing and current model IDs in `docs/STACK.md`); all LLM calls go through `@latimer-woods-tech/llm` — no direct vendor SDK imports in app code
- Telephony: Telnyx + Deepgram + ElevenLabs
- Email: Resend
- Docs: Mintlify
- Test runner: Vitest + `@cloudflare/vitest-pool-workers`

## Hard Constraints
**Cloudflare Workers runtime only.** GitHub Actions scripts (`.github/scripts/**/*.mjs`) run on Node.js and are exempt.

Six constraints violated most often — all are CI blockers:
- No `process.env` → use `c.env.VAR` (Hono context) or `env.VAR` (Worker handler binding)
- No Node.js built-ins (`fs`, `path`, `crypto`) → `crypto.subtle`, `TextEncoder`, `Uint8Array`
- No `Buffer` → `Uint8Array`, `TextEncoder`, or `TextDecoder`
- No CommonJS `require()` → ESM `import`/`export` only
- No raw `fetch` without explicit error handling (`.catch()` or try/catch on every call)
- No secrets in source code or in `wrangler.jsonc` `vars` → wrangler secret put or GCP Secret Manager

**Domain rule:** no `*.workers.dev` URLs in any user-facing HTML, JS, API client, or env var shipped to end users. Use the branded domain from `docs/service-registry.yml`. Full rationale: [`docs/PLATFORM_STANDARDS.md` §15](./docs/PLATFORM_STANDARDS.md).

Full constraints list with enforcement details: [`docs/COMPLIANCE_CHECKLIST.md` §B–D](./docs/COMPLIANCE_CHECKLIST.md).

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
- After deploying a Worker to **production**: `curl https://{branded-domain}/health` must return `200` (check `docs/service-registry.yml` for the canonical URL — never use the `.workers.dev` fallback for prod verification)
- After deploying a Worker to **staging**: `curl https://{name}.adrper79.workers.dev/health` is acceptable
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

**Package publication gates** — apply to every `@latimer-woods-tech/*` package shipped to npm:
- TypeScript: zero errors (`npm run typecheck`)
- ESLint: zero warnings (`--max-warnings 0`); no `eslint-disable` without an ADR
- Build: `tsup` produces clean `dist/` with zero errors
- Unit coverage: ≥90% lines and functions, ≥85% branches
- JSDoc: ≥90% of exported symbols carry a one-line doc comment

**App deployment gates** — apply to every Cloudflare Worker deployed to production; see [`docs/PLATFORM_STANDARDS.md` §3–4](./docs/PLATFORM_STANDARDS.md):
- Coverage floors start at 80% line / 85% branch / 70% function, ratcheting to 90/90/85 once stable
- Vitest deterministic mode; every route has a test; Playwright `smoke` tier mandatory
- Sentry initialized, sourcemap upload in deploy workflow, `docs/SLO.md` present

Full checklist for new repos: [`docs/COMPLIANCE_CHECKLIST.md`](./docs/COMPLIANCE_CHECKLIST.md).

## Commit Format
Use `<type>(<scope>): <description>`.
Allowed types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `perf`.
Scope must be the package name without the `@latimer-woods-tech/` prefix.
Example: `feat(errors): add ValidationError with field-level context`

## Error Recovery Protocol
If a build fails:
1. Read the full error instead of guessing.
2. Check the Hard Constraints section above (and [`docs/COMPLIANCE_CHECKLIST.md` §B–D](./docs/COMPLIANCE_CHECKLIST.md)) first; most failures are constraint violations.
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

- **New-Repo Compliance Checklist**: See [docs/COMPLIANCE_CHECKLIST.md](./docs/COMPLIANCE_CHECKLIST.md)
  - §A–Q checklist for onboarding any new standalone app
  - Covers infrastructure provisioning, stack, code patterns, tests, observability, security, schema, workflows, network layer, domain policy, and package gates
  - Conformance score guide at the bottom

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
  - Rate limiter ID registry — check the file for the current next-available ID (changes with each new app)
  - Step-by-step: scripts, workflows, Hyperdrive UUID extraction, secrets
  - Combined with [docs/COMPLIANCE_CHECKLIST.md](./docs/COMPLIANCE_CHECKLIST.md) for the full onboarding checklist

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
