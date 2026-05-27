---
date: 2026-05-25
decider: adrper79-dot
status: decided
supersedes_partial: docs/decisions/2026-05-23-workflow-lifecycle.md
---

# 2026-05-25 — Factory alignment: what it IS, what it is NOT, what to build next

After a month of hopping across configurations searching for an alignment that properly supports the business model on top, this is the resolution. Captured here so it doesn't drift back into ambiguity.

---

## The alignment in one paragraph

**Factory is the shared infrastructure layer plus an AI-metered orchestrator plus the canonical state for cross-app concerns. Apps own their products end-to-end. The supervisor — template-grounded, never generative — drives the operational lifecycle. The business model lives in the apps; Factory only enables. Every layer has hard caps, every loop has gates, every gate has evidence, and the platform's cost discipline is non-negotiable.**

---

## Today's concrete actions (what made the alignment legible)

| Change | State |
|---|---|
| GHAS Code Security disabled (HD + capricast) — CodeQL/lint noise eliminated | ✅ shipped via API |
| GHAS Secret Protection preserved on 7 private repos — push-time credential block | ✅ active ($19/mo, 1 active committer) |
| HD CI consolidation: 6 PR-triggered workflows → 1 matrix workflow with shared cache | ✅ PR #298 merged 2026-05-27 |
| GCP $50/mo budget on factory-495015 with 50/90/100% alerts | ✅ active (budget id `0a030ee8-17f6...`) |
| Org Copilot Business — declined; personal Pro+ ($39/mo on adrper79-dot) is sufficient | ✅ explicit non-decision |
| CodeQL workflow files disabled on HD + capricast | ✅ shipped via API |

**Net monthly cost rebalance:**

```
Before today:    ~$70-100/mo with intermittent runaway risk
After today:     ~$25-30/mo Actions+GHAS + $39 personal Pro+ + <$10 GCP
Annualized save: ~$540/year + bounded blast radius
```

---

## The seven principles that emerged

These are the operating rules that resolve to the alignment. They are testable and override prior architecture documents wherever they conflict.

1. **Free tiers first.** Factory is public → Actions are free, period. Personal Pro+ over org Business. GCP under a hard budget cap. Drop tools that aren't paying back (CodeQL for our stack).
2. **GHAS bills per active committer, not per repo.** Optimizing the *feature* matters; optimizing the *surface area* does not. One committer × Secret Protection = $19 whether on 1 repo or 7.
3. **Constraint-aware gates over generic scanners.** Custom rules for our stack (no `process.env`, no `Buffer`, no `*.workers.dev` in client) catch real violations. Generic scanners produce noise that burns Claude tokens and time.
4. **Consolidate test infrastructure.** One workflow per concern, shared cache, parallel jobs via matrix. Per-workflow `checkout`+`setup-node`+`npm ci` is the largest unbilled cost.
5. **Factory orchestrates, apps execute.** Cross-repo orchestration runs on Factory's free public minutes. Per-app CI/test/deploy stays in the app because branch protection requires same-repo status checks.
6. **Templates beat generative planning.** Every template comes from a closed real issue, not from imagination. Generative is the failure mode that breaks trust.
7. **Hard caps everywhere.** Per-run $5, per-day, per-month, per-LLM-call. GitHub Actions spending limit. GCP budget alerts. Single-writer locks. Concurrency groups. Defense-in-depth against the wordis-bond-class 63K-minute anomaly.

---

## Aspirational states collected (the map)

These are the target states accumulated across this session, [`FACTORY_V1.md`](../architecture/FACTORY_V1.md), [`docs/supervisor/ARCHITECTURE.md`](../supervisor/ARCHITECTURE.md), and prior decisions. Listed by surface so the seams below can connect them.

### Platform layer (L1–L3)

- **L1 Runtime:** Cloudflare Workers + Hyperdrive + R2 + KV + Stream + AI Gateway. GCP as the only non-Workers compute (Cloud Run, Vertex AI, Secret Manager + WIF). Neon as the only Postgres.
- **L2 Shared packages:** 24 packages at the documented dependency order. `errors → monitoring → logger → ... → schedule`. Each owns one concern, none owns app business logic.
- **L3 Reusable workflows:** `_app-ci`, `_app-deploy`, `_app-prod-canary`, `_app-reliability-gate`, `_post-deploy-verify`. Apps consume via 5-line caller workflows.

### Control plane (L4 — Supervisor)

