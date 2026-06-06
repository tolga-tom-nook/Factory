# CI/CD Architecture

This document is the canonical reference for how CI/CD works in the Latimer-Woods-Tech org. Every app inherits from this. If you're changing how CI works for a single app, you're probably doing it wrong — change it here.

---

## TL;DR

```
                       ┌──────────────────┐
                       │ Latimer-Woods-Tech│
                       │  (org-level       │
                       │  secrets vault)   │
                       └─────────┬────────┘
                                 │ secrets: inherit
                                 ▼
   ┌──────────────────────────────────────────────────┐
   │  factory (public repo)                           │
   │                                                  │
   │  .github/workflows/                              │
   │    _app-ci.yml             ←── consumed by ──┐   │
   │    _app-deploy.yml         ←── consumed by ──┤   │
   │    _app-deploy-pages.yml   ←── consumed by ──┤   │
   │    _post-deploy-verify.yml ←── consumed by ──┤   │
   └──────────────────────────────────────────────│───┘
                                                  │
              ┌───────────────────────────────────┴───┐
              │                                       │
              ▼                                       ▼
   ┌─────────────────────┐                 ┌─────────────────────┐
   │ Public app repos     │                 │ Private app repos    │
   │ - HumanDesign         │                │ - wordis-bond         │
   │ - videoking           │                │ - cypher-healing      │
   │ - ijustus             │                │ - the-calling         │
   │ - xpelevator          │                │ - neighbor-aid        │
   │                       │                │ - xico-city           │
   │ ci.yml — 5 lines      │                │ - factory-admin       │
   │ deploy.yml — 8 lines  │                │                       │
   └───────────────────────┘                └───────────────────────┘
```

Every app's CI is a thin caller of factory's reusable workflow. **Drift is not allowed** — if you need a different CI shape, propose a change to factory's reusable, don't fork the workflow into your app.

---

## Why factory is public

GitHub Team plan rule: **a private repo's reusable workflows are accessible only to other private repos**. Since 4 of our apps are public (HumanDesign, videoking, ijustus, xpelevator), factory must be public for them to consume reusable workflows. There are no secrets in factory's code — all secrets live in the GitHub Secrets vault. Verified safe.

---

## Skills (composite actions)

Factory publishes reusable composite actions under `skills/` in addition to reusable workflows. Composite actions are referenced at the **step level** (not job level) and are suited for bundling multi-tool testing pipelines.

### `skills/global/testing`

Runs the four standard quality gates in a single step: Vitest, Playwright, axe (via `@axe-core/playwright`), and CodeQL. Full documentation in [`skills/global/testing/README.md`](../skills/global/testing/README.md).

**Caller (unit tests only):**
```yaml
steps:
  - uses: actions/checkout@v4
  - uses: Latimer-Woods-Tech/factory/skills/global/testing@main
    with:
      node_auth_token: ${{ secrets.GITHUB_TOKEN }}
      run_playwright: 'false'
```

**Caller (full suite with CodeQL):**
```yaml
permissions:
  contents: read
  security-events: write   # required for CodeQL
steps:
  - uses: actions/checkout@v4
  - uses: Latimer-Woods-Tech/factory/skills/global/testing@main
    with:
      node_auth_token: ${{ secrets.GITHUB_TOKEN }}
      playwright_base_url: 'https://staging.example.com'
      run_codeql: 'true'
```

---

## The three reusable workflows
## The reusable workflows

### `_app-ci.yml`
Run on every push and PR. Authenticates to GitHub Packages so private `@latimer-woods-tech/*` deps install. Runs `typecheck`, `lint`, `test`, `build` from the app's package.json (skipping any that don't exist). If the repo contains `drizzle.config.*`, CI also fails fast on duplicate migration numbers or broken `meta/_journal.json` / snapshot references before install/build work starts.

**Caller:**
```yaml
jobs:
  ci:
    uses: Latimer-Woods-Tech/factory/.github/workflows/_app-ci.yml@main
    secrets: inherit
```

Full input/secret reference is in the workflow's header comment.

### `_app-deploy.yml`
Targets a GitHub Environment (`staging` or `production`) and deploys to Cloudflare Workers via `wrangler-action@v3`. Optional inline health check.

