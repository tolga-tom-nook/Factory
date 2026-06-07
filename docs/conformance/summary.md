# Platform Conformance — Shadow Mode

*Generated: 2026-06-06 (UTC). Stage 1 shadow — scores are advisory, not enforced.*

## Cohesion summary

| Repo | Cohesion | Stack (10) | Code patterns (15) | Tests (15) | Observability (10) | Security (15) | Schema (5) | Workflows (10) | Release (5) | Performance (10) | Privacy (5) |
|------|---------:|-----:|-----:|-----:|-----:|-----:|-----:|-----:|-----:|-----:|-----:|
| HumanDesign | **53** | 40 | 0 | 100 | 40 | 80 | 67 | 33 | 67 | 67 | 25 |
| capricast | **42** | 40 | 20 | 40 | 40 | 60 | 33 | 33 | 33 | 67 | 50 |
| factory-admin-studio | **73** | 60 | 80 | 100 | 40 | 60 | 100 | 33 | 67 | 100 | 100 |
| cypher-healing | **47** | 60 | 80 | 60 | 40 | 40 | 67 | 33 | 33 | 0 | 25 |
| xico-city | **51** | 80 | 80 | 60 | 0 | 20 | 100 | 33 | 33 | 67 | 50 |

**Shadow threshold:** 70. Below this would block deploys once Stage 4 ships.

## HumanDesign — 53/100

### Stack — 40/100 (weight 10)
- ❌ wrangler.jsonc present
- ✅ ESM ('type': 'module')
- ❌ Hono in deps
- ❌ No node:crypto imports
- ✅ No Express

### Code patterns — 0/100 (weight 15)
- ❌ @latimer-woods-tech/logger in deps
- ❌ @latimer-woods-tech/errors in deps
- ❌ @latimer-woods-tech/monitoring in deps
- ❌ No console.log in src/
- ❌ Typed Env bindings

### Tests — 100/100 (weight 15)
- ✅ vitest.config present
- ✅ playwright.config present
- ✅ tests/ or test/ dir present
- ✅ Smoke tier present
- ✅ Coverage thresholds set

### Observability — 40/100 (weight 10)
- ❌ Sentry import
- ❌ @lwt/monitoring consumed
- ✅ Sourcemap upload step
- ✅ SLO doc present
- ❌ Structured log fields

### Security — 80/100 (weight 15)
- ✅ CodeQL workflow present
- ✅ npm audit step in CI
- ✅ No NPM_TOKEN in workflows
- ❌ Trusted Publishers (OIDC)
- ✅ Renovate config present

### Schema — 67/100 (weight 5)
- ✅ Migrations directory present
- ✅ ROLLBACK block enforced — WARN: 9 existing migration(s) missing -- ROLLBACK: block (debt — not blocking): migrations/20260401_create_tier_schema.sql, migrations/20260401_insert_tier_data.sql, migrations/20260603_rls_app_role.sql, migrations/20260603_rls_defn_lookups.sql, migrations/20260603_rls_policies.sql, migrations/20260603_rls_policies_crossuser.sql, migrations/20260603_rls_policies_writes.sql, migrations/20260604_add_comped_tier.sql, migrations/20260604_notifications_inbox.sql
- ❌ Numbered file naming

### Workflows — 33/100 (weight 10)
- ❌ ≤5 workflow files
- ❌ Uses _app-ci reusable
- ✅ CODEOWNERS present

### Release — 67/100 (weight 5)
- ✅ CHANGELOG.md present
- ✅ Semver version (n.n.n)
- ❌ ADR directory present

### Performance — 67/100 (weight 10)
- ✅ p95 budgets declared
- ❌ Canary or post-deploy verify
- ✅ Synthetic / smoke workflow

### Privacy — 25/100 (weight 5)
- ❌ PII_INVENTORY.md present
- ❌ Retention policy doc present
- ❌ DSR endpoint hints (export + delete)
- ✅ Migration PII columns documented

## capricast — 42/100

### Stack — 40/100 (weight 10)
- ❌ wrangler.jsonc present
- ✅ ESM ('type': 'module')
- ❌ Hono in deps
- ❌ No node:crypto imports
- ✅ No Express

### Code patterns — 20/100 (weight 15)
- ❌ @latimer-woods-tech/logger in deps
- ❌ @latimer-woods-tech/errors in deps
- ❌ @latimer-woods-tech/monitoring in deps
- ✅ No console.log in src/
- ❌ Typed Env bindings

### Tests — 40/100 (weight 15)
- ❌ vitest.config present
- ✅ playwright.config present
- ✅ tests/ or test/ dir present
- ❌ Smoke tier present
- ❌ Coverage thresholds set

