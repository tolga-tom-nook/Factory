# Factory Finish — Scope A

**Date:** May 14, 2026  
**Scope:** A (Stage 1 close-out + Scaffold packages → 1.0 + STACK.md auto-update)  
**Duration:** 2 weeks — May 15 → May 28, 2026  
**Reference:** [docs/ROADMAP.md](./ROADMAP.md), [docs/STACK.md](./STACK.md), [CLAUDE.md](../CLAUDE.md)

---

## Mission

Get Factory Core to **stable 1.0 across the board** in 2 weeks. After this, Factory's internal Stages 2–6 cadence runs on its own; consumer apps (xico-city Phase C starting June 1, HumanDesign, videoking, factory-admin) build on stable foundations.

This plan deliberately limits scope to Scope A — Stage 1 close-out and scaffold-package 1.0 bumps. Stages 2–6 are explicit deferrals; their planning happens at Factory's normal cadence after Sprint 2 of this plan completes.

---

## Audit Findings That Changed the Plan

The initial assumption was that 4 packages were scaffold-grade and needed real work. **That was wrong.** Deep code audit shows:

| Package | LOC (src) | Tests | Assessment |
|---|---|---|---|
| `realtime` (0.1.0) | 585 | 665 | Production-grade WebSocket Hibernation base class extracted from videoking. **Ready to bump to 1.0.** |
| `deploy` (0.2.0) | 143 | 177 | Intentionally minimal-by-design — the meat is `scripts/scaffold.mjs` + templates. **Correctly scoped; ready for 1.0.** |
| `testing` (0.2.0) | 1,751 across 5 files | 346+ | Solid mock library (Neon, Stripe, LLM, Telnyx, Resend, PostHog, Sentry). **Production-ready; bump to 1.0.** |
| `validation` (0.1.0) | 363 | 160 | Focused deterministic AI output validator. Worker-safe, zero deps. **Ready for 1.0.** |

**Translation:** No new code needed for any of the 4. They just need version bumps + README "1.0 scope locked" notes + publish tags. The previous "4 scaffold packages" framing was based on version numbers, not code state.

**The real work** is the missing Stage 1 deliverables and the missing STACK.md workflow trigger:

| Gap | Effort | Why it's blocking |
|---|---|---|
| `.github/workflows/update-stack-manifest.yml` doesn't exist | 30 min | STACK.md auto-update script works fine but never fires — 9-day staleness |
| `scripts/platform_conformance.py` doesn't exist | 1–2 days | Stage 1 M1 deliverable; gates exit |
| `.github/workflows/platform-conformance.yml` doesn't exist | 30 min | Triggers the above |
| `scripts/cost_digest.py` doesn't exist | 1–2 days | Stage 1 M2 deliverable |
| `.github/workflows/cost-observability.yml` doesn't exist | 30 min | Triggers the above |
| Unit tests for `aggregate_completion.py`, `init-matrix-issues.py`, `sync_labels_to_matrix.py` (G2) | 1 day | Stage 1 quality gate (≥80% coverage) |
| `.github/workflows/dead-mans-switch.yml` (G3) | 30 min | Stage 1 fold-in |
| LLM cost cap in `@latimer-woods-tech/llm-meter` (G8) | 0.5 day | Stage 1 fold-in |
| `sentry_project` field in FUNCTIONS_MATRIX schema (G10) | 0.5 day | Stage 1 fold-in |

**Note:** `prompts/STAGE_1.md` and `STAGE_1_FOUNDATION.md` are marked **HISTORICAL** — do not use. Current execution prompts are `prompts/AGENT_SUCCESS_CONTRACT.md` + `WORLD_CLASS_IMPLEMENTATION_DASHBOARD.md`.

---

## Sprint 1 — May 15–21: Stage 1 Close-Out

Stage 1 (Visibility) targets exit **May 18**. That's 4 working days. The plan compresses to fit, with buffer days for calibration.

