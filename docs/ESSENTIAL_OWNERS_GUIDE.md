# Factory Essential Owner's Guide

**Date:** 2026-04-29  
**Audience:** Founder, owner-operator, technical lead, delegated operator  
**Purpose:** Explain how Factory actually works today, where the control plane lives, what is verified vs merely configured, how GitHub and AI fit in, and how to safely add custom domains.

---

## 1. What Factory Is

Factory is currently three things at once:

1. A **shared infrastructure monorepo** for Workers, Pages apps, packages, docs, and automation.
2. A **browser control plane** called Admin Studio, split into:
   - a Worker API in `apps/admin-studio`
   - a Pages UI in `apps/admin-studio-ui`
3. A set of **application baselines and reference implementations**, including VideoKing/NicheStream patterns that are partly local to this repo and partly represented by external-review code.

The most important practical distinction is this:

- **Code/configured** does not automatically mean **live/verified**.
- The canonical rule is in `CLAUDE.md`: do not call anything working until a direct `curl` check returns the expected status.

---

## 2. Canonical Sources of Truth

When you need to understand the current system, use these in order:

1. `CLAUDE.md`
2. `WORLD_CLASS_IMPLEMENTATION_DASHBOARD.md`
3. `docs/service-registry.yml`
4. `docs/ACCESS.md`
5. `docs/admin-studio/00-MASTER-PLAN.md`
6. `docs/admin-studio/02-OPERATOR-QUICK-REF.md`
7. `apps/admin-studio/README.md`
8. `apps/admin-studio-ui/README.md`

Use the service registry for naming, URLs, dependencies, and verification state. Use the dashboard for open work and current execution reality. Use the admin-studio docs for operator behavior and safety rules.

---

## 3. Lessons To Retain

These are the lessons worth preserving because they affect how you run Factory, not just how you code in it.

### 3.1 Configured is not verified

- `docs/service-registry.yml` already marks some surfaces as `configured_not_live_verified`.
- Example: Admin Studio production Worker is configured but was still returning `404` on `/health` during direct verification.
- Rule: do not update docs/status to “live” until the actual endpoint returns `200`.

### 3.2 Domain changes are multi-surface changes

Adding or changing a custom domain is never a one-line update.

At minimum you must consider:

- Cloudflare Pages or Workers route/domain configuration
- CORS allow-lists (`ALLOWED_ORIGINS`)
- workflow verification URLs
- docs/service-registry.yml
- operator quick refs and README docs

If the UI origin changes and the API allow-list does not, the page will load and then fail on API calls.

### 3.3 Admin Studio has dual registries

There are two separate but related sources of app/domain truth:

- `docs/service-registry.yml` — documentation and operational registry
- `apps/admin-studio/src/lib/app-registry.ts` — Worker runtime registry for health/manifest URLs

If you add an app or custom production domain and only update one, the system will drift.

### 3.4 Lockfiles matter in CI more than local success

Recent CI failures showed that moving dependencies in `package.json` without synchronizing `package-lock.json` will break `npm ci`, even if local code appears healthy after `npm install`.

Operational lesson:

- package edits require lockfile edits
- the correct validation is `npm ci`, not only `npm install`

### 3.5 VideoKing is split between pattern docs and external app code

In this repo:

- `apps/videoking` is currently documentation/baseline oriented
- `_external_reviews/videoking` contains a fuller app codebase, including a frontend (`apps/web`) and Worker (`apps/worker`)

If you want to change the live-like VideoKing/NicheStream frontend behavior or domains, the external review app is the concrete implementation surface to inspect first.

### 3.6 GitHub is already central to operations

Factory is already heavily GitHub-mediated:

- CI/CD workflows
- Pages deployment
- test dispatch
- repo browsing/editing in Admin Studio
- PR creation
- package publishing and release flow

The next step is not “start using GitHub”; it is “deepen and harden the integration surface.”

---

## 4. Where The Operator Surfaces Are