### Observability — 40/100 (weight 10)
- ❌ Sentry import
- ❌ @lwt/monitoring consumed
- ✅ Sourcemap upload step
- ✅ SLO doc present
- ❌ Structured log fields

### Security — 60/100 (weight 15)
- ✅ CodeQL workflow present
- ❌ npm audit step in CI
- ✅ No NPM_TOKEN in workflows
- ❌ Trusted Publishers (OIDC)
- ✅ Renovate config present

### Schema — 33/100 (weight 5)
- ❌ Migrations directory present
- ✅ ROLLBACK block enforced
- ❌ Numbered file naming

### Workflows — 33/100 (weight 10)
- ❌ ≤5 workflow files
- ❌ Uses _app-ci reusable
- ✅ CODEOWNERS present

### Release — 33/100 (weight 5)
- ✅ CHANGELOG.md present
- ❌ Semver version (n.n.n)
- ❌ ADR directory present

### Performance — 67/100 (weight 10)
- ✅ p95 budgets declared
- ✅ Canary or post-deploy verify
- ❌ Synthetic / smoke workflow

### Privacy — 50/100 (weight 5)
- ✅ PII_INVENTORY.md present
- ❌ Retention policy doc present
- ❌ DSR endpoint hints (export + delete)
- ✅ Migration PII columns documented

## factory-admin-studio — 73/100

### Stack — 60/100 (weight 10)
- ❌ wrangler.jsonc present
- ✅ ESM ('type': 'module')
- ✅ Hono in deps
- ❌ No node:crypto imports
- ✅ No Express

### Code patterns — 80/100 (weight 15)
- ✅ @latimer-woods-tech/logger in deps
- ✅ @latimer-woods-tech/errors in deps
- ✅ @latimer-woods-tech/monitoring in deps
- ✅ No console.log in src/
- ❌ Typed Env bindings

### Tests — 100/100 (weight 15)
- ✅ vitest.config present
- ✅ playwright.config present
- ✅ tests/ or test/ dir present
- ✅ Smoke tier present
- ✅ Coverage thresholds set

### Observability — 40/100 (weight 10)
- ❌ Sentry import
- ❌ @lwt/monitoring consumed
- ✅ Sourcemap upload step
- ✅ SLO doc present
- ❌ Structured log fields

### Security — 60/100 (weight 15)
- ✅ CodeQL workflow present
- ❌ npm audit step in CI
- ❌ No NPM_TOKEN in workflows
- ✅ Trusted Publishers (OIDC)
- ✅ Renovate config present

### Schema — 100/100 (weight 5)
- ✅ Migrations directory present
- ✅ ROLLBACK block enforced — WARN: 1 existing migration(s) missing -- ROLLBACK: block (debt — not blocking): migrations/0100_studio_entitlements.sql
- ✅ Numbered file naming

### Workflows — 33/100 (weight 10)
- ❌ ≤5 workflow files
- ❌ Uses _app-ci reusable
- ✅ CODEOWNERS present

### Release — 67/100 (weight 5)
- ❌ CHANGELOG.md present
- ✅ Semver version (n.n.n)
- ✅ ADR directory present

### Performance — 100/100 (weight 10)
- ✅ p95 budgets declared
- ✅ Canary or post-deploy verify
- ✅ Synthetic / smoke workflow

### Privacy — 100/100 (weight 5)
- ✅ PII_INVENTORY.md present
- ✅ Retention policy doc present
- ✅ DSR endpoint hints (export + delete)
- ✅ Migration PII columns documented

## cypher-healing — 47/100

### Stack — 60/100 (weight 10)
- ✅ wrangler.jsonc present
- ❌ ESM ('type': 'module')
- ✅ Hono in deps
- ❌ No node:crypto imports
- ✅ No Express

### Code patterns — 80/100 (weight 15)
- ✅ @latimer-woods-tech/logger in deps
- ✅ @latimer-woods-tech/errors in deps
- ✅ @latimer-woods-tech/monitoring in deps
- ❌ No console.log in src/
- ✅ Typed Env bindings

### Tests — 60/100 (weight 15)
- ✅ vitest.config present
- ❌ playwright.config present
- ✅ tests/ or test/ dir present
- ❌ Smoke tier present
- ✅ Coverage thresholds set

### Observability — 40/100 (weight 10)
- ✅ Sentry import
- ✅ @lwt/monitoring consumed
- ❌ Sourcemap upload step
- ❌ SLO doc present
- ❌ Structured log fields

### Security — 40/100 (weight 15)
- ❌ CodeQL workflow present
- ❌ npm audit step in CI
- ✅ No NPM_TOKEN in workflows
- ❌ Trusted Publishers (OIDC)
- ✅ Renovate config present

