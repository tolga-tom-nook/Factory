# Platform Standards — Latimer-Woods-Tech

**Version:** v1 · **Date:** 2026-05-11 · **Status:** Authoritative · **Conflicts:** `docs/supervisor/FRIDGE.md` wins; this doc wins over older scattered architecture notes; ADRs in `docs/adr/` win over this doc when explicitly marked superseding.

This is the single source of truth for how every Latimer-Woods-Tech repo, package, workflow, and feature is built. Every PR is audited against it (`platform-conformance.yml`). Every AI agent reads it as a hard constraint. Every new repo inherits it by default.

If a rule isn't here, it's not a rule. If a rule is here and you need to break it, open an ADR — don't just do it.

---

## 1. Stack

- **Runtime:** Cloudflare Workers. Node-style runtime targets allowed only in build tooling, never in production code.
- **HTTP:** Hono. No Express, no Fastify, no raw `Request`/`Response` glue for new routes.
- **Crypto:** Web Crypto (`crypto.subtle`). Never `node:crypto`.
- **Modules:** ESM only. No CommonJS in new code. Existing CJS code is grandfathered until its next major refactor.
- **Language:** TypeScript strict (`strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`).
- **Package manager:** pnpm + workspaces. No npm or yarn at root.
- **Databases:** D1 for transactional, Neon (Postgres) via Hyperdrive for relational, KV for hot config, R2 for blobs, Durable Objects for stateful real-time.
- **AI:** All LLM calls via `@latimer-woods-tech/llm`. Tiered routing (fast / balanced / smart / verifier). Anthropic primary, Gemini long-context fallback, Groq verifier. No direct vendor SDKs.
- **Realtime:** `@latimer-woods-tech/realtime` (when published) for DO Room/Presence/Conference patterns.

## 2. Code patterns

- **Env typing:** every Worker exports a typed `Env` interface. Bindings, secrets, vars all explicit.
- **Logging:** `@latimer-woods-tech/logger` only. No `console.*` in production code (lint-enforced).
- **Errors:** `@latimer-woods-tech/errors` for all structured errors. `FactoryBaseError` hierarchy. Never throw raw `Error`.
- **Retry:** `withRetry` from `@latimer-woods-tech/errors` for any network call to an external service. Jittered exponential backoff. Idempotency key required for retryable mutations.
- **Webhooks:** `withIdempotency(eventId, handler)` from `@latimer-woods-tech/webhooks` (when published; today, from `@lwt/stripe` and `@lwt/auth`). Record event ID before processing. Safe on retry.
- **Auth:** `@latimer-woods-tech/auth` for JWT, OAuth flows, session middleware. No hand-rolled JWT verification.
- **Billing:** `@latimer-woods-tech/stripe` for Stripe interactions. Price IDs from env. Never hardcode price IDs in code.
- **Monitoring:** `@latimer-woods-tech/monitoring` wires Sentry + PostHog. Every Worker includes this in its middleware chain.
- **Multi-tenant:** every Worker that holds tenant data resolves tenant via `X-Tenant-Id` header + `resolveTenant()` from `@lwt/auth`. No implicit tenant fallback.
- **Request ID:** every request gets a `request_id` (UUIDv7) attached by middleware. Logged on every line. Propagated downstream.

## 3. Tests

- **Unit:** Vitest with `--maxWorkers=1` for deterministic mode. Coverage floor 80% line / 85% branch / 70% function, ratcheting to 90/90/85 once stable.
- **Integration:** Playwright for every Worker that exposes HTTP. Tiers: `smoke`, `gate`, `a11y`, `visual`. At least `smoke` mandatory.
- **Accessibility:** axe-core integrated into Playwright `a11y` tier. WCAG 2.2 AA target. Zero violations on critical paths.
- **Coverage in CI:** every PR reports coverage delta. Delta < 0 fails the build unless an ADR justifies it.
- **Every route has a test.** New route without a test fails conformance.

## 4. Observability

