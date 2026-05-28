---
date: 2026-05-25
status: navigation-index
companion-to: docs/architecture/ADMIN_TECHNICAL_GUIDE.md, docs/architecture/FACTORY_V1.md, docs/decisions/2026-05-25-factory-alignment.md
---

# Factory Surfaces — Navigation Index

> **What this is.** A single map of the 15 platform surfaces — for any human or agent landing in the repo, this is where to look first to find which doc/code/state corresponds to which concern. Pure index; canonical content lives in the linked documents.
>
> **What this is NOT.** Not a roadmap. Not a backlog. Not a per-surface ownership matrix (we have one operator). It exists to answer one question: *"the X surface — where is it?"*

---

## The 15 surfaces

### 1. Admin surface
Internal operator-facing UI + admin routes across apps.
- **Canonical doc:** [`ADMIN_TECHNICAL_GUIDE.md`](ADMIN_TECHNICAL_GUIDE.md) §1.8 (per-app `/admin/*` route standards) + §2.5 (read-layer Admin UI)
- **Code:** `apps/admin-studio`, `apps/admin-studio-ui`, per-app `workers/src/handlers/admin.ts`
- **State:** `factory_audit_log` (Neon factory-core), per-app admin DBs
- **Entry point:** `https://apunlimited.com` (production), `https://staging.admin.latimerwoods.dev` (staging)
- **Auth:** Latwood Tech Google Workspace allowlist, with break-glass credentials managed through the same policy.

