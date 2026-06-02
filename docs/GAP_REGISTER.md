# Platform Gap Register

**Loaded by:** supervisor, Claude reviewer, sub-agents, daily digest · **Updated:** weekly review on Mondays + ad-hoc when gaps close

This is the living, machine-readable register of known platform gaps. Each entry has: ID, severity, status, owner, target stage, fix mechanism, and source. Agents read this to know what's open and what to prioritize.

Source synthesis: `documents/factory/2026-05-11_HOLISTIC_GAP_REVIEW.md` (Sauna-side working note).

## Conventions

- **Severity:** P0 (blocks Stage 1 ship) · P1 (Stage 1-2 must-fix) · P2 (Stage 2-5 fix) · P3 (defer / hygiene)
- **Status:** `open` · `in-progress` · `closed` · `wontfix`
- **Target stage:** `stage-0` … `stage-5` · `continuous` · `out-of-roadmap`
- **Owner:** `@adrper79-dot` · `@factory-cross-repo[bot]` · `@sauna` (the orchestrator)

## P0 — Must close before Stage 1 ships

| ID | Gap | Status | Owner | Target | Fix mechanism |
|---|---|---|---|---|---|
| G1 | Supervisor CONTEXT didn't load PLATFORM_STANDARDS + ADRs | **closed** | @adrper79-dot | stage-0 | PR #624 (merged) updated `docs/supervisor/CONTEXT.md` |
| G2 | Aggregator + sync scripts have no unit tests | **closed** | @sauna + @factory-cross-repo[bot] | stage-1 | Phase 2 shipped — 129 tests, 69.4% combined coverage. Phase 1 shipped via PR [#708](https://github.com/Latimer-Woods-Tech/Factory/pull/708) — 75 tests, 41% combined coverage on the 3 scripts (60% on init-matrix-issues, 38% on aggregate_completion, 36% on sync_labels_to_matrix). |
| G3 | Aggregator has no heartbeat (silent cron failure goes unnoticed) | **closed** | @sauna | stage-1 | `.github/workflows/dead-mans-switch.yml` shipped via PR [#684](https://github.com/Latimer-Woods-Tech/Factory/pull/684) + schedule + cold-start tolerance via [#687](https://github.com/Latimer-Woods-Tech/Factory/pull/687). Fires 11:11 UTC daily; alerts Pushover if `docs/completion-tracker.json` is >26h stale. Cold-start tolerance prevents false-positive on first-ever run. |
| G4 | "Clean run" was undefined for trust ladder | **closed** | @adrper79-dot | stage-0 | PR #624 (merged) added `docs/supervisor/TRUST_LADDER.md` with 6-criteria definition |
| G5 | Claude reviewer not calibrated | **closed** (tuning complete) | @sauna | stage-1 | Shadow run on last 50 PRs across org; FN < 5%, FP < 10%; per ADR-0003. CLAUDE.md Hard Constraints scope clarification added: constraints apply to Workers production code only; `.github/scripts/**/*.mjs` (Node.js) are exempt. |
| G6 | Bootstrap workflow on PR #622 hasn't run yet | open (sequence dep) | @adrper79-dot | stage-0 | After PR #622 merges, dispatch `bootstrap-completion-tracker-private` from Factory Actions |
| G7 | Memory hygiene — session decisions not all in `memory/` | **closed** | @sauna | stage-0 | `RECENT_ACTIVITY.md` updated 2026-05-11 with 8 durable decisions |

## P1 — Stage 1-2 must-fix

| ID | Gap | Status | Owner | Target | Fix mechanism |
|---|---|---|---|---|---|
| G8 | LLM cost hard cap at org level (per-run + daily + monthly) | **closed** | @sauna | stage-2 | Enforcement shipped in `@latimer-woods-tech/llm` `complete()`: `dailyCapUsd` + `monthlyCapUsd` options backed by `LLM_COST_KV` (KV binding). Pre-call reads KV counters and returns `RateLimitError('LLM_DAILY_CAP_EXCEEDED' \| 'LLM_MONTHLY_CAP_EXCEEDED')` if at/over cap. Post-call atomically updates daily (TTL 48h) and monthly (TTL 40d) accumulators. commit `f6313b73`. |
| G9 | Diff size budget has no machine enforcement | **closed** | @factory-cross-repo[bot] | stage-4 | `.github/workflows/pr-size-guard.yml` shipped 2026-05-22 (commits 241bc233, 5e5d736c, e86b76b8): hard-blocking check enforces ADR-0005 tier budgets (Green ≤50, Yellow ≤200, Red ≤500 lines). `.github/pr-size-exclusions.txt` excludes generated/auto-generated files. Per-file breakdown in PR comments. Test PR #899 created to verify blocking behavior. |
| G10 | Sentry overlay endpoint mapping is heuristic (substring match) | **closed** | @sauna | stage-1 (M1) | Schema extended 11→12 columns (sentry_project field added to FUNCTIONS_MATRIX.md in HumanDesign, capricast, Factory, coh via `scripts/update_matrix_schema.py`). Row dataclass + parse_matrix updated to handle 12 columns. aggregate_completion.apply_sentry_overlay() now groups rows by sentry_project, queries per-project instead of substring matching. All 54 tests pass. PR landing 2026-05-22. |
| G11 | ADR coverage check path-based, misses novel architectural patterns | **closed** | @sauna | stage-4 | Shipped in PR #1058 (commit `146e950b`). `.github/scripts/adr-need-check.mjs` + `.github/workflows/adr-need-check.yml`: path heuristic fast path → `claude-haiku-4-5` fallback (one ~50-token call) only when inconclusive → advisory PR comment; fails open on any error, never blocks. 24 node tests in `adr-need-check.test.mjs` pass (verified 2026-06-01). |
| G12 | PII conformance is presence-only, doesn't validate against actual schema | **closed** | @sauna | stage-5 | Shipped in PR #1058 (commit `146e950b`). `check_pii_schema_drift()` in `scripts/platform_conformance.py` extracts columns from migration SQL, matches against curated `PII_COLUMN_PATTERNS`, diffs vs backtick-quoted fields in `PII_INVENTORY.md`. New-migration undocumented PII → error (fails `dim_privacy`); existing → warning. Covered by `test_platform_conformance.py` (26 tests pass, verified 2026-06-01). |
| G13 | Schema migration discipline not machine-checked | **closed** | @sauna | stage-4 | Shipped in PR #1058 (commit `146e950b`). `check_rollback_blocks()` / `dim_schema()` in `scripts/platform_conformance.py` scans `migrations/*.sql` for a `-- ROLLBACK:` marker (case-insensitive; `NONE -- ADR-XXX` accepted). New migration missing the block → error; existing → warning (debt). 9 rollback tests in the 26-test suite pass (verified 2026-06-01). |

## P2 — Stage 2-5 fix

| ID | Gap | Status | Owner | Target | Fix mechanism |
|---|---|---|---|---|---|
| G14 | No retro mechanism for missed milestones | open | @adrper79-dot | continuous | Mandatory `documents/factory/retros/YYYY-MM-DD_milestone-NN_retro.md` after any milestone that misses exit criteria |
| G15 | Monday review is a placeholder (no agenda template) | **closed** | @adrper79-dot | stage-0 follow-up | `docs/MONDAY_REVIEW_TEMPLATE.md` created: 5 sections (digest review, milestone exit check, drift triage, customer signal review, next-week kickoff), 30-min agenda. Branch `claude/dazzling-brahmagupta-RcOz7`. |
| G16 | No customer feedback loop in the system | open | @sauna | stage-2 | Email forwarding into triage workflow; cancellation reasons from Stripe; NPS micro-survey; aggregated into daily digest |
| G17 | No competitive intel watch | open | @sauna | continuous | Quarterly: sub-agent watches competitor changelogs / X feeds / G2 reviews |
| G18 | No domain/IP/legal tracker | **in-progress** | @adrper79-dot | stage-5 | Skeleton shipped 2026-06-01: [`docs/LEGAL_OPS.md`](./LEGAL_OPS.md) — domains (pre-filled from service-registry), trademark/IP, ToS/PP per product, entity/tax, sub-processor list. Structure done; operator must fill the 🔲 facts (renewal dates, registrar, entity). (Placed in `docs/` not `documents/factory/` — that dir isn't in-repo.) |
| G19 | No bus-factor doc for solo operator | **in-progress** | @adrper79-dot | continuous | Skeleton shipped 2026-06-01: [`docs/BUS_FACTOR.md`](./BUS_FACTOR.md) — platform tour, critical-systems map, recovery-runbook index, trusted contact, credential-recovery vault, annual fire drill. Structure + system map done; operator must fill the 🔲 facts (trusted contact, 2FA/recovery-kit locations). |
| G20 | No backup/DR strategy per product | open | @adrper79-dot | stage-5 | `RECOVERY.md` required per product. RTO + RPO declared. Monthly restore drill |

## P3 — Hygiene / defer

| ID | Gap | Status | Owner | Target | Fix mechanism |
|---|---|---|---|---|---|
| G21 | Supply-chain checks beyond CodeQL (Sigstore TLOG for all deps) | open | @factory-cross-repo[bot] | continuous | Expand factory#613 pattern across all packages |
| G22 | No pen-test schedule | open | @adrper79-dot | out-of-roadmap (until $20k MRR) | Annual third-party + quarterly self-test |
| G23 | No bug bounty program | open | @adrper79-dot | out-of-roadmap (until 1k+ users) | HackerOne or independent |
| G24 | No multi-region story for D1 | open | @adrper79-dot | out-of-roadmap (until forced) | CF roadmap, defer |
| G25 | Per-product rate limiting standardized | open | @factory-cross-repo[bot] | stage-5 | Audit + canonicalize via `@lwt/rate-limit` package |
| G26 | Queue / DO backpressure documented per Worker | open | @factory-cross-repo[bot] | stage-5 | Audit each DO; document backpressure pattern |
| G27 | GCP key rotation overdue (`76bc15364b7d…`) | **closed** | @adrper79-dot | this week | Rotated — original key `76bc15364b7d` no longer in `gcloud iam service-accounts keys list factory-sa@factory-495015`; current active keys are `f5ce42a8` (2026-05-09), `0b2e6ad8` (2026-04-30), `2b6fadf6` (2026-05-02), `0dbfec87` (2026-05-12). Verified during 2026-05-17 holistic review. |
| G28 | No calendar event for Monday review | **closed** | @sauna | stage-0 follow-up | Recurring Google Calendar event "Factory Monday Review (G15)" created on primary calendar — Mondays 9:00–9:30 ET (`RRULE:FREQ=WEEKLY;BYDAY=MO`), first occurrence 2026-06-01, popup 10min + email 60min reminders. Description links `docs/MONDAY_REVIEW_TEMPLATE.md`. Event ID `lm10r83jfdnre4e2n17dsvpbv8`. |
| G29 | HubSpot keep-or-delete pending | open (leaning keep) | @adrper79-dot | this week | Operator decision 2026-06-01: **keep** — planned use as the CRM for practitioners who already use HubSpot (selfprime practitioner network). Scope may expand; an ADR should follow once the practitioner-CRM integration is defined. |
| G30 | Pipedream Gmail (adrper79@gmail.com) reconnect or retire | **closed** (retire) | @adrper79-dot | this week | Operator decision 2026-06-01: **retire** — Pipedream Gmail connection is not needed. No reconnect; remove the connection. |

| G31 | JWT rotation procedure (auth pkg) — no dual-key window for secret rotation | **closed** | @adrper79-dot + @factory-cross-repo[bot] | stage-4 | `verifyToken(token, secret, secretNext?)` tries primary first, falls back to `secretNext` on signature failure only (not expiry). `issueToken` signs with `secretNext` when provided. `jwtMiddleware(secret, { secretNext? })` threads through. `refreshToken` re-signs with new key. 9 new dual-key tests; branch coverage 90.24%. Branch `claude/dazzling-brahmagupta-RcOz7`. |
| G32 | Stripe idempotency keys not persisted in DB — retries can double-charge under worker crash | **closed** | @sauna | stage-3 | `stripe_idempotency_keys` table added to Neon schema (migration 0106); `@lwt/stripe.transferOrIdempotent()` helper ships in P2.13h — checks/inserts before Stripe call, updates status on success/failure. Branch `claude/dazzling-brahmagupta-RcOz7`. |
| G33 | No PostgreSQL row-level security templates in `@lwt/neon` | **closed** | @sauna | stage-5 | `packages/neon/src/rls.ts` exports `rlsEnable()`, `rlsViewerPolicy()`, `rlsCreatorPolicy()`, `rlsAdminPolicy()`, `rlsOperatorPolicy()`, and `rlsPolicies(role, opts)`. All functions return SQL strings for migration files. Tenant isolation via `current_setting('app.tenant_id', TRUE)`. 100% coverage, 30 tests. Branch `claude/dazzling-brahmagupta-RcOz7`. |
| G34 | No PostHog funnel definitions for monetization paths | **closed** | @sauna | stage-2 | `MONETIZATION_FUNNEL` constant + `trackFunnelStep()` + `getFunnelPosition()` shipped in `@lwt/analytics`. 5-step funnel with per-product event overrides. 103 tests, 96.49% branch coverage. Branch `claude/dazzling-brahmagupta-RcOz7`. |
| G35 | No transactional email templates in `@lwt/email` (currently raw `sendEmail()` only) | **closed** | @sauna | stage-5 | `packages/email/src/templates.ts` exports 6 typed template functions: `subscriptionConfirmedTemplate`, `renewalFailedTemplate`, `payoutCompletedTemplate`, `accountReviewRequiredTemplate`, `magicLinkTemplate`, `passwordResetTemplate`. Each returns `{ subject, html, text }` ready for `sendTransactional()`. `BrandVars` interface (productName, supportEmail?, logoUrl?, accentColor?) controls per-product branding. 37 tests; 85.4% branch coverage. Branch `claude/dazzling-brahmagupta-RcOz7`. |
| G36 | No audit logging for payout/admin mutating operations | **closed** | @sauna | stage-5 | `factory_audit_log` table (migration 0105) + `@lwt/compliance.sendAuditEntry()` ships in P2.13g. POST /v1/audit on factory-core-api ingests entries with actor/action/resource/result. AUDIT_INGEST_KEY service auth. Branch `claude/dazzling-brahmagupta-RcOz7`. |
| G37 | `CF_API_TOKEN` and `LATIMERWOODS_SENTRY_AUTH` lack scopes for billing/stats endpoints | **closed** (Sentry fixed, CF pending) | @adrper79-dot | stage-2 | Cost digest run 2026-05-15 returned HTTP 403 on Cloudflare `billing/profile` and Sentry `stats_v2`. Sentry fixed: `cost-observability.yml` + `revenue-digest.yml` reordered to try `FACTORY_SENTRY_API` (stats scope) before `LATIMERWOODS_SENTRY_AUTH`. CF billing 403 tracked separately as G38. |
| G38 | GCP billing line in cost digest is a placeholder — needs BQ billing export | open | @adrper79-dot | stage-2 | `scripts/cost_digest.py::collect_gcp` returns "skipped: missing GCP_BILLING_TOKEN or GCP_BILLING_ACCOUNT_ID" — but the real path is a BigQuery billing export ([docs](https://cloud.google.com/billing/docs/how-to/export-data-bigquery)). Until that's configured + queried, no GCP $ in the digest. |
| G39 | Auto-merge bot race: drift PRs from aggregator can sit open and block subsequent runs | **closed** | @sauna | stage-2 | `completion-tracker.yml` now re-arms auto-merge (`gh pr merge --auto --squash` + `--admin` fallback) when same-day PR has been open >2h. Branch `claude/dazzling-brahmagupta-RcOz7`. |
| G40 | Cross-agent institutional memory has no single entry point | **in-progress** | @sauna | stage-1 | Memory spreads across CLAUDE.md, ROADMAP.md, FRIDGE.md, GAP_REGISTER.md, decisions/, conformance/, cost/, completion-tracker.json — no agent reads all of them on boot. Fix: `docs/STATE.md` auto-generated daily (PR landing 2026-05-15). Patterns surface added via `docs/architecture/PATTERNS.md`. |

## coh-specific gaps (2026-05-19 sprint)

Opened after a fresh audit of `Latimer-Woods-Tech/coh` against its shipped reality. See [`docs/runbooks/coh-world-class-sprint.md`](./runbooks/coh-world-class-sprint.md) for sprint scope and PR links.

| ID | Gap | Status | Owner | Target | Fix mechanism |
|---|---|---|---|---|---|
| G41 | coh: deploy.yml has no CI test gate — every push to main deploys without typecheck/test verification | **in-progress** | @adrper79-dot (sprint team A) | stage-2 (this sprint) | Add `test` + `typecheck` job to `.github/workflows/deploy.yml` as required gates on the deploy job. Severity HIGH: an unguarded deploy path was the failure mode behind the recent auth iteration churn (commits `93e5e45` debug → `23f2128` fix → `c70478e` revert). |
| G42 | coh: test coverage ~5% — only 5 test files (`auth`, `logger`, `rate-limit`, `booking-availability`, `webhooks/idempotency`) covering a 17-route surface | **in-progress** | @adrper79-dot (sprint team B, branch `worldclass/test-coverage`) | stage-2 (this sprint = 70%, world-class = 90%) | Add tests for the 17 route files in `coh/src/routes/` (auth, booking, store, academy, events, show, subscriptions, webhooks, communications + 8 admin-* routes). Severity HIGH — required for any "shipped" claim and the source of cohesion 25/100. |
| G43 | coh: Sentry DSN synced as a secret but never initialized in the worker | **in-progress** | @adrper79-dot (sprint team A) | stage-2 (this sprint) | Wire `@latimer-woods-tech/monitoring.sentryMiddleware(c.env.SENTRY_DSN)` into `coh/src/index.ts` before the route mounts. Severity HIGH — Sentry is the only outbound channel for production errors and is currently a no-op. |
| G44 | coh: 3 hardcoded `.workers.dev` fallback URLs in the frontend (`coh/web/`) — HARD-CONSTRAINT violation | **in-progress** | @adrper79-dot (sprint team A) | stage-2 (this sprint) | Remove the three `*.workers.dev` references from the frontend and route all client calls via the branded custom domain `https://api.cypherofhealing.com`. Severity MED. Violates CLAUDE.md "No `*.workers.dev` URLs in any user-facing HTML, JS, or API client code". |
| G45 | coh: `/__db/reset` and `/__db/stripe-bootstrap` routes live in production without an `ENVIRONMENT === 'development'` guard | **in-progress** | @adrper79-dot (sprint team A) | stage-2 (this sprint) | Wrap the `adminDb` route (mounted at `/__db` and `/api/admin/db` in `coh/src/index.ts:140-141`) in a `c.env.ENVIRONMENT === 'production' && return 404` guard, OR remove the `/__db` (no-prefix) mount in production. Severity MED — a public DB-reset endpoint is a data-loss path. |
| G46 | coh: 20+ obsolete root-level MD docs (DEPLOYMENT-*, DEPLOY-*, INTEGRATION-*, GETTING-STARTED, etc.) with internally inconsistent README | open | @adrper79-dot | stage-3 | Audit, consolidate into `coh/docs/runbooks/` following the Factory template, delete the dead `.md` files at root. Severity MED — directly hurts new-contributor onboarding and cohesion score. |
| G47 | Service registry was missing a `coh` entry until 2026-05-19 (only the legacy `cypher-healing` entry existed) | **closed** | @adrper79-dot | this sprint | Closed by [`docs/service-registry.yml`](./service-registry.yml) edit in this PR. Severity LOW — registry hygiene. |
| G48 | coh: cohesion score 25/100 vs the world-class threshold of 70 — composite signal that aggregates G41–G46 plus other dimensions | **in-progress** | @adrper79-dot (sprint teams A+B+C) | stage-2 (this sprint) | Closes naturally as G41–G46 close. Targets: observability 0→60 (G43), tests 40→70 (G42), workflows 33→67 (G41), security 20→60 (G44+G45), schema 33→67 (validation pass). Severity LOW (roll-up only). |

## Meta-gaps (the framework can't auto-answer)

| ID | Question | Surface |
|---|---|---|
| M1 | Are we building the right thing for the right customer? | Quarterly customer gate (OPERATING_FRAMEWORK §rule-10). ICP work per product. |
| M2 | At what point do we stop building and start selling? | Quarterly customer gate. Memory shows 9 days at zero new customers. |

## How to use this register

- **Agents** (supervisor, sub-agents, Claude reviewer): when planning work, check this register for gaps in the milestone's target stage. Prefer closing register entries over inventing new work.
- **Aggregator workflow:** read this file; report `open` P0 + P1 counts in the daily Pushover digest.
- **Monday review:** triage `open` gaps; promote, demote, or close.
- **Adding gaps:** open a PR adding a row; reference the source incident or doc. Severity assigned by the reviewer.
- **Closing gaps:** edit status to `closed`, add a one-line summary of how it closed, link the PR that closed it.

## Tracker-aggregator integration

When `aggregate_completion.py` runs, it tallies:

```
P0 open: N
P1 open: M
P2 open: K
P3 open: J
Closed this week: X (out of Y opened-or-closed)
```

These four numbers go in the Pushover digest right under the cohesion score. Open P0 > 0 = the system flags itself as not-ready.