- **Sentry:** every Worker initializes Sentry via `@lwt/monitoring` in its entry point. DSN from env (`SENTRY_DSN_*`). Sourcemap upload mandatory on every deploy (`sentry-cli sourcemaps upload`).
- **Structured logs:** JSON lines via `@lwt/logger`. Fields: `timestamp`, `level`, `request_id`, `tenant_id?`, `user_id?`, `route`, `latency_ms`, `event`.
- **Metrics:** PostHog for product events (`@lwt/monitoring.track(event, props)`). Sentry for errors. Cloudflare Analytics for infrastructure.
- **Per-route p95 budgets:** declared in `docs/SLO.md` per repo. Enforced by post-deploy canary; auto-rollback if exceeded by 1.5x for 10 minutes.

## 5. Security

- **Audits:** `npm audit --audit-level=high` on every PR. New high-or-critical CVE fails the build.
- **CodeQL:** required workflow on every PR + nightly on main.
- **Secrets:** no long-lived tokens in CI. Use OIDC + Trusted Publishers for npm. Use `factory-cross-repo` GitHub App for cross-repo work. Never commit secrets; secret-scanning + push-protection enabled org-wide.
- **Dependencies:** Renovate at org level. Minor + patch auto-merge for `@lwt/*` internal. Major requires ADR.
- **Vulnerable dep response:** P0 if exploitable in production code path. SLA: 24h to merge fix or document mitigation.

## 6. Schema

- **Migrations:** SQL files under `migrations/`. Naming: `NNNN_description.sql`. Numbered, sequential, immutable once merged.
- **Pattern:** Expand → Contract. Additive-only changes deployable to prod. Destructive changes (drop column, rename) require a two-phase migration with both versions running simultaneously for ≥1 deploy cycle.
- **Rollback:** every migration includes `-- ROLLBACK:` block with the inverse statement, or `-- ROLLBACK: NONE — irreversible, see ADR-NNNN` referring to an approved ADR.
- **Dry-run:** `wrangler d1 execute --dry-run` required in CI before deploy.

## 7. Workflows

- **Reusables in factory:** `_app-ci.yml`, `_app-deploy.yml`, `_app-prod-canary.yml`, `_app-reliability-gate.yml`. Caller workflows in product repos invoke these.
- **Workflow count per repo:** ≤5 workflow files. Anything more requires consolidation or ADR.
- **Required org workflows:** `completion-tracker-notify.yml`, `platform-conformance.yml` (after Stage 4), `definition-of-done.yml` (after Stage 4).
- **Branch protection:** identical across repos. 1 CODEOWNER approval. Dismiss stale reviews. Linear history. No force-push.
- **Allowed actions:** `local_only` for product repos. `all` only for Factory.
- **Bypass list:** `@adrper79-dot` + `factory-cross-repo[bot]` for the existing approved-PR auto-merge flow.

## 8. Release

