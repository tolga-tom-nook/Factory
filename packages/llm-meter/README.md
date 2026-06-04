# @latimer-woods-tech/llm-meter

Per-run and per-tenant LLM budget enforcement + D1 ledger for the Factory platform.

## Schema

Apply migrations once per consumer D1 database:

```bash
# Initial schema
wrangler d1 execute <DB> --file=node_modules/@latimer-woods-tech/llm-meter/migrations/0001_init.sql
# Tenant budget columns (0.2.0+)
wrangler d1 execute <DB> --file=node_modules/@latimer-woods-tech/llm-meter/migrations/0002_tenant_budget.sql
```

## Usage

### Per-run budget (existing)

```ts
import { meteredComplete } from '@latimer-woods-tech/llm-meter';

const res = await meteredComplete(
  env.DB,                              // D1 binding
  [{ role: 'user', content: 'hi' }],
  env,                                 // LLMEnv (AI Gateway + Anthropic + Vertex + Groq)
  {
    project: 'prime-self',
    actor: 'worker',
    runId: 'run-abc-123',
    workload: 'synthesis',
    tier: 'balanced',
    budget: { perRunCapCents: 500 },   // $5 default
  },
);

if (res.error?.code === 'BUDGET_EXCEEDED') {
  // run hit its cap; short-circuit or escalate
}
```

### Per-tenant monthly budget (0.2.0+)

Pass `tenantId` + `tenantTier` to enforce the monthly cap defined in `TIER_BUDGET_CENTS`.

```ts
import { meteredComplete, TIER_BUDGET_CENTS } from '@latimer-woods-tech/llm-meter';

const res = await meteredComplete(
  env.DB,
  [{ role: 'user', content: 'hi' }],
  env,
  {
    project: 'prime-self',
    actor: 'worker',
    runId: 'run-abc-123',
    workload: 'synthesis',
    tier: 'balanced',
    tenantId: req.tenantId,      // e.g. Stripe customer ID or internal UUID
    tenantTier: req.planTier,    // 'free' | 'individual' | 'practitioner' | 'agency'
    budget: {
      // Optional: fires when tenant crosses 80% of monthly cap
      onBudgetAlert: async (ctx) => {
        await sendAdminEmail({
          subject: `⚠️ Tenant ${ctx.tenantId} at ${ctx.percentUsed.toFixed(0)}% LLM budget`,
          body: `Spent $${(ctx.spentCents / 100).toFixed(2)} of $${(ctx.capCents / 100).toFixed(2)} (${ctx.tier}, ${ctx.yyyyMm})`,
        });
      },
    },
  },
);

if (res.error?.code === 'BUDGET_EXCEEDED') {
  // Return 429 — tenant hit their monthly LLM cap
  return c.json({ error: 'Monthly AI usage limit reached. Please upgrade your plan.' }, 429);
}
```

### Tier budget caps

```ts
import { TIER_BUDGET_CENTS } from '@latimer-woods-tech/llm-meter';

// TIER_BUDGET_CENTS:
// { free: 50, individual: 300, practitioner: 3500, agency: 15000 }
// (values in US cents)
```

| Tier          | Monthly cap | Notes                                    |
|---------------|-------------|------------------------------------------|
| free          | $0.50       | Allows 1 synthesis + 5 questions; stops abuse |
| individual    | $3.00       | 3× headroom over expected $0.43 COGS     |
| practitioner  | $35.00      | Hard cap ≈ 36% of $97/mo MRR; leaves 60%+ margin  |
| agency        | $150.00     | $30/seat × 5 seats                       |

### Threshold events

| Threshold | Effect |
|-----------|--------|
| ≥ 80%     | `onBudgetAlert` callback invoked (admin email/Slack). Never blocks. |
| ≥ 90%     | `BUDGET_WARNING` log event emitted via logger. |
| ≥ 100%    | `BUDGET_EXCEEDED` error returned (HTTP 429). LLM call never executes. |

### Low-level helpers

```ts
import { assertTenantBudget, getTenantMonthTotal } from '@latimer-woods-tech/llm-meter';

// Get current month spend for a tenant
const spentCents = await getTenantMonthTotal(env.DB, tenantId, '2026-05');

// Check budget (throws BUDGET_EXCEEDED if at/over cap)
await assertTenantBudget(env.DB, tenantId, 'practitioner', {
  onBudgetAlert: alertAdmin,
}, { logger });
```

## What it does

1. **Before** the LLM call: queries `SUM(cost_cents) WHERE run_id = ?`. If ≥ per-run cap, throws `BUDGET_EXCEEDED` and the LLM call never runs.
2. **Before** the LLM call (0.2.0+): queries `SUM(cost_cents) WHERE tenant_id = ? AND yyyy_mm = ?`. Fires alert at 80%, logs warning at 90%, throws `BUDGET_EXCEEDED` at 100%.
3. **After** a successful LLM call: writes one ledger row with provider, model, tokens (incl. cached), cost in cents, latency, project, actor, tenant_id, run_id, workload, and `yyyy_mm`.
4. On LLM failure: no ledger row — we only bill for completed work.
5. On D1 write failure: logs `llm-meter.record.failed` and returns the LLM response anyway. Metering must never block a successful response.

## Pricing catalogue

`PRICING_CENTS_PER_MTOK` in `src/index.ts` lists input/output/cached-input rates in **US cents per million tokens** (USD × 100 — e.g. Sonnet input `300` = $3.00/1M) for every model the `llm` package routes to. Keep in sync with provider pricing pages — unknown models bill at 0 and emit nothing special (budget checks still work on the $0).

## Querying spend

```sql
-- per-run total
SELECT SUM(cost_cents) / 100.0 AS dollars FROM llm_ledger WHERE run_id = 'run-abc-123';

-- per-project per-month
SELECT actor, SUM(cost_cents) / 100.0 AS dollars, COUNT(*) AS calls
FROM llm_ledger WHERE project = 'prime-self' AND yyyy_mm = '2026-05'
GROUP BY actor ORDER BY dollars DESC;

-- per-tenant per-month (0.2.0+)
SELECT tenant_id, SUM(cost_cents) / 100.0 AS dollars, COUNT(*) AS calls
FROM llm_ledger WHERE yyyy_mm = '2026-05' AND tenant_id IS NOT NULL
GROUP BY tenant_id ORDER BY dollars DESC;

-- tenants near their budget
SELECT w.tenant_id, w.tier, w.percent_used, w.spent_cents, w.cap_cents, w.yyyy_mm
FROM tenant_budget_warnings w
WHERE w.yyyy_mm = '2026-05' AND w.percent_used >= 80
ORDER BY w.percent_used DESC;
```

## Escalating the cap

The per-run cap is soft — you can pass `budget: { perRunCapCents: 2000 }` for one call. For permanent changes, wire into your supervisor config; see `docs/architecture/FACTORY_V1.md § LLM substrate`.