### 2. Operator surface
Where Adrian + future operators interact with the system day-to-day.
- **Canonical doc:** [`FACTORY_V1.md`](FACTORY_V1.md) §5 (delivery lifecycle), [`docs/STATE.md`](../STATE.md)
- **Tools:** GitHub Issues + Projects v2 (`PVT_kwDOEL0sNc4BWWtg`), Slack, Pushover (`conn_iR1TgasqajZH`), Claude Code, Telnyx SMS backup
- **State:** GitHub Issues = canonical kanban (FRIDGE rule 7)
- **Entry point:** [LatWood Operations board](https://github.com/orgs/Latimer-Woods-Tech/projects/1)

### 3. Developer surface
The IDE + CLI environment where code is written.
- **Canonical doc:** [`CLAUDE.md`](../../CLAUDE.md) (standing orders for LLM agents), [`FACTORY_V1.md`](FACTORY_V1.md) §1-§3
- **Tools:** VS Code + Claude Code, Git Bash / PowerShell on Windows, `gh` CLI
- **State:** Local clones + `.claude/` configs
- **Entry point:** `git clone Latimer-Woods-Tech/<repo>` + read CLAUDE.md

### 4. CI/CD surface
Continuous integration, reusable workflows, deploys, canaries.
- **Canonical doc:** [`FACTORY_V1.md`](FACTORY_V1.md) §3.3 (reusable workflows), [`ADMIN_BUILD_PLAN.md`](ADMIN_BUILD_PLAN.md) §1.3 (mature-engineering defaults)
- **Code:** `.github/workflows/_app-*.yml` reusable workflows in Factory
- **State:** GitHub Actions runs, workflow run logs
- **Entry point:** [`.github/workflows/REGISTRY.md`](../../.github/workflows/REGISTRY.md)

### 5. Supply-chain surface
SHA pinning, Dependabot, dependency review, secret scanning.
- **Canonical doc:** [`ADMIN_TECHNICAL_GUIDE.md`](ADMIN_TECHNICAL_GUIDE.md) §1.6 (supply chain hardening)
- **Code:** `.github/dependabot.yml`, `.github/workflows/credential-scrub.yml`, `.github/workflows/dependency-review.yml`, `scripts/pin-action-shas.mjs` (Tier 0 ship)
- **State:** Dependabot PRs, GHAS Secret Protection findings, `sha_pinning_required` per repo
- **Entry point:** [`docs/runbooks/secret-rotation.md`](../runbooks/secret-rotation.md)

### 6. Cloud / runtime surface
Cloudflare Workers + Pages + R2 + Stream + KV; GCP Cloud Run + Secret Manager + WIF; Neon Postgres.
- **Canonical doc:** [`FACTORY_V1.md`](FACTORY_V1.md) §3.1 (L1 Runtime), [`docs/service-registry.yml`](../service-registry.yml)
- **Code:** Per-app `wrangler.jsonc`, per-app `apps/<app>/`
- **State:** Cloudflare account `a1c8a33cbe8a3c9e260480433a0dbb06`, GCP project `factory-495015`, Neon org `org-withered-wave-19602339`
- **Entry point:** `service-registry.yml` (canonical service → URL map)

### 7. Data surface
Application + platform databases, migrations, mirrors.
- **Canonical doc:** [`ADMIN_TECHNICAL_GUIDE.md`](ADMIN_TECHNICAL_GUIDE.md) §2 (read-layer schemas), [`FACTORY_V1.md`](FACTORY_V1.md) §4.6, [`docs/runbooks/database.md`](../runbooks/database.md)
- **Tables:** `factory_events_ingest`, `factory_gates`, `factory_artifacts`, `factory_runs_mirror`, `factory_audit_log` (read layer); D1 `supervisor_runs` (truth)
- **State:** Neon project `THE_FACTORY` (`morning-dust-88304389`) + per-app Neon projects; D1 in `apps/supervisor`
- **Entry point:** [`docs/runbooks/database.md`](../runbooks/database.md) for migration discipline

### 8. Product / media surface
End-user content + the video production pipeline.
- **Canonical doc:** [`CLAUDE.md`](../../CLAUDE.md) Video Production Pipeline section, [`docs/runbooks/video-pipeline.md`](../runbooks/video-pipeline.md)
- **Code:** `apps/video-cron`, `apps/video-studio`, `.github/workflows/render-video.yml`, `apps/schedule-worker`
- **State:** Cloudflare Stream UIDs, R2 buckets, capricast `video_calendar` table
- **Entry point:** Capricast publish endpoint (Worker route on `api.capricast.com`)

### 9. Marketing surface
Public consumer-facing pages.
- **Canonical doc:** [`ADMIN_TECHNICAL_GUIDE.md`](ADMIN_TECHNICAL_GUIDE.md) §1.7 (marketing surface standards)
- **Code:** selfprime marketing HTML in HD repo, capricast public pages, `apps/latwoodtech-web`
- **State:** Cloudflare Pages deployments, Lighthouse CI reports
- **Entry point:** [`docs/PRODUCT_PRINCIPLES.md`](../PRODUCT_PRINCIPLES.md) §8 (vocab carveout)

### 10. Customer / comms surface
Billing, email, telephony, voice, SMS.
- **Canonical doc:** [`FACTORY_V1.md`](FACTORY_V1.md) §3.1, per-app `capabilities.yml`
- **Tools:** Stripe, Loops, Resend, Telnyx, Deepgram, ElevenLabs
- **State:** Stripe account `apn_EOhleMX`, per-vendor dashboards
- **Entry point:** [`docs/runbooks/secret-rotation.md`](../runbooks/secret-rotation.md) for each vendor

### 11. Observability surface
Errors, performance, product analytics, gate states.
- **Canonical doc:** [`ADMIN_TECHNICAL_GUIDE.md`](ADMIN_TECHNICAL_GUIDE.md) §2.2 (factory_gates), [`FACTORY_V1.md`](FACTORY_V1.md) §4.4, [`docs/runbooks/slo.md`](../runbooks/slo.md)
- **Tools:** Sentry (`latwood-tech` org), PostHog, BetterStack, Pushover, QA Tools, `factory_gates`, `factory_events`
- **State:** Sentry projects per worker, PostHog projects per app, `factory_audit_log`
- **Entry point:** `https://qa.latimerwoods.dev` for QA run review, [Sentry org](https://latwood-tech.sentry.io) for error triage.
- **Auth:** QA Tools uses the same Latwood Tech Google Workspace allowlist and break-glass credential policy as AP Unlimited/Admin Studio.

### 12. AI / model surface
LLM providers, routing, metering.
- **Canonical doc:** [`docs/STACK.md`](../STACK.md), [`ADMIN_TECHNICAL_GUIDE.md`](ADMIN_TECHNICAL_GUIDE.md) §3.2 (llm-meter)
- **Tools:** Anthropic (primary), Vertex AI Gemini (long-context fallback), Groq, Hugging Face
- **State:** AI Gateway routing, `llm_ledger` D1 table (Tier 1), `LLM_COST_KV` per-Worker
- **Entry point:** `@latimer-woods-tech/llm` package

### 13. Docs / knowledge surface
Mintlify, runbooks, ADRs, architecture docs.
- **Canonical doc:** [`docs/STATE.md`](../STATE.md) (auto-generated, "what's true right now"), [`FACTORY_V1.md`](FACTORY_V1.md) §17.c (related docs map)
- **Code:** `docs/`, `documents/factory/`, Mintlify content
- **State:** Mintlify deployments, GitHub Wiki (if any), per-app READMEs
- **Entry point:** [`docs/STATE.md`](../STATE.md)

### 14. Governance / security surface
CODEOWNERS, branch rulesets, capabilities, audit, JWT rotation, tier policy.
- **Canonical doc:** [`docs/supervisor/FRIDGE.md`](../supervisor/FRIDGE.md), [`ADMIN_TECHNICAL_GUIDE.md`](ADMIN_TECHNICAL_GUIDE.md) §1.4 (operating invariants) + §1.8 (admin surface standards)
- **Code:** `CODEOWNERS`, per-app `capabilities.yml`, `.github/workflows/credential-scrub.yml`
- **State:** Branch protection rules, GHAS findings, `factory_audit_log`
- **Entry point:** [`docs/supervisor/FRIDGE.md`](../supervisor/FRIDGE.md) (read first)

### 15. Targeting / portfolio surface
Which app gets attention this week and why. The executive layer.
- **Canonical doc:** [`ADMIN_TECHNICAL_GUIDE.md`](ADMIN_TECHNICAL_GUIDE.md) §1.9, `docs/PORTFOLIO_FOCUS.md` (Tier 0 ship)
- **State:** Mutable weekly; not in code
- **Entry point:** `docs/PORTFOLIO_FOCUS.md` (read at every session start)

---

## How to use this index

**For a new Claude Code session:**
1. Read [`docs/STATE.md`](../STATE.md) — current platform state
2. Read [`docs/PORTFOLIO_FOCUS.md`](../PORTFOLIO_FOCUS.md) (once it exists) — what matters this week
3. Read this file (`SURFACES.md`) — where to find the surface you're touching
4. Read the canonical doc for that surface

**For a human picking up work:**
1. Identify which surface(s) your task touches
2. Follow the canonical-doc link
3. Confirm acceptance criteria + invariants apply
4. Use [`docs/ACCESS.md`](../ACCESS.md) for the live URL, auth policy, and first action.

**For a contractor or new collaborator:**
1. Start with [`CLAUDE.md`](../../CLAUDE.md) + [`docs/supervisor/FRIDGE.md`](../supervisor/FRIDGE.md)
2. Then [`FACTORY_V1.md`](FACTORY_V1.md) §1-§4
3. Then this index for surface-specific deep dives

---

## Maintenance

This file is updated when:
- A new surface is added to the platform (rare — 15 should be stable)
- A canonical doc moves or is renamed
- A surface's entry point changes

New surface additions require an ADR — the platform has 15 well-named surfaces and adding a 16th is a real architectural call, not a documentation choice.
