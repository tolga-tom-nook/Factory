---
date: 2026-06-08
decider: "@adrper79-dot"
status: decided
---

# 2026-06-08 — Admin Studio surface & responsibility boundary

> Scope note: this is the *short* boundary record. The full enforcement program already
> exists as [`docs/admin-studio/06-DEBT-DELIVERY-PLAN.md`](../admin-studio/06-DEBT-DELIVERY-PLAN.md)
> (Tranches 0–5, owned by the admin-studio hardening effort). **That plan is the single
> authoritative debt register for the Admin Studio control plane** — this ADR only fixes
> the *boundary of record* and the sense-layer modeling; it does not maintain a parallel
> backlog (the plan forbids parallel backlogs).

## Decision

**Admin Studio is one product with separate surfaces and a fixed ownership boundary; the API is authoritative and the UI only collects intent.** "factory-admin" is a legacy/secondary deployment surface of this same product — not a distinct product.

## Context

The platform has several "admin" artifacts — `apps/admin-studio` (API), `apps/admin-studio-ui` (UI), `packages/studio-core`, and the older standalone `Latimer-Woods-Tech/factory-admin` repo. They were being treated (including by the Platform Brain entity graph) as if some were duplicate or competing products. They are not: they are surfaces/components of one product, Admin Studio, whose boundary was documented in planning but only partially enforced in code — responsibility has leaked across the UI/API line.

## Why

The governing rule already exists (`04-MATURITY-AND-COHESION-PLAN.md` line 82): *"The API is authoritative. The UI explains and collects intent but does not calculate authoritative outcomes."* Leaks across this line (UI deciding authorization, inferring success from HTTP 200, duplicating policy per tab) silently corrupt the system — the same failure class §1.4.1 of the Admin Technical Guide warns about.

## Ownership boundary (authoritative)

| Surface | Owns |
|---|---|
| `packages/studio-core` | Stable action, policy, receipt, confirmation, environment, and error **contracts** |
| `apps/admin-studio` (Admin Studio **API**) | Auth, authorization, policy decisions, execution-time validation, mutations, orchestration, audit, receipt identity |
| `apps/admin-studio-ui` (Admin Studio **UI**) | Operator workflows, previews, confirmation collection, status presentation, error explanation, evidence navigation |
| Domain systems / workflows | The actual state machines: deployments, payouts, provisioning, GitHub workflows, runtime evidence |
| Supervisor | Autonomous proposal + approved-template scheduling — **not** another Admin UI |

**Flow:** operator intent → UI gathers inputs + preview ack + confirmation → API authenticates and re-evaluates policy → API creates action request / receipt → domain executor performs the mutation → API links audit + workflow + evidence → UI renders the result.

**The UI must never:** decide true authorization; decide reviewer separation; generate authoritative approval records; infer mutation success from HTTP 200; directly call GitHub/Stripe/Neon/Cloudflare/provisioners; reimplement domain state machines.

**The API must not:** own page layout or interaction sequencing; return presentation-specific structures; duplicate domain execution that belongs in Supervisor/provisioners; become the permanent source of truth for deployment/payout/runtime state.

## Naming (standardized)

- **Admin Studio** — the complete operator product.
- **Admin Studio API** — `apps/admin-studio`.
- **Admin Studio UI** — `apps/admin-studio-ui`.
- **Admin surface** — the broader platform category, including per-app `/admin/*` APIs.
- **Supervisor** — autonomous proposal/execution scheduler (not an Admin UI).
- **"Factory Admin" / `factory-admin`** — retired name; a legacy deployment surface to fold into the above.

## Consequences

We now do:
- Treat `factory-admin` as an Admin Studio surface in the sense layer (aliased to `admin-studio`; not ticketed for its own registry; not scored as a peer in conformance) and plan to fold/retire it in favor of the monorepo API + UI.
- Hold the API-authoritative invariant: the UI submits typed action requests; the API admits actions and creates receipts.

Enforcement is owned by [`docs/admin-studio/06-DEBT-DELIVERY-PLAN.md`](../admin-studio/06-DEBT-DELIVERY-PLAN.md), not restated here. In brief, its Tranches close the boundary leaks: T1 one authoritative action-admission service (policy evaluated once, server-side) + durable receipts + idempotency; T2 Command Center default + one shared action experience; T2/T5 static read-model ownership + one shared client contract. Findings go into that register, not a parallel backlog.

**Autonomy interlock (binds the Platform Brain):** the autonomous loop (opportunity-scan / Supervisor) is a *consumer* of the authoritative action path, not a parallel mutator. Per that plan's Tranche 4 + model-routing table, autonomous Admin Studio admission stays gated until Tranches 0–3 pass, and when enabled must submit typed requests through the same action-admission contract — never invent execution semantics or exceed an equivalent human request. The Platform Brain also does not file parallel Admin Studio control-plane debt tickets; that register is canonical.

We do NOT:
- Move `apps/admin-studio` out to its own repo. The monorepo trio (studio-core + API + UI) is canonical; relocating is not the goal — enforcing the boundary is.

## Revisit when

- Someone proposes a second operator UI, or the enforcement backlog is scheduled (promote to a full RFC at that point), or `factory-admin` is actually archived/folded.
