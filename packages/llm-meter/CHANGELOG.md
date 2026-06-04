# Changelog

## 0.2.4 — 2026-06-03

### Changed (single source of truth)

- `@latimer-woods-tech/llm`'s `MODEL_PRICE_PER_1M` is now the **canonical** rate
  source. `PRICING_CENTS_PER_MTOK` here is defined as that table × 100, and a new
  drift-guard test (`pricing-sync.test.ts`) fails CI if any rate diverges. This
  prevents the silent divergence that produced the earlier gemini ($5 vs $10) and
  missing-deepseek/llama errors.
- Removed `gemini-1.5-flash` and `llama-3.3-70b-versatile` (not in the canonical
  table and not in active routing). They now bill `$0` like any unknown model;
  add them to `llm`'s table if they ever need pricing.

---

## 0.2.3 — 2026-06-03

### Fixed (correctness)

- **`computeCostCents` under-reported every cost by 100×.** The per-MTok price
  table is denominated in cents (Sonnet `300` = $3.00/1M), but the function
  treated its cents result as "ucents" and divided by 100 a second time. This
  made all tier budget caps (`TIER_BUDGET_CENTS`, `perRunCapCents`) effectively
  100× too loose and understated ledger COGS 100×. The only test asserted `> 0`,
  so CI never caught it. Removed the erroneous `/100`.
- Renamed `PRICING_UCENTS_PER_MTOK` → `PRICING_CENTS_PER_MTOK` and corrected the
  mislabeled unit comment + README (values are **US cents per 1M tokens**).

### Added (no breaking changes)

- Populated previously-missing rates so they no longer bill `$0`/half, mirrored
  from `@latimer-woods-tech/llm` `MODEL_PRICE_PER_1M`:
  - `llama-4-maverick` (live `verifier` tier) — $0.50/$0.77 per MTok
  - `deepseek-chat` / `deepseek-reasoner` (live `workbench` tier)
  - `gemini-2.5-pro` output corrected $5 → $10 per MTok; added cache-read rate
- Pinned regression tests (1M Sonnet input = 300c; verifier/workbench ≠ 0).

> Note: `@latimer-woods-tech/llm` `estimateCostUsd` was already correct, so the
> in-call `maxCostUsd` hard cap was unaffected. The two packages still maintain
> separate pricing tables — reconciling to a single source is a tracked follow-up.

---

## 0.2.2 — 2026-05-27

### Added (no breaking changes)

- **xAI pricing entries** in `PRICING_UCENTS_PER_MTOK`:
  - `grok-4.3` — $1.25/$2.50 per MTok (in/out)
  - `grok-4-fast` — $1.25/$2.50 per MTok (deprecated alias, retained for ledger rows)
  - `grok-3-mini-latest` — $1.25/$2.50 per MTok (deprecated alias)
  
  Prevents `estimateCost()` from returning `$0` when the `fast` tier routes to Grok 4.3.
- Peer dependency updated: `@latimer-woods-tech/llm ^0.3.3` (was `^0.3.1`).
- Source attribution comment updated to include `docs.x.ai`.

---

## 0.2.1 — 2026-05-27

### Added (no breaking changes)

- **Missing Anthropic model entries** in `PRICING_UCENTS_PER_MTOK`:
  - `claude-haiku-4-5-20251001` — same rate as `claude-haiku-4-20250514` ($0.80/$4.00 per MTok)
  - `claude-sonnet-4-6` — same rate as `claude-sonnet-4-20250514` ($3.00/$15.00 per MTok)
  - `claude-opus-4-7` — same rate as `claude-opus-4-20250514` ($15.00/$75.00 per MTok)
  
  Prevents `estimateCost()` from returning `$0` when callers use these model ID aliases.

---

## 0.2.0 — 2026-05-05

Per-tenant monthly budget guardrails (closes factory#issue — "Add per-tenant LLM budget guardrails before Practitioner-tier scale").

### Added

- `TenantTier` type (`'free' | 'individual' | 'practitioner' | 'agency'`).
- `TIER_BUDGET_CENTS` constant — monthly LLM caps per tier in US cents:
  - free: $0.50, individual: $3.00, practitioner: $35.00, agency: $150.00.
- `getTenantMonthTotal(db, tenantId, yyyyMm)` — queries `SUM(cost_cents)` partitioned by `tenant_id + yyyy_mm`.
- `assertTenantBudget(db, tenantId, tier, opts, deps)` — three-level enforcement:
  - ≥ 80 %: calls `opts.onBudgetAlert` callback (admin email/Slack); errors in the callback are swallowed.
  - ≥ 90 %: emits `BUDGET_WARNING` log event via `deps.logger`.
  - ≥ 100 %: throws `BUDGET_EXCEEDED` (HTTP 429).
- `BudgetAlertContext` interface — passed to the `onBudgetAlert` callback.
- `tenantId` and `tenantTier` fields on `MeteredOptions` — when both are provided, `meteredComplete` runs the per-tenant check before the LLM call.
- `tenantId` field on `LedgerRow` — stored in the `tenant_id` column for aggregation queries.
- `onBudgetAlert` callback on `BudgetConfig` — fire-and-forget hook for threshold notifications.
- Migration `migrations/0002_tenant_budget.sql`:
  - `ALTER TABLE llm_ledger ADD COLUMN tenant_id TEXT` + index.
  - New `tenant_budget_warnings` table for admin dashboard queries.

### Design notes

- **Alert/warning callbacks never block the request.** `onBudgetAlert` errors are caught and logged.
- **Tenant check is opt-in.** Calls without `tenantId` + `tenantTier` skip the per-tenant SELECT entirely.
- **Budget tiers live in-repo.** Rate changes → bump `TIER_BUDGET_CENTS` → publish a minor release.

---

## 0.1.1 — 2026-05-03

Patch: added `PRICING_UCENTS_PER_MTOK` and `DEFAULT_RUN_CAP_CENTS` to public exports.

## 0.1.0 — 2026-05-02

Initial release. Implements **SUP-2.2** per `docs/architecture/FACTORY_V1.md § LLM substrate`
and factory#102.

### Added

- `meteredComplete()` — wrapper around `@latimer-woods-tech/llm@^0.3.0`'s `complete()` that
  enforces per-run budget before the call and records one D1 ledger row after success.
- `recordCall()`, `getRunTotal()`, `getProjectMonthTotal()`, `assertRunBudget()` — low-level
  ledger primitives for consumers that need custom flows.
- `computeCostCents()` — pure function mapping `(model, input, output, cachedInput)` to cents,
  with a `PRICING_UCENTS_PER_MTOK` catalogue covering every model the `llm` package routes to.
- `BUDGET_EXCEEDED` error code (FactoryBaseError subclass carrying `{ runId, maxCents, actual, callCount }`).
- D1 migration `migrations/0001_init.sql` — `llm_ledger` table + 3 indexes
  (`project+yyyy_mm`, `run_id`, `actor+yyyy_mm`).

### Design notes

- **Metering is never blocking on output.** If the D1 insert fails, we log `llm-meter.record.failed`
  and return the LLM response anyway. Losing a ledger row is strictly preferable to losing a completion.
- **No ledger row on LLM failure.** We only bill for work that produced content.
- **Budget check is opt-out.** Calls without `runId` skip the pre-call SELECT; callers that want
  strict project-level enforcement can `assertRunBudget` themselves.
- **Pricing rate card lives in-repo.** Provider price moves → bump the catalogue → publish a
  patch release. No runtime fetch.