| Day | Deliverable | Owner | Notes |
|---|---|---|---|
| 1 (May 15) | `.github/workflows/update-stack-manifest.yml` (fires on `workflow_run` after publish.yml succeeds) | Claude | Fixes 9-day STACK.md drift immediately |
| 1 (May 15) | Manual run of `scripts/update-stack-manifest.js` to sync STACK.md baseline | Claude | Brings STACK.md current before workflow takes over |
| 1–2 (May 15–16) | `scripts/platform_conformance.py` — 10-dimension scorer per PLATFORM_STANDARDS | Claude (draft) + Tech Lead (review) | Parses FUNCTIONS_MATRIX.md from each app repo, scores 10 dimensions, outputs cohesion-score column for COMPLETION_TRACKER.md |
| 2 (May 16) | `.github/workflows/platform-conformance.yml` — nightly + on-PR, shadow mode only | Claude | Pure read; no failures gate merges yet |
| 3 (May 17) | `scripts/cost_digest.py` — Cloudflare + Anthropic + Sentry + Stripe + GCP cost APIs | Claude (draft) + Ops Lead (creds review) | Reads each provider's billing API; emits daily $ figure per cost center |
| 3 (May 17) | `.github/workflows/cost-observability.yml` — daily scheduled run + Pushover notification | Claude | Cron at 09:00 UTC |
| 4 (May 18) | Unit tests for `aggregate_completion.py`, `init-matrix-issues.py`, `sync_labels_to_matrix.py` (G2; coverage ≥80%) | Claude | pytest in `scripts/tests/` |
| 4 (May 18) | `.github/workflows/dead-mans-switch.yml` (G3) — heartbeat from aggregator | Claude | Fires Pushover alert if aggregator hasn't run in 26 hours |
| 5 (May 19) | LLM cost cap in `@latimer-woods-tech/llm-meter` (G8) — daily $ ceiling per app, refuses requests above | Claude (draft) + Tech Lead (review) | Sub-1-day work in the existing llm-meter package |
| 5 (May 19) | `sentry_project` field in FUNCTIONS_MATRIX schema (G10) | Claude | Schema bump + aggregator query update |
| 6 (May 20) | **Conformance shadow runs** against HumanDesign, videoking, xico-city, factory-admin | Tech Lead (executes; Claude assists with calibration) | First-pass scores; identify outliers; tune scorer weights |
| 6 (May 20) | Pushover digest format update (Completion + Cohesion + Cost on one line) | Claude | Drop-in modification to `aggregate_completion.py` output formatter |
| 7 (May 21) | **Stage 1 exit gate:** Run digest end-to-end, confirm all three numbers land on phone | Tech Lead + Ops Lead | If pass → mark Stage 1 ✅ shipped in ROADMAP.md and close PRs |

**Sprint 1 success criteria:**
- ✅ Daily Pushover digest shows Completion + Cohesion + Cost
- ✅ STACK.md auto-updates within 5 minutes of any package publish
- ✅ Helper script tests at ≥80% coverage (G2 closed)
- ✅ All 5 P0/P1 gap fixes folded in (G2, G3, G5 deferred to Sprint 2, G8, G10)
- ✅ ROADMAP.md updated to mark Stage 1 ✅ shipped

**Cost ceiling:** $50 Anthropic + $0 GitHub Actions (per ROADMAP).

---

## Sprint 2 — May 22–28: Scaffold Packages → 1.0

The 4 packages are already complete code. Sprint 2 is version bumps, README scope lock, and ordered publishing.

| Day | Deliverable | Owner | Notes |
|---|---|---|---|
| 1 (May 22) | Single PR: bump `realtime`, `validation`, `testing`, `deploy` to `1.0.0` in their `package.json` files | Claude | One commit per package for clean revert |
| 1 (May 22) | README update for each: "Status: 1.0 — scope locked. Future changes are additive (minor) or bug fixes (patch) per semver." | Claude | Short "Scope" section listing the locked API surface |
| 2 (May 23) | G5 — Claude reviewer calibration shadow run on last 50 PRs | Tech Lead | Folded in from Sprint 1; calibrate reviewer model against historical decisions |
| 3 (May 24) | Tag and publish in dependency order: `realtime/v1.0.0` → wait for npm propagation (5 min) → `deploy/v1.0.0` → `testing/v1.0.0` → `validation/v1.0.0` | Tech Lead (NPM_TOKEN holder) | `publish.yml` handles dep-order build per package |
| 3 (May 24) | Verify STACK.md auto-updates after each tag (4 commits land on main from the workflow) | Claude (verifies) | Confirms the Sprint 1 workflow is live and idempotent |
| 4 (May 25) | Coordinate with xico-city: update `package.json` to `^1.0.0` for all 4 packages | Claude | Single PR in xico-city repo; doesn't change behavior since 1.0 == latest 0.x |
| 4 (May 25) | Run xico-city full test suite against 1.0 packages | Claude | Catch any breaking-change regression before xico-city Sprint 1 (June 1) |
| 5 (May 26) | Stage 1 close-out retrospective + Sprint 2 retrospective | All Leads | Document lessons in `docs/runbooks/lessons-learned.md` |
| 6–7 (May 27–28) | Buffer for follow-ups + Phase C+1 Factory roadmap draft | Tech Lead | Stage 2 prompt scaffold; Stages 3–6 priority sequencing |