**Caller:**
```yaml
jobs:
  deploy:
    uses: Latimer-Woods-Tech/factory/.github/workflows/_app-deploy.yml@main
    with:
      environment: production
      health_url: https://app.example.com/healthz
    secrets: inherit
```

### `_app-ci-pnpm.yml`
Identical to `_app-ci.yml` but uses **pnpm** instead of npm. Use this for apps that commit a `pnpm-lock.yaml` (currently: videoking). Enforces `--frozen-lockfile` and applies the same Drizzle migration integrity guard.

**Caller:**
```yaml
jobs:
  ci:
    uses: Latimer-Woods-Tech/factory/.github/workflows/_app-ci-pnpm.yml@main
    secrets: inherit
```

### `_app-deploy-pages.yml`
Deploys a compiled frontend to Cloudflare Pages via `wrangler pages deploy`. Optionally runs a build step first and probes a health URL post-deploy. Use this for apps with a Pages frontend (e.g. HumanDesign / selfprime.net).

**Caller:**
```yaml
jobs:
  deploy-pages:
    uses: Latimer-Woods-Tech/factory/.github/workflows/_app-deploy-pages.yml@main
    with:
      project_name: prime-self-ui
      health_url: https://selfprime.net
    secrets: inherit
```

Full input/secret reference is in the workflow's header comment.

### `_app-deploy-pnpm.yml`
Identical to `_app-deploy.yml` but uses **pnpm** instead of npm. Passes `packageManager: pnpm` to `wrangler-action` so Wrangler resolves scripts through pnpm.

**Caller (with chained post-deploy verify — recommended for production):**
```yaml
jobs:
  deploy:
    uses: Latimer-Woods-Tech/factory/.github/workflows/_app-deploy-pnpm.yml@main
    with:
      environment: production
    secrets: inherit
  verify:
    needs: deploy
    uses: Latimer-Woods-Tech/factory/.github/workflows/_post-deploy-verify.yml@main
    with:
      health_url: https://app.example.com/healthz
      rollback_on_failure: true
      worker_name: app-production
    secrets: inherit
```

### `_post-deploy-verify.yml`
Stronger post-deploy check with retry/backoff plus optional auto-rollback to a captured prior version ID. Use this for production-grade deploys; the inline health check in `_app-deploy.yml` is fine for staging.

**Caller (chained):**
```yaml
jobs:
  deploy:
    uses: Latimer-Woods-Tech/factory/.github/workflows/_app-deploy.yml@main
    secrets: inherit
  verify:
    needs: deploy
    uses: Latimer-Woods-Tech/factory/.github/workflows/_post-deploy-verify.yml@main
    with:
      health_url: https://app.example.com/healthz
      rollback_on_failure: true
      worker_name: app-production
      previous_version_id: ${{ needs.deploy.outputs.previous_version_id }}
    secrets: inherit
```

---

## Authentication chain

How a deploy authenticates, end to end:

1. **App repo's workflow** is triggered by a push.
2. **`secrets: inherit`** passes org-level secrets into factory's reusable workflow.
3. **`actions/create-github-app-token@v3`** mints a short-lived (~1h) GitHub App installation token from `FACTORY_APP_ID` + `FACTORY_APP_PRIVATE_KEY`. This token has scoped access only to the Latimer-Woods-Tech org.
4. **GitHub Packages** uses that token to authenticate `npm ci` for `@latimer-woods-tech/*` deps.
5. **Cloudflare** is authenticated via `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (org-level secrets).

No long-lived PATs in CI. The GitHub App is the source of truth.

### Factory main required checks

The `factory` repo protects `main` with the active repository ruleset named `main`, targeting `~DEFAULT_BRANCH`. It requires pull requests, CODEOWNERS review, stale-review dismissal, review-thread resolution, linear history, blocks branch deletion and non-fast-forward pushes, and requires these merge-gating check contexts:

- `validate`
- `Analyze (javascript)`
- `dependency-review`

Those are the raw GitHub check-run context names. UI labels may display as `CI / validate`, `CodeQL Security Analysis / Analyze (javascript)`, and `Dependency Review / dependency-review`. If you rename or split any of those workflows/jobs, update the repository ruleset and `policy-drift-guard.yml` in the same change. Otherwise you will create either a silent merge blocker or a false policy-drift page.

### Dependency bot ownership

- Renovate owns npm dependency updates in this monorepo.
- Dependabot is scoped to GitHub Actions updates only.

Do not reintroduce overlapping npm bot coverage unless you also change the policy and PR handling rules.

---

## Required secrets (org-level)

These live at https://github.com/organizations/Latimer-Woods-Tech/settings/secrets/actions, visibility `all repositories`:

| Name | Source | Used by |
    ### `_app-ci-pnpm.yml`
    Identical to `_app-ci.yml` but uses **pnpm** instead of npm. Use this for apps that commit a `pnpm-lock.yaml` (currently: videoking). Enforces `--frozen-lockfile` and applies the same Drizzle migration integrity guard.
| `CLOUDFLARE_ACCOUNT_ID` | CF dashboard | Deploy workflows |
| `CF_API_TOKEN` | Legacy alias of above | Deprecated, will be removed |
| `STRIPE_SECRET_KEY` | Stripe dashboard | HumanDesign + payment-touching apps |
| `STRIPE_WEBHOOK_SECRET` | Stripe dashboard | Same |
| `NPM_TOKEN` | npm.com automation token | Future public publishes |
| `SENTRY_DSN_*` | Sentry project DSNs | Per-app observability |
| `HYPERDRIVE_*` | CF Hyperdrive config IDs | Per-app DB connection |
| `POSTHOG_PROJECT_TOKEN` | PostHog | Analytics |

To add a new org secret programmatically: see `docs/runbooks/secret-rotation.md`.

---

## Required repo state

Every consuming app repo must have:

1. **Default branch** named `main`.
2. **Repository ruleset** blocking force-push, deletion, non-linear history (already provisioned by factory's setup workflows).
3. **GitHub Environments** named `staging` and `production`.
   - Public repos: full required-reviewer protection on `production`.
   - Private repos on Team plan: bare environments only (Enterprise needed for required reviewers on private).
4. **CODEOWNERS** at `.github/CODEOWNERS`.
5. **A `package.json` at the working directory** the workflow targets (root by default).

If any of these are missing on a repo, run `factory/.github/workflows/setup-app-secrets.yml` and `scaffold-all-apps.yml` to bring it into compliance.

---


    ### `_app-deploy-pages.yml`
    Deploys a compiled frontend to Cloudflare Pages via `wrangler pages deploy`. Optionally runs a build step first and probes a health URL post-deploy. Use this for apps with a Pages frontend (e.g. HumanDesign / selfprime.net).

    **Caller:**
    ```yaml
    jobs:
      deploy-pages:
        uses: Latimer-Woods-Tech/factory/.github/workflows/_app-deploy-pages.yml@main
        with:
          project_name: prime-self-ui
          health_url: https://selfprime.net
        secrets: inherit
    ```

    Full input/secret reference is in the workflow's header comment.
# expected: {"access_level":"organization"}
```

Quick smoke test:
```yaml
# In any consumer repo, push this to a test branch:
name: smoke
on: { push: { branches: [smoke-test] } }
jobs:
  call:
    uses: Latimer-Woods-Tech/factory/.github/workflows/_app-ci.yml@main
    secrets: inherit
```

If that runs successfully, cross-repo access is healthy.

---

## Environment + ruleset matrix

| Env | Trigger | Reviewer required (public repo) | Reviewer required (private repo, Team) |
|---|---|---|---|
| `staging` | push to `staging/*` or `dev` branches | no | no |
| `production` | push to `main` | yes | no (bare env only) |

To upgrade private repos to required-reviewer protection on production, the org needs to be on GitHub Enterprise.

---

## Adding a new app

See [`NEW_APP_CHECKLIST.md`](NEW_APP_CHECKLIST.md).

---

## Adding a new reusable workflow