Use `docs/ACCESS.md` as the canonical human-facing access map. It records the live URL, staging URL, login policy, code path, and first diagnostic action for each surface.

### Admin Studio / AP Unlimited

Admin Studio UI is the Cloudflare Pages frontend in `apps/admin-studio-ui`. The paired API Worker is in `apps/admin-studio`.

Current operator URLs:

- **Production UI:** `https://apunlimited.com`
- **Staging UI:** `https://staging.admin.latimerwoods.dev`
- **Production API:** `https://api.apunlimited.com`
- **Staging API:** `https://api.admin.latimerwoods.dev`

Login policy:

- Google Sign-In with an allowlisted `latwoodtech.com` account.
- Break-glass email/password login using the same credential policy.

The UI routing is simple:

- unauthenticated users go to `/login`
- authenticated users go to the dashboard shell

### QA Tools

QA Tools UI is the Cloudflare Pages frontend in `apps/qa-tools-ui`. The paired API Worker is in `apps/qa-tools-worker`.

Current operator URLs:

- **Production UI:** `https://qa.latimerwoods.dev`
- **Staging UI:** `https://staging.qa.latimerwoods.dev`
- **API:** `https://api.qa.latimerwoods.dev`

Login policy:

- Same as Admin Studio / AP Unlimited.
- Google Sign-In with an allowlisted `latwoodtech.com` account.
- Break-glass email/password login using the same credential policy.

Important: user-facing access should use branded domains. Raw `pages.dev` and `workers.dev` URLs are deployment details, not operator entry points.

---

## 5. How AI Queries Work From The Admin Panel

The AI experience already exists in Admin Studio.

### UI flow

The AI tab is in `apps/admin-studio-ui/src/pages/tabs/AiTab.tsx`.

It supports:

- **Chat** via `POST /ai/chat`
- **File proposals** via `POST /ai/proposals`

The tab sends:

- the current mode (`generate`, `explain`, `refactor`)
- conversation history
- the open file path/snippet from the Code tab when available

### Worker flow

The backend route is in `apps/admin-studio/src/routes/ai.ts`.

Current behavior:

- `/ai/chat` streams SSE token events back to the browser
- system prompts encode Factory rules (Workers, Hono, Drizzle, Web Crypto, no `process.env`)
- `/ai/proposals` builds a structured full-file rewrite proposal

### Providers

The route currently uses:

- Anthropic as the primary provider
- Grok / Groq as configured fallback inputs for proposal completion via `@latimer-woods-tech/llm`

### Required bindings/secrets

For AI to work from Admin Studio, the Worker must have:

- `ANTHROPIC_API_KEY`
- optionally `XAI_API_KEY`
- optionally `GROQ_API_KEY`

### What this means operationally

Today, Admin Studio AI is best understood as:

- **good for guided code generation/explanation/refactors inside the Factory repo**
- **not yet a full agentic operations console**

It does not currently replace broader repo automation, issue triage, multi-repo orchestration, or infrastructure mutation governance by itself.

---

## 6. Are We As Integrated With GitHub As We Should Be?

### What already exists

Admin Studio already has meaningful GitHub integration in the Worker.

Implemented in `apps/admin-studio/src/lib/github-api.ts` and `apps/admin-studio/src/routes/repo.ts`:

- list branches
- fetch repo tree
- fetch single-file content
- create branch
- commit a single file
- open a pull request

The Worker also dispatches GitHub-driven workflows and relies on GitHub Actions for deploy/test orchestration.

### What is good

This is already enough to support a browser-based code/control workflow:

- inspect repo
- edit file
- commit to branch
- open PR
- run CI/CD around it

That is stronger than a simple dashboard.

### What is still missing

No, Factory is not yet as integrated with GitHub as it could be.

The biggest missing pieces are:

1. **Multi-repo awareness**
   - current repo API client is hard-coded to `Latimer-Woods-Tech/factory`
   - Factory operations span multiple repos and Pages/Workers surfaces

2. **PR review workflow**
   - no integrated review comments, approvals, requested changes, or merge readiness view in Admin Studio