**Sprint 2 success criteria:**
- ✅ 4 packages at 1.0.0 published to npmjs.org
- ✅ STACK.md auto-updated to reflect 1.0 versions
- ✅ xico-city consuming `^1.0.0` versions with green test suite
- ✅ Sprint 1 retrospective committed
- ✅ Stage 2 prompt scaffold drafted

---

## What Sprint 1 / Sprint 2 Does NOT Do (Explicit Non-Goals)

| Non-goal | Tracked to |
|---|---|
| Stage 2 (Revenue + Customer) — Launch Readiness, Stripe MRR, PostHog funnel | Factory Stage 2 cadence post-Sprint 2 |
| Stage 3 (Adoption tools) — `@lwt/eslint-config`, `@lwt/biome-config` | Factory Stage 3 cadence (Q3 2026) |
| Stage 4 (Enforcement) — conformance graduates shadow → required | Factory Stage 4 (gated on ≥80% repo scores) |
| Stage 5 (Sellability) — axe, PII inventory, DSR endpoints, status pages | Factory Stage 5 |
| Stage 6 (UI/UX Foundations) — `@lwt/ui-tokens`, `@lwt/design-system`, etc. | Already in flight via design-tokens@0.2.0, ui@0.2.0; full Stage 6 deferred to Q4 2026 |
| Migrating apps off scaffold status | Per-app concern; xico-city handles via its own Phase C plan |
| Pen-test / bug-bounty | GAP_REGISTER P3 — deferred until thresholds hit |

---

## What Claude Can Do This Session vs. What Needs Human Action

**Claude executes in-session:**
- ✅ Write `FACTORY_FINISH_PLAN.md` (this doc)
- ✅ Write `.github/workflows/update-stack-manifest.yml`
- ✅ Write `scripts/platform_conformance.py` (initial draft)
- ✅ Write `.github/workflows/platform-conformance.yml`
- ✅ Write `scripts/cost_digest.py` (initial draft)
- ✅ Write `.github/workflows/cost-observability.yml`
- ✅ Write `.github/workflows/dead-mans-switch.yml`
- ✅ Bump 4 packages to 1.0.0 in `package.json`
- ✅ Update 4 READMEs with "1.0 scope locked" notes
- ✅ Run `node scripts/update-stack-manifest.js` to sync STACK.md baseline
- ✅ Commit everything as ordered atomic PRs

**Human action required:**
- ⏸️ Confirm `supervisor-sa` (the service account behind `VERTEX_SA_KEY`) has `roles/secretmanager.secretAccessor` on the GCP Secret Manager entries the Stage 1 workflows pull (Pushover, Anthropic, Stripe, Sentry, GCP billing). Workflows authenticate via `google-github-actions/auth@v3` with the existing `VERTEX_SA_KEY` GitHub secret; missing IAM binding → `PERMISSION_DENIED` → graceful degradation (env var stays unset, downstream script skips that provider).
- ⏸️ Tag releases (`git tag {package}/v1.0.0 && git push --tags`) — requires `NPM_TOKEN`-enabled actor
- ⏸️ Run conformance shadow against real repos (uses Factory App token, no extra secret needed)
- ⏸️ Calibrate conformance scorer weights based on shadow data
- ⏸️ Review LLM cost cap thresholds before deploying to llm-meter

**Verified GCP Secret Manager names (project `factory-495015`, verified live 2026-05-15):**