1. Create `factory/.github/workflows/_my-thing.yml`.
2. Top of file must be a header comment matching the format in the existing three (purpose, inputs, secrets, conventions, related workflows).
3. Test the workflow with a smoke caller in any private app repo before merging.
4. Update this doc + `README.md`'s repo map.
5. Open a PR.

The underscore prefix (`_*.yml`) is convention for "consumed-by-other-workflows-only, never run directly."

---

## Rollback playbook

If a deploy goes wrong:

1. **Automatic** — if the deploy workflow chained `_post-deploy-verify.yml` with `rollback_on_failure: true`, it already rolled back. Check the run logs.
2. **Manual** — `wrangler versions list --name <worker>` to see versions, then `wrangler versions rollback --name <worker> --version-id <id>`.
3. **Nuclear** — `git revert` the offending commit on `main`, push, let the deploy workflow run forward to the previous good state.

For DB-touching changes, see `docs/runbooks/incident-response.md`.

---

## Drift watch

The `factory-status-dashboard.yml` cron job checks every consumer repo's CI is using the reusable. Any inline CI gets flagged in `docs/STATE.md` and should be migrated.

---

## Anti-patterns (don't do these)

- ❌ Forking factory's reusable workflow into an app and editing it locally
- ❌ Adding `secrets:` to a caller and hardcoding values; always use `secrets: inherit`
- ❌ Hardcoding secret names in app code; reference org secrets by name only
- ❌ Using long-lived PATs in CI; use the GitHub App
- ❌ Skipping `_post-deploy-verify.yml` for production deploys with money or user data
- ❌ Pushing to `main` without going through CI; rulesets should prevent this anyway
- ❌ Adding workflow files to factory that aren't documented in this file or `README.md`
- ❌ Building and deploying Cloudflare Pages with custom inline YAML instead of `_app-deploy-pages.yml`

---

## Autonomous PR Review Pipeline

> Added May 2026. This section documents the LLM-gated auto-merge system. Read alongside `docs/supervisor/ARCHITECTURE.md`.

### Overview

All non-infrastructure PRs opened by the `factory-cross-repo` bot go through a fully autonomous review-and-merge pipeline. No human is required for green-tier (docs/markdown) or yellow-tier (app source) PRs unless the retry limit is hit.

```
PR opened/synchronize
  └─► pr-review.yml (.github/workflows/pr-review.yml)
        ├─ Tier classification (red / yellow / green)
        ├─ Red tier → request human review immediately, stop
        └─ Green/Yellow tier:
              pr-review.mjs (.github/scripts/pr-review.mjs)
                1. Grok first-pass
                2. Claude second-pass
                Both LGTM → APPROVE + merge
                Either fails → CHANGES_REQUESTED (merged concerns)
                             → supervisor feedback loop fixes & re-triggers

supervisor-loop.yml (cron: every 4 hours + workflow_dispatch)
  └─► supervisor-core.mjs (.github/scripts/supervisor-core.mjs)
        1. runPrFeedbackLoop()  ← scans CHANGES_REQUESTED bot PRs, self-heals
        2. processIssues()      ← issue → analysis → scaffold → PR flow
```

### Tier Classification

| Tier | Paths | Review model |
|------|-------|--------------|
| **Green** | `docs/**`, `*.md`, `session/**`, `.github/ISSUE_TEMPLATE/**`, `.github/PULL_REQUEST_TEMPLATE.md` | LLM consensus only; auto-merge on 2/2 approve |
| **Yellow** | `apps/*/src/**`, `client/**`, `tests/**` | LLM consensus only; auto-merge on 2/2 approve |
| **Red** | `packages/**`, `.github/workflows/**`, `wrangler.jsonc`, `migrations/**`, `scripts/**`, `skills/**` | Human review required; bot posts immediate notification |

### Reviewer-Class Hints

In addition to tier-based review, the bot detects which **sensitive path classes** a PR touches and auto-requests the relevant reviewers via GitHub review requests. This fires for all tiers, not just red.