3. **Checks and workflow controls**
   - no first-class rerun/cancel/retry UI for failed GitHub Actions jobs
   - no job-log drilldown comparable to Actions UI

4. **GitHub issues and owner operations**
   - no issue queue, release issue generation, or cross-linking from incidents to issues

5. **Secrets and variables management**
   - GitHub Secrets are operationally central, but Admin Studio does not yet manage or audit them directly

6. **Release management**
   - package tag/release train flow exists in the repo, but not as a polished control-plane workflow

7. **GitHub App posture**
   - the current pattern is PAT-based (`GITHUB_TOKEN` binding), which works but is not the strongest long-term model for fine-grained, auditable, multi-repo ownership controls

### What we should do next

If you want Admin Studio to become the real owner console, the next GitHub features to add are:

1. Multi-repo registry support
2. PR review + checks panel
3. workflow rerun/cancel/log streaming
4. issue/incident linking
5. release/tag orchestration
6. secrets/variables inventory and audit visibility
7. eventual migration from PAT-centric control to a GitHub App model

---

## 7. How To Maintain `apunlimited.com` For The Admin Page

`apunlimited.com` is the production Admin Studio UI domain. Treat it as the canonical operator entry point, not an alias.

### Current relevant surfaces

- UI project: `apps/admin-studio-ui`
- current production UI domain: `apunlimited.com`
- current production API domain: `https://api.apunlimited.com`
- current staging UI domain: `https://staging.admin.latimerwoods.dev`
- current staging API domain: `https://api.admin.latimerwoods.dev`
- Worker CORS allow-list: `apps/admin-studio/wrangler.jsonc`
- workflow verification target: `.github/workflows/deploy-admin-studio-ui.yml`
- Pages registry entry: `docs/service-registry.yml`

### What must be done

1. **Keep the Pages custom domain attached in Cloudflare Pages**
   - project: `admin-studio-ui`
   - domain: `apunlimited.com`

2. **Update API CORS allow-lists**
   - production `ALLOWED_ORIGINS` must include `https://apunlimited.com`
   - staging `ALLOWED_ORIGINS` must include `https://staging.admin.latimerwoods.dev`

3. **Keep verification on branded domains**
   - UI deploy verification should use `https://apunlimited.com` for production and `https://staging.admin.latimerwoods.dev` for staging.
   - API deploy verification should use `https://api.apunlimited.com` for production and `https://api.admin.latimerwoods.dev` for staging.

4. **Update operator docs**
   - `docs/ACCESS.md`
   - `docs/service-registry.yml`
   - `apps/admin-studio-ui/README.md`
   - `docs/admin-studio/02-OPERATOR-QUICK-REF.md`

5. **Verify directly**
   - `curl https://apunlimited.com/` must return `200`
   - the response body should contain `Factory Admin Studio`
   - `curl https://api.apunlimited.com/health` must return `200`

### Important caution

Do not point operators at `pages.dev` or `workers.dev` URLs. They are deployment fallbacks and implementation details.

---

## 8. How To Add `capricast.com` To The VideoKing / NicheStream Frontend

This should be treated as a **different surface** from the pattern-only `apps/videoking` docs in this repo.

The concrete frontend implementation currently visible in the workspace is:

- `_external_reviews/videoking/apps/web/wrangler.toml`

Current frontend config there uses:

- `NEXT_PUBLIC_APP_URL = "https://capricast.com"`
- `NEXT_PUBLIC_API_BASE_URL = "https://api.capricast.com"`
- `NEXT_PUBLIC_ASSET_BASE_URL = "https://assets.capricast.com"`

The paired Worker config currently uses:

- `_external_reviews/videoking/apps/worker/wrangler.toml`
- route pattern: `api.capricast.com/*`

### Two possible domain strategies

#### Strategy A — frontend alias only

Use `capricast.com` as an additional frontend domain, but keep the backend/API on `api.capricast.com`.

This is the smallest change.

What to do:

1. Add `capricast.com` as a Cloudflare Pages custom domain for the web app.
2. Keep `NEXT_PUBLIC_API_BASE_URL` pointing to `https://api.capricast.com` unless you also want an API domain change.
3. Update `NEXT_PUBLIC_APP_URL` if the product should generate canonical links using `capricast.com`.
4. Verify `curl https://capricast.com/` returns `200`.

#### Strategy B — full white-label domain set

Use:

- `capricast.com` for frontend
- `api.capricast.com` for API
- potentially `assets.capricast.com` for assets

What to do:

1. Add Pages custom domain for the frontend.
2. Add Worker route(s) in `_external_reviews/videoking/apps/worker/wrangler.toml`.
3. Update app vars in `_external_reviews/videoking/apps/web/wrangler.toml`.
4. Update worker-side platform config and asset base references if those should be brand-specific.
5. Verify frontend, API, and assets individually.

### Recommendation

Start with **Strategy A** unless you explicitly need a full brand-isolated API surface.

It is much cheaper operationally and avoids unnecessary domain sprawl.

---

## 9. Owner Runbook: How Factory Works Day To Day

### Morning checks

1. Read the current execution state in `WORLD_CLASS_IMPLEMENTATION_DASHBOARD.md`.
2. Check `docs/service-registry.yml` for what is truly live vs merely configured.
3. Check GitHub Actions for failed runs.
4. Check Admin Studio staging first, not production assumptions.

### Before changing any domain, route, or worker name

1. Update consumers first.
2. Update service-registry.
3. Update runtime registries and allow-lists.
4. Deploy.
5. `curl` verify.
6. Only then update status docs.

### Before calling something “done”

1. Typecheck
2. Lint
3. Test
4. Build
5. `curl` the live endpoint if deployment is involved

### If CI fails

Use this order:

1. read the exact failing log
2. reproduce locally in the package/app that failed
3. fix root cause, not symptoms
4. rerun the narrowest validation first
5. push only focused changes

### If you are using Admin Studio to mutate code or deploy

Remember:

- it is an interface layer, not a replacement for verification discipline
- GitHub is still the source of execution truth
- Cloudflare is still the source of runtime truth
- Neon is still the source of data truth

Admin Studio should reduce friction, not lower standards.

---

## 10. Recommended Next Owner Moves

If the goal is to make Factory materially easier to own and operate, the next highest-value moves are:

1. Keep `docs/ACCESS.md` and `docs/service-registry.yml` aligned whenever a URL or credential policy changes.
2. Extend Admin Studio from single-repo GitHub support to multi-repo support.
3. Add GitHub workflow log/retry/check-run visibility inside the UI.
4. Expand `docs/service-registry.yml` and `app-registry.ts` to support domain aliases explicitly.
5. Decide whether VideoKing/NicheStream is remaining a reference source in this repo or graduating to a first-class live app surface with one canonical codebase.
6. Add a dedicated owner dashboard/manual link from `START_HERE.md` and `MASTER_INDEX.md`.

---

## 11. Essential File Map

- `CLAUDE.md` — non-negotiable standing orders
- `WORLD_CLASS_IMPLEMENTATION_DASHBOARD.md` — execution truth
- `docs/service-registry.yml` — live/configured endpoint truth
- `apps/admin-studio/README.md` — API worker operational overview
- `apps/admin-studio-ui/README.md` — UI deployment overview
- `apps/admin-studio/src/lib/app-registry.ts` — runtime app registry
- `apps/admin-studio/src/lib/github-api.ts` — GitHub integration surface
- `apps/admin-studio/src/routes/repo.ts` — browser repo operations
- `apps/admin-studio/src/routes/ai.ts` — AI chat/proposal operations
- `_external_reviews/videoking/apps/web/wrangler.toml` — NicheStream frontend domain/base URL config
- `_external_reviews/videoking/apps/worker/wrangler.toml` — NicheStream API route/domain config

---

This guide should be updated whenever the control plane, registry model, or deployment topology changes.