| Env var the script expects | First-match canonical (live) | Fallbacks tried |
|---|---|---|
| `PUSHOVER_USER` | ✅ `FACTORY_PUSHOVER_USER` | `PUSHOVER_USER`, `pushover-user` |
| `PUSHOVER_TOKEN` | ✅ `FACTORY_PUSHOVER_API` | `PUSHOVER_TOKEN`, `pushover-token` |
| `ANTHROPIC_ADMIN_KEY` | ⚠️ `ANTHROPIC_ADMIN_KEY` (not present — falls back to regular API key) | `LATIMER_ANTHROPIC_API`, `ANTHROPIC_API_KEY` |
| `SENTRY_AUTH_TOKEN` | ✅ `LATIMERWOODS_SENTRY_AUTH` | `FACTORY_SENTRY_API`, `SENTRY_AUTH_TOKEN` |
| `STRIPE_API_KEY` | ✅ `STRIPE_SECRET_KEY` (⚠️ **LIVE key** — only used for read-only `balance_transactions`) | `stripe-api-key-readonly`, `STRIPE_API_KEY` |
| `CF_API_TOKEN` | ✅ `CF_API_TOKEN` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_API`, `cloudflare-api-token` |
| `CF_ACCOUNT_ID` | ✅ `CF_ACCOUNT_ID` | `cloudflare-account-id` |
| `GCP_BILLING_TOKEN` | ❌ not present (needs BQ billing export setup) | `gcp-billing-token` |
| `GCP_BILLING_ACCOUNT_ID` | ❌ not present (same) | `gcp-billing-account-id` |

**IAM grant applied 2026-05-15:** `supervisor-sa@factory-495015.iam.gserviceaccount.com` now has `roles/secretmanager.secretAccessor` at project level. Verified by reading 7 of 7 target secrets successfully.

**Caveats to surface to humans:**
- The Stripe key is `sk_live_*` — only the read-only `balance_transactions` endpoint is hit, but if a `STRIPE_TEST_SECRET_KEY` exists later, prefer it for cost reporting safety.
- `ANTHROPIC_API_KEY` and `LATIMER_ANTHROPIC_API` are regular API keys, not admin keys. The Anthropic Admin API endpoint (`v1/organizations/usage_report`) requires an admin key. Cost digest will report `skipped` on Anthropic with HTTP 401 until an admin key lands in Secret Manager as `ANTHROPIC_ADMIN_KEY`.
- GCP billing requires a BigQuery billing export to be configured before `cost_digest.py` can report real GCP costs; current line is a placeholder.

I surface each human-action moment as a clear "🛑 NEXT: human runs X" callout in commits.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Cost API tokens not provisioned by May 17 | High | Blocks Stage 1 M2 | Pre-list required secrets in Day 1 commit; Ops Lead provisions before Day 3 |
| Conformance scorer needs >1 day calibration | Medium | Delays Stage 1 exit | Buffer day (May 20) reserved for calibration; if needed, exit slips to May 22 |
| npm publish fails on a package due to dep-order edge case | Low | 1-day delay on Sprint 2 | publish.yml already enforces dep-order builds; manual retry path documented in runbook |
| xico-city tests fail against 1.0 packages | Medium | Breaks xico-city Sprint 1 readiness | Run xico-city test suite on May 25 (buffer = 7 days before xico-city Sprint 1) |
| Stage 1 exit slips past May 28 | Medium | Cascades into xico-city Phase C dependency | Sprint 2 has buffer days (May 27–28); if Stage 1 hasn't shipped by May 28, treat as Sprint 2 day-1 priority |

---

## Sign-Off

This plan needs ratification by:

- **Tech Lead** — owns conformance, cost digest, llm-meter, package publishing
- **Ops Lead** — owns secret provisioning, conformance shadow execution, Pushover digest

Once ratified, scope changes require unanimous Lead approval. Same rule as xico-city Phase C v2.

---

**Status:** ✅ Scope A complete (verified 2026-06-01) — Stage 1 closed; the 4 scaffold packages (`realtime`, `validation`, `testing`, `deploy`) bumped to 1.0; STACK auto-update, `platform_conformance.py`, and `cost_digest.py` shipped. Gaps G2/G3/G8/G10 are `closed` in `GAP_REGISTER.md`. Factory is now operating at Stage 2 (see `docs/STATE.md`). Remaining open loose end: G38 (GCP billing BigQuery export still a placeholder).  
**Sprint 1 Starts:** May 15, 2026  
**Stage 1 Exit Target:** May 21, 2026  
**Scope A Complete:** May 28, 2026  
**Downstream Trigger:** xico-city Phase C Sprint 1 (June 1, 2026) — depends on this plan completing