- **Versioning:** semver. Major requires ADR.
- **CHANGELOG.md:** every package keeps one. Updated in the same PR as the change.
- **Tags:** signed tags via `actions/create-github-app-token`. No personal access tokens for release.
- **Published packages:** `@latimer-woods-tech/*` on npmjs.org, public, with provenance via Trusted Publishers (per PR #584).
- **ADR for architectural decisions:** required when PR touches `migrations/**`, `packages/**` (new package or major version), `wrangler.jsonc` bindings, auth/billing flows, or public API contracts.

## 9. Performance

- **Latency budgets** (p95) per route:
  - Read paths: 200ms warm, 500ms cold
  - Write paths: 800ms warm, 1500ms cold
  - Webhook handlers: 3s p95 (Stripe retries after 5s)
  - LLM-backed routes: documented per route, default 10s p95
- **SLO target:** 99.9% availability per Worker (43m/month downtime budget).
- **Synthetic checks:** 1/minute from 3 geos via Cloudflare Synthetic Monitoring. Alerts via `@lwt/monitoring`.
- **Cold-start optimization:** Workers init under 50ms. Heavy work lazy-loaded.

## 10. Privacy

- **PII inventory:** every Worker that stores PII maintains `docs/PII_INVENTORY.md` listing fields, location (table/column or KV/R2), retention period.
- **DSR endpoints:** required on every Worker that stores per-user PII. Verified by conformance.
  - Primary: `GET /privacy/export` and `POST /privacy/delete`
  - Legacy accepted during migration: `GET /api/me/export` and `DELETE /api/me`
  - Rationale: new stubs use `POST /privacy/delete` for auth-gated handler parity
- **Audit log:** `@lwt/compliance.auditLog(action, actor, target, metadata)` on every mutating admin route. Retention 1 year minimum.
- **Data retention policy:** per Worker, in `docs/RETENTION.md`. Default: 7 years for billing records, 30 days for soft-deleted user data, 90 days for logs.
- **Encryption:** at rest (Cloudflare default), in transit (TLS 1.3 only). No plain-text PII in logs.

---

## How this evolves

- This file is versioned. Changes via PR + ADR.
- Standards that nobody meets within 90 days get re-evaluated: either drop them, or invest to fix.
- New production incidents become candidate new standards. Recurring incidents (≥3 in a quarter) become required new standards.
- Quarterly review (per OPERATING_FRAMEWORK §quarterly): drop, add, evolve.

## Active ADRs that override or refine this doc

(Populated as ADRs land. Format: `ADR-NNNN: short title (status)`.)

- `ADR-0001: Cohesion architecture` — three lines of defense, lives in factory.
- `ADR-0002: Operating framework` — milestone-based execution model.

---

## Conformance audit dimensions

The conformance workflow (M1) scores each repo against these dimensions. Sample checks below; full check list in `scripts/platform_conformance.py`.

| § | Dimension | Weight | Sample checks |
|---:|---|---:|---|
| 1 | Stack | 10 | wrangler.jsonc valid, ESM only, no node:crypto, Hono present |
| 2 | Code patterns | 15 | @lwt/logger consumed, @lwt/errors consumed, idempotent webhooks, request_id middleware |
| 3 | Tests | 15 | vitest deterministic, playwright tiers present, coverage ≥ floor, every route tested |
| 4 | Observability | 10 | Sentry init, sourcemap upload step, structured logs, SLO doc present |
| 5 | Security | 15 | CodeQL workflow, npm audit step, OIDC publish (no long-lived NPM_TOKEN), secret-scanning on |
| 6 | Schema | 5 | Expand/contract pattern, rollback documented, dry-run in CI |
| 7 | Workflows | 10 | Uses `_app-*` reusables, ≤5 caller files, branch protection identical to canonical |
| 8 | Release | 5 | semver tags, CHANGELOG present, ADRs link from PRs that need them |
| 9 | Performance | 10 | SLO budgets declared, synthetic checks live, smoke + canary green |
| 10 | Privacy | 5 | PII_INVENTORY present, DSR endpoints present where required, audit log middleware on admin routes |
| 11 | Feature Registry | 5 | `feature-registry.yml` present, schema valid, roadmap entries have status + quarter, cohesion field populated |

Each repo's score = weighted average across dimensions. Anything < 70 blocks deploys (after Stage 4 enforcement; advisory before).


---

## 11. Feature Registry

Every app and package — whether in the Factory monorepo or a standalone repo — must maintain a `feature-registry.yml` file at its root (`apps/{name}/feature-registry.yml` for monorepo apps; repo root for standalone repos).

**Purpose:** Powers the public `/platform/` dashboard on latwoodtech.com, feeds the `platform.json` CI artifact, and enforces that product state is machine-readable rather than tribal knowledge.

**Required fields:**

```yaml
app: my-app          # matches id in docs/service-registry.yml
name: My App         # human display name
domain: myapp.com    # canonical domain or worker URL
stage: production    # foundation | beta | production | revenue | on-hold | design
cohesion: 62         # current conformance score (0-100)
description: One sentence describing what this app does.

roadmap:
  - id: my-feature-launch
    label: Feature launch
    status: active   # done | active | queued | on-hold | design
    quarter: Q3-2026

features:
  - id: auth
    label: Authentication
    status: live     # live | in-progress | roadmap | deprecated
    tier: core       # core | growth | compliance | infra

packages:            # @latimer-woods-tech/* deps consumed
  - auth
  - neon
```

**When to update:** After any shipped milestone (update `status: done`), when roadmap priorities shift, and as part of the Stage 4+ conformance cycle. The `/platform/` dashboard reflects the next hourly CI run.

**Machine checks (conformance dimension 11):**
- File exists at expected path
- `app`, `name`, `stage`, `cohesion` fields present and non-empty
- At least one `roadmap` entry
- All roadmap entries have `status` and `quarter` fields
- `cohesion` is a number between 0 and 100

Schema canonical definition: [`docs/standards/feature-registry.schema.yml`](./standards/feature-registry.schema.yml)

---

## 12. PR size budget

Every PR has a hard size budget by tier. Bigger work decomposes before opening. Atomic PRs review in seconds; sprawling PRs hide bugs and slow merge throughput.

| Tier | Path scope (per CODEOWNERS) | Max diff lines (added + removed) |
|---|---|---:|
| **Green** | `docs/**`, `*.md`, `session/**`, generated docs | ≤ 50 |
| **Yellow** | `apps/*/src/**`, `client/**`, `tests/**`, non-critical worker routes | ≤ 200 |
| **Red** | `.github/workflows/**`, `packages/**`, `migrations/**`, billing, wrangler bindings, auth flows | ≤ 500 |

Exceptions require the `size-exception-approved` label, which CODEOWNERS-approval can apply, with a comment explaining why the decomposition isn't worth it.

Decomposition strategies the supervisor and sub-agents use:
- Split by file (each file → its own atomic PR if independent)
- Split by concern (test scaffolding PR → implementation PR → docs PR)
- Stack PRs (open #2 against #1's branch, merge in order)
- Use `[stack: N of M]` in PR title to declare the sequence

The `pr-size-guard.yml` workflow (Stage 4) enforces this as a required status check. Until then, treat it as advisory + reviewer discretion.

See ADR-0005 for the full decision context.

---

## 13. UI/UX (customer-facing surfaces)

Every customer-facing UI satisfies the following machine-checkable rules. Enforced by Stage 6 conformance dimension (Lighthouse + axe + bundle analyzer + visual regression).

### 13.1 Foundation
- Imports tokens from `@latimer-woods-tech/ui-tokens` (no hard-coded hex colors, spacing, font sizes)
- Imports components from `@latimer-woods-tech/design-system` (no per-app Buttons, Inputs, Modals reinvented)
- Imports icons from `@latimer-woods-tech/icons` (no per-app icon libraries beyond Lucide-managed)
- Imports form patterns from `@latimer-woods-tech/forms` (no per-app form validators)
- Imports a11y primitives from `@latimer-woods-tech/a11y` (no per-app focus management)

### 13.2 Accessibility (WCAG 2.2 AA, enforced)
- **axe-core: zero violations on critical paths** (login, signup, checkout, primary feature)
- Keyboard navigation: every interactive element reachable + operable
- Screen reader: every interactive element has accessible name + role
- Color contrast: ≥4.5:1 for body text, ≥3:1 for large text + UI components
- Focus visible: every focused element shows a 2px+ outline
- Forms: labels associated with inputs, errors announced to screen readers

### 13.3 Performance budgets (Lighthouse, enforced post-deploy)
- Marketing pages: Performance ≥95, Accessibility ≥95, Best Practices ≥95, SEO ≥95
- App pages (authenticated): Performance ≥85, Accessibility ≥95, Best Practices ≥90
- Largest Contentful Paint: <1s on desktop, <2.5s on mid-tier mobile
- Interaction to Next Paint: <200ms p95
- Cumulative Layout Shift: <0.1
- Total Blocking Time: <200ms
- JS bundle (initial): <150KB gzipped per route
- Image strategy: WebP/AVIF; LQIP for above-the-fold; lazy load below-the-fold

### 13.4 Mobile-first
- Design at 320px breakpoint first
- All tap targets ≥44×44px
- No horizontal scroll on any breakpoint
- Forms one-column on mobile; never 2-column inputs side-by-side
- Bottom-of-screen actions only when context requires (avoid sticky)

### 13.5 Loading + error UX
- Loading state: skeleton screens (matched to final layout). **Spinners forbidden.**
- Error state: inline, specific, actionable. Generic "something went wrong" forbidden.
- Empty state: tells the user the next action. Never blank.
- Success state: visible confirmation, never silent.

### 13.6 Forms
- One-column on mobile, one-column on desktop unless intentional (two fields max side-by-side)
- Autofocus the first input
- Save progress (localStorage or URL params) on multi-step
- Validate on blur, not on every keystroke
- Errors inline + specific + actionable ("Email must include @" not "Invalid")
- No captchas; use rate limiting + Cloudflare bot management

### 13.7 Component standards
- One primary action per screen (one filled Button; others are Outline or Text)
- Modals dismiss on Escape + backdrop click + explicit Cancel
- Toasts auto-dismiss in 5s for info, 10s for errors, require explicit dismiss for critical
- Nav: real navigation on desktop ≥768px (no hamburger). Hamburger only <768px.
- Tables: sortable, filterable, paginated by default. Empty state required.

### 13.8 Theming
- Dark mode is the default. Light is the variant.
- Both ship at the same time; visual parity verified by snapshot tests.
- System preference respected on first visit; user override persisted.
- No "auto-switching" mid-session.

### 13.9 Conformance (Stage 6 conformance dimension)
Sample checks:
- 30 pts — `@lwt/design-system` in deps + at least one component import
- 20 pts — Lighthouse Performance ≥85 (app) or ≥95 (marketing)
- 20 pts — axe-core run in CI with zero violations on critical-path test
- 10 pts — Bundle size budget enforced in CI
- 10 pts — Storybook published with ≥5 stories
- 10 pts — Dark + light mode parity test passes

Weight in overall cohesion score: 10.

---

## 14. Design Philosophy — The Two-Question Filter

Every UI design decision passes both filters. Sub-agents reading this section apply both questions before proposing UX patterns.

### Filter 1: "What would Steve Jobs do?"

**Machine-checkable rules** (enforced by Stage 6 conformance + Claude review):
- One primary action per screen
- Type and whitespace carry the brand (no decorative chrome)
- Performance IS design (sub-1s LCP, sub-200ms interaction; spinners forbidden)
- 4px grid for all spacing/sizing
- One weight scale (100/200/300/400/500/600/700/800)
- Animation < 200ms or it's friction, not animation
- Mobile-first (design 320px before any other breakpoint)
- Dark-mode-first (light is the variant; parity verified)

**Subjective rules** (Claude reviewer + human reviewer enforce):
- Delete a feature before adding a feature
- Details matter — 1px alignment, easing curve, placeholder text
- People don't know what they want until you show it; don't design by survey
- "If it needs a tour, the design is wrong"

### Filter 2: "What do people in the market want and not want?" (2026 baseline)

**Want — design for affirmatively:**

| Want | Implementation |
|---|---|
| Fast | LCP <1s; bundle <150KB initial; CDN edge-served |
| Dark mode default | `@lwt/ui-tokens` ships dark as default; light as variant |
| Keyboard shortcuts | `Cmd+K` command palette on every app |
| Real-time updates | DO-based subscriptions; no manual refresh |
| Offline-capable | Where data shape allows (read-only views) |
| Privacy visible | One-click data export + delete in every account UI |
| Native-feeling mobile | No jank, no rubber-banding, no synthetic clicks |
| AI-assisted, not pushy | Assist on focus/intent, never on page load; no auto-chat |
| One-column big forms | `@lwt/forms` enforces this by default |
| Skeleton loading | `Spinner` component is actually a skeleton; spinners need explicit ADR exception |
| Inline + specific errors | `@lwt/forms` formats errors inline; generic errors fail conformance |
| "Do this next" empty states | Required by `@lwt/design-system` EmptyState component |

**Don't want — explicitly forbidden:**

| Don't | Why |
|---|---|
| Cookie banners not legally required | Friction without value |
| Newsletter modals | Universally hated; conversion theater |
| Chatbot ambushes (auto-open) | Hostile UX; let users initiate |
| Blocking onboarding tours | Users explore; contextual hints win |
| Sticky bottom CTAs on customer pages | Visually loud; conversion noise |
| Forced sign-up walls for content discovery | Conversion-killer; SEO loss |
| Auto-playing video with sound | Universally banned by accessibility + every browser |
| Hamburger menus on desktop ≥768px | Hides nav; lower discoverability |
| Carousels | Proven low CTR; use multi-row instead |
| Animation without a job | Distraction; every animation must convey state or hierarchy change |
| 10-step forms | Decompose into context-driven flows |
| Loading spinners | Skeleton screens or optimistic UI only |
| "Are you sure?" for non-destructive actions | Wastes attention budget |
| Forced password reset for marketing reasons | Trust killer; only for security incidents |

Enforced via: Stage 6 conformance dimension (machine checks), Claude reviewer (pattern detection), human reviewer on Red tier.