### Schema — 67/100 (weight 5)
- ✅ Migrations directory present
- ✅ ROLLBACK block enforced — WARN: 1 existing migration(s) missing -- ROLLBACK: block (debt — not blocking): src/db/migrations/add-product-images.sql
- ❌ Numbered file naming

### Workflows — 33/100 (weight 10)
- ✅ ≤5 workflow files
- ❌ Uses _app-ci reusable
- ❌ CODEOWNERS present

### Release — 33/100 (weight 5)
- ❌ CHANGELOG.md present
- ✅ Semver version (n.n.n)
- ❌ ADR directory present

### Performance — 0/100 (weight 10)
- ❌ p95 budgets declared
- ❌ Canary or post-deploy verify
- ❌ Synthetic / smoke workflow

### Privacy — 25/100 (weight 5)
- ❌ PII_INVENTORY.md present
- ❌ Retention policy doc present
- ❌ DSR endpoint hints (export + delete)
- ✅ Migration PII columns documented

## xico-city — 51/100

### Stack — 80/100 (weight 10)
- ✅ wrangler.jsonc present
- ✅ ESM ('type': 'module')
- ✅ Hono in deps
- ❌ No node:crypto imports
- ✅ No Express

### Code patterns — 80/100 (weight 15)
- ✅ @latimer-woods-tech/logger in deps
- ✅ @latimer-woods-tech/errors in deps
- ✅ @latimer-woods-tech/monitoring in deps
- ✅ No console.log in src/
- ❌ Typed Env bindings

### Tests — 60/100 (weight 15)
- ✅ vitest.config present
- ❌ playwright.config present
- ✅ tests/ or test/ dir present
- ❌ Smoke tier present
- ✅ Coverage thresholds set

### Observability — 0/100 (weight 10)
- ❌ Sentry import
- ❌ @lwt/monitoring consumed
- ❌ Sourcemap upload step
- ❌ SLO doc present
- ❌ Structured log fields

### Security — 20/100 (weight 15)
- ❌ CodeQL workflow present
- ❌ npm audit step in CI
- ✅ No NPM_TOKEN in workflows
- ❌ Trusted Publishers (OIDC)
- ❌ Renovate config present

### Schema — 100/100 (weight 5)
- ✅ Migrations directory present
- ✅ ROLLBACK block enforced — WARN: 16 existing migration(s) missing -- ROLLBACK: block (debt — not blocking): src/db/migrations/0000_smart_titania.down.sql, src/db/migrations/0000_smart_titania.sql, src/db/migrations/0001_rls_policies.down.sql, src/db/migrations/0001_rls_policies.sql, src/db/migrations/0002_burly_luke_cage.down.sql, src/db/migrations/0002_burly_luke_cage.sql, src/db/migrations/0003_betterauth_rls.down.sql, src/db/migrations/0003_betterauth_rls.sql, src/db/migrations/0004_worried_jetstream.down.sql, src/db/migrations/0004_worried_jetstream.sql, src/db/migrations/0005_notifications_rls.down.sql, src/db/migrations/0005_notifications_rls.sql, src/db/migrations/0006_previous_tyger_tiger.down.sql, src/db/migrations/0006_previous_tyger_tiger.sql, src/db/migrations/0007_search_indexes.down.sql, src/db/migrations/0007_search_indexes.sql
- ✅ Numbered file naming

### Workflows — 33/100 (weight 10)
- ❌ ≤5 workflow files
- ❌ Uses _app-ci reusable
- ✅ CODEOWNERS present

### Release — 33/100 (weight 5)
- ❌ CHANGELOG.md present
- ✅ Semver version (n.n.n)
- ❌ ADR directory present

### Performance — 67/100 (weight 10)
- ❌ p95 budgets declared
- ✅ Canary or post-deploy verify
- ✅ Synthetic / smoke workflow

### Privacy — 50/100 (weight 5)
- ❌ PII_INVENTORY.md present
- ✅ Retention policy doc present
- ❌ DSR endpoint hints (export + delete)
- ✅ Migration PII columns documented — WARN: 7 existing migration PII column(s) not documented in PII_INVENTORY.md (debt — not blocking): src/db/migrations/0000_smart_titania.sql: avatar_r2_key, src/db/migrations/0000_smart_titania.sql: email, src/db/migrations/0000_smart_titania.sql: email_verified, src/db/migrations/0000_smart_titania.sql: ip_address, src/db/migrations/0000_smart_titania.sql: stripe_customer_id, src/db/migrations/0000_smart_titania.sql: user_agent, src/db/migrations/0004_worried_jetstream.sql: emailed_at