- Template-grounded planner; no generative imagination
- Three trust tiers (Green / Yellow / Red) with path-based routing
- Short-lived scoped JWTs per tool class
- Single-writer `LockDO` per app
- Per-run $5 cap during calibration, p95×1.5 caps in steady-state
- D1-resident state: `supervisor_runs`, `supervisor_steps`, `template_stats`, `supervisor_verifications`, `locks_audit`
- Plan-approval gate on first 10 runs per template, always on Yellow/Red
- /admin mutations require out-of-band CODEOWNER ✅ regardless of tier (FRIDGE rule 4)
- Hard never-list: no deleting CF resources, no Stripe mutations, no live email/SMS outside test, no ruleset changes

### Spec plane (L5 — Dreamstate)

- Human-authored issues OR `documents/factory/dreamstate/<app>/<feature>/spec.yml` files
- `supervisor:approved-source` label required for supervisor pickup
- Sentry/Stripe/PostHog webhook workers file issues automatically

### Cross-cutting concerns

- **Observability:** Sentry (errors) + PostHog (product) + `factory_events` (business events in Neon) + `llm_ledger` (D1 cost ledger) + `template_stats` (D1 quality) + Pushover/Telnyx alerts
- **Cost discipline:** AI Gateway routing, per-project budgets, monthly p95×1.5 caps, weekly spend report, GHAS billed per active committer
- **Security:** confused-deputy-aware (issue body = untrusted data), credential-scrub on every PR, schema-bounded tool calls, write-amplification ceiling (≤25/run, ≤5/app)
- **Compliance:** SAQ-A Stripe posture, DSR primitive exists in `@lwt/compliance`, TCPA/FDCPA locked behind wordis-bond automation block

### The video production pipeline (already operational)

PostHog signals → priority scoring → schedule-worker → hourly video-cron Worker → `workflow_dispatch` → render-video.yml (LLM script + ElevenLabs + Remotion + ffmpeg + R2 + Stream) → Capricast publish. First live video at https://capricast.com/watch/5209dd21-... since 2026-05-20.

### The "better gate" architecture (replacing CodeQL)

Three layers:

- **Layer 1: deterministic constraint check** (~5 sec) — grep-based scanner against the PR diff for hard-constraint violations (CLAUDE.md). Stack-specific patterns, near-zero false positives.
- **Layer 2: Biome lint+format only** (~10 sec) — drops ESLint from CI on new apps; Biome's tight ruleset catches real bugs not style preferences.
- **Layer 3: diff-aware Claude review** (~1-2 min) — `factory-cross-repo` reads diff with semantic understanding, posts inline review comments, costs ~$0.05/PR via Anthropic.

### Cost / billing target state