| Class | Label | Default paths matched |
|-------|-------|----------------------|
| `platform` | 🔧 Platform (CI/CD & shared packages) | `.github/workflows/**`, `.github/scripts/**`, `packages/**`, `scripts/**`, `skills/**` |
| `security` | 🔒 Security (auth, admin & billing paths) | `handlers/(billing\|admin\|stripe)`, `/admin/`, `stripe*`, `capabilities.yml`, `docs/supervisor/plans/**`, `apps/supervisor/**` |
| `database` | 🗄️ Database (migrations & schema) | `migrations/**`, `*/src/db/**`, `drizzle.config*` |
| `config` | ⚙️ Config (wrangler & service registry) | `wrangler.jsonc`, `wrangler.toml`, `docs/service-registry.yml` |
| `governance` | 📋 Governance (CODEOWNERS & settings) | `.github/CODEOWNERS`, `.github/settings.yml` |

When a reviewer class fires, the bot:
1. Sends a GitHub review request to the listed reviewers (GitHub notification)
2. Adds a **Reviewer Hints** table to the review body showing which classes matched and which files triggered them

**Customising the reviewer map:** Set repo variable `REVIEWER_HINTS_MAP` to a JSON array to override or extend the built-in map. Each entry must have:
```json
[
  {
    "class": "platform",
    "label": "🔧 Platform",
    "patterns": ["^\\.github/workflows/"],
    "reviewers": ["my-platform-handle"]
  }
]
```
Entries with a matching `class` key replace the built-in entry; new class keys are appended.

### Required Secrets

| Secret | Purpose |
|--------|---------|
| `ANTHROPIC_API_KEY` | Claude second-pass review |
| `GROK_API_KEY` | Grok first-pass review |
| `GH_APP_ID` | factory-cross-repo GitHub App identity |
| `GH_APP_PRIVATE_KEY` | factory-cross-repo auth |

### Configuration Variables

| Variable | Purpose |
|----------|---------|
| `MAX_REVIEW_ATTEMPTS` | Retry limit before escalation (default `3`) |
| `HUMAN_REVIEWER` | GitHub handle to notify on escalation (default `adrper79-dot`) |
| `REVIEWER_HINTS_MAP` | Optional JSON array to override the reviewer-class map |

### Escalation

After `MAX_REVIEW_ATTEMPTS` failed reviews on a single PR:
1. Label PR `supervisor:review-limit-reached`
2. File a GitHub issue describing the stall
3. Post a comment on the PR linking the issue
4. Request review from `HUMAN_REVIEWER` (GitHub notification)

### Hallucination Guards

Before the supervisor commits any LLM fix, three guards run:

1. **`checkGeneratedContent()`** — strips comments/strings then checks for constraint violations (`process.env`, `require`, `Buffer`, Node built-ins, Express/jwt); flags near-empty files and files exceeding `MAX_GENERATED_LINES` (default 800, configurable).
2. **`enforceSlotSchema()`** — strips hallucinated slot keys not in the template schema; nulls values matching a structured prompt-injection pattern.
3. **`fixAddressesConcerns()`** — verifies at least one concern keyword appears in added or removed lines of the diff.

---

## Docs Quality Gate

`scripts/validate-docs-quality.mjs` enforces internal-link integrity across all Markdown files in `docs/`, `apps/*/README.md`, and root `*.md`.

### Running locally

```bash
node scripts/validate-docs-quality.mjs                  # default (max 50 errors)
node scripts/validate-docs-quality.mjs --max-errors 0   # full list
node scripts/validate-docs-quality.mjs --json           # + writes docs-quality-report.json
```

Exit code `0` = clean. Exit code `1` = broken links found.

### What it checks

| Check | Notes |
|---|---|
| Relative `.md` / `.mdx` link targets exist on disk | Skips `http://`, `https://`, `mailto:`, and same-page `#anchor` links |
| `#anchor` fragments resolve to a heading or `id=` attribute | Heading slugs follow GFM algorithm |

### Design constraints

- Never follows symlinks / junction points (prevents infinite traversal loops)
- Bounded scan: `docs/**`, `apps/*/README.md`, root `*.md` — skips `node_modules`, `dist`, `.wrangler`
- Completes under 10 s on this repo
- `--max-errors N` (default 50) keeps CI output actionable

### Adding to a CI job

```yaml
- name: Docs quality gate
  run: node scripts/validate-docs-quality.mjs --max-errors 50
```