| Line | Steady-state target |
|---|---:|
| GitHub Team plan | $4/mo |
| GHAS Secret Protection (1 committer) | $19/mo |
| GitHub Actions (post-#298, with spending cap) | $2-5/mo |
| Personal Copilot Pro+ | $39/mo |
| GCP factory-495015 (budget-capped) | <$10/mo |
| Anthropic (supervisor + reviewer + video) | ~$50-100/mo (metered, capped) |
| Neon (14 projects) | ~$50-80/mo |
| Cloudflare Pro + Workers | ~$10-20/mo |
| **Total platform cost** | **~$180-230/mo** |

Above this baseline, app-specific costs (Stripe fees, Telnyx, Resend, ElevenLabs, video Stream) attribute to the apps themselves, not Factory.

---

## Seams to build (the connecting tissue, prioritized)

Ordered by ROI × strategic-alignment.

### Tier 0 — Immediate (this week)

1. ✅ **Merge HD PR #298** — merged 2026-05-27 after pinning `slackapi/slack-github-action` to an immutable SHA and removing CodeQL from the consolidated PR suite because GHAS Code Security is disabled.
2. ✅ **Set Actions org spending limit ($25/mo)** — verified 2026-05-27 via GitHub billing budgets API: Actions budget is `$25`, `prevent_further_usage: true`, alerts to `adrper79-dot`.
3. ✅ **Ship the "better gate" PR to Factory** — Layer 1 (`_app-constraints-gate.yml` + `constraints-check.mjs`) and Layer 3 (`pr-review.mjs` live-loads CLAUDE.md Hard Constraints) are present in Factory.

### Tier 1 — Foundation (next 2 weeks)

4. **`capabilities.yml` in every app** — currently only Factory has it (or none, per gap register G-2). Apps need this for supervisor visibility. Template + per-app PRs.
5. **`@lwt/llm-meter` package publish** — D1 ledger + per-run budget enforcement (gap register G-7). Closes the metering gap so the supervisor can self-bound LLM spend.
6. **Migration drift guard** — `_migration-drift-guard.yml` per app (gap register G-5). Catches the HD#65-class incident where prod schema lags repo migrations.
7. **Template library expansion** — author 6-8 starter templates from closed PR history (gap register G-3). Required before SUP-4 EXEC leg can ride live work.

**Reconciled 2026-05-27.** Some Tier 1 foundation work already exists in Factory and should not be rebuilt: `@latimer-woods-tech/llm-meter@0.2.2`, `@latimer-woods-tech/llm@0.3.3`, `_migration-drift-guard.yml`, `_app-reliability-gate.yml`, and the seeded template library under `docs/supervisor/plans/`. The remaining work is adoption and proof: per-app `capabilities.yml`, per-app caller workflows, budget/gate rows visible in Admin Command Center, and blessed templates from real successful runs.

### Tier 2 — Hardening (next month)

8. **`@lwt/llm@0.3.0`** — AI Gateway mandatory, Grok drop confirmed, Gemini long-context fallback wired (gap register G-6).
9. **Per-app `_app-reliability-gate.yml` callers** — CVE + P0 + coverage regression on every PR. Already exists, just needs adoption rollout.
10. **Sentry sourcemap upload retroactive fix** — gap register G-8. Stack traces are minified on several workers.
11. **DSR E2E test for HumanDesign Practitioner tier** — gap register G-15. Required before signing any CA/VA/CO/CT/UT/NV/TX-resident practitioner.

### Tier 3 — Optional / deferred

12. **Cross-repo orchestration consolidation** (the 7 HD workflows → Factory). $3/mo savings, not worth the engineering today. Pattern documented in this session.
13. **`factory_signals` queryable read-model** — for admin UI "what's blocking what." Build only when admin UI actually needs it.
14. **Full state-machine schema** (`factory_tasks` / `factory_runs` / `factory_gates` in Neon) — the proposal from earlier this session. **Deferred** — conflicts with GitHub-canonical kanban (FRIDGE rule 7) and D1-canonical supervisor state. Revisit if Admin Studio needs a unified queryable layer.

---

## What this alignment rules OUT

Saying yes to the above means saying no to these. Capturing here so they don't quietly re-enter scope.

- **Org Copilot Business** — declined. Personal Pro+ covers IDE/CLI/agent; org Business at $19/seat duplicates what Claude (`factory-cross-repo`) already does.
- **GHAS Code Security ($30/mo)** — declined. CodeQL noise > value on our stack; the "better gate" replaces it.
- **Cross-repo CI proxy** — declined. Branch protection requires same-repo status checks; the engineering cost dwarfs the savings.
- **Full state-machine consolidation in Neon** — deferred. Existing split (GitHub Issues = tasks, D1 = supervisor state, Neon = `factory_events`) is fit-for-purpose. Don't unify until a real consumer demands it.
- **Generative supervisor planning** — declined permanently. Templates only.
- **wordis-bond automation** — declined permanently. TCPA/FDCPA risk; locked from supervisor.
- **AI tokens as a monetized SKU** — deferred to Q3+ 2026. Six months of clean supervisor operation first.
- **Machine Payments Protocol** — deferred to 2027+. Out of 2026 scope per FACTORY_V1.

---

## How this aligns with the business model

The portfolio's revenue lives in:

- **Selfprime** (HumanDesign) — $97 Practitioner + $14 Individual + Agency tier. Stripe ACS shipped 2026-05-21.
- **Capricast** — Creator monetization, Stripe products live.
- **Xico-city** — DJMEXXICO creative-economy OS.
- **Future:** cipher-of-healing, the-calling, etc. — design-stage.

What Factory provides that makes these apps cheaper-to-build and less-risky-to-operate:

- **Pinned shared packages** → security fixes propagate to all apps in one PR
- **Reusable workflows** → CI/CD changes hit all apps without touching their repos
- **The supervisor** → routine ops (auto-merge, project sync, board updates) without human attention
- **`factory_events` + Sentry + PostHog** → cross-app observability
- **The better gate** → catches our hard constraints before they ship to a $97/mo customer

The business model lives in the apps. Factory's job is to make the apps non-stupid to ship — which means **Factory must not become a profit center, a feature factory, or a place where business logic accumulates**. Cost discipline today is what protects that.

---

## Revisit when

- An app's monthly platform cost exceeds 10% of its monthly revenue (then re-tier)
- A new aspirational state surfaces that doesn't fit one of the existing surfaces
- The supervisor's template hit-rate drops below 70% (then revisit template library)
- A cost line in the table above exceeds 2× its target for two consecutive months
- A new revenue product (Stage 3+ of the roadmap) materially changes the portfolio composition
