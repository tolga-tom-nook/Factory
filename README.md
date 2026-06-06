> 📘 **Canonical architecture:** [`docs/architecture/FACTORY_V1.md`](./docs/architecture/FACTORY_V1.md) — the single source of truth for what this system is and how to operate it.
> 🔴 **Operating rules:** [`docs/supervisor/FRIDGE.md`](./docs/supervisor/FRIDGE.md) — non-negotiable; read first.
> 🧭 **Documentation truth map:** [`docs/DOCS_TRUTH_AND_GUARDRAILS.md`](./docs/DOCS_TRUTH_AND_GUARDRAILS.md) — evidence order for current claims and diagrams.
> ⚖️ **Open decisions:** [`docs/supervisor/DECISIONS.md`](./docs/supervisor/DECISIONS.md) — gated `decision:needs-human`; resolve before SUP-3.

# factory

Shared CI/CD, infrastructure, and packages for every app in the **Latimer-Woods-Tech** organization.

If you're an agent or a new contributor, **start here**, then go to:
- [`docs/AGENTS.md`](docs/AGENTS.md) — explicit agent onboarding guide
- [`docs/CI_CD.md`](docs/CI_CD.md) — CI/CD architecture
- [`docs/NEW_APP_CHECKLIST.md`](docs/NEW_APP_CHECKLIST.md) — adding a new app to the ecosystem
- [`docs/runbooks/agent-ship.md`](docs/runbooks/agent-ship.md) — canonical cross-repo agent shipping workflow

---

## What this repo is

factory is the **plumbing layer**. Every app in the org imports from it. It owns:

| Layer | Where | What |
|---|---|---|
| Reusable CI/CD workflows | `.github/workflows/_*.yml` | `_app-ci.yml`, `_app-ci-pnpm.yml`, `_app-deploy.yml`, `_app-deploy-pnpm.yml`, `_post-deploy-verify.yml` |
| Composite skills | `skills/*/` | `skills/global/testing` — vitest + Playwright + axe + CodeQL |
| Shared npm packages | `packages/*` | Local shared package workspaces under `@latimer-woods-tech/*`; registry-backed status lives in `docs/service-registry.yml` |
| Provisioning workflows | `.github/workflows/*` | One-shot scripts for R2, Hyperdrive, secrets, scaffolding |
| Documentation | `docs/*` | Architecture, runbooks, checklists, ADRs |

This repo is **public** so private apps can `uses:` its reusable workflows. It contains zero secrets in code (all secrets live in the GitHub Secrets vault).

---

## Consumers

Factory is consumed by the active app portfolio and by local Factory-owned apps. The current service, Pages, and package contracts live in [`docs/service-registry.yml`](docs/service-registry.yml); use that file instead of this summary for exact names, URLs, and deployment state.

| Repo | Visibility | Status | Notes |
|---|---|---|---|
| [HumanDesign](https://github.com/Latimer-Woods-Tech/HumanDesign) | public | live (selfprime.net) | Stripe wired, 10 prices live |
| [capricast](https://github.com/Latimer-Woods-Tech/capricast) | public | active | formerly documented as VideoKing; bigger CI surface, special handling |
| [ijustus](https://github.com/Latimer-Woods-Tech/ijustus) | public | scaffold | |
| [xpelevator](https://github.com/Latimer-Woods-Tech/xpelevator) | public | scaffold | |
| [wordis-bond](https://github.com/Latimer-Woods-Tech/wordis-bond) | private | scaffold | |
| [cypher-healing](https://github.com/Latimer-Woods-Tech/cypher-healing) | private | scaffold | |
| [the-calling](https://github.com/Latimer-Woods-Tech/the-calling) | private | scaffold | |
| [neighbor-aid](https://github.com/Latimer-Woods-Tech/neighbor-aid) | private | scaffold | |
| [xico-city](https://github.com/Latimer-Woods-Tech/xico-city) | private | scaffold | foundation merged |
| [factory-admin](https://github.com/Latimer-Woods-Tech/factory-admin) | private | active | admin console |

---

## Quick reference for app maintainers

Add CI to a new or existing app — replace the entire `.github/workflows/ci.yml` with:

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  ci:
    uses: Latimer-Woods-Tech/factory/.github/workflows/_app-ci.yml@main
    secrets: inherit
```

Add deploy — replace `.github/workflows/deploy.yml` with:

```yaml
name: deploy
on:
  push: { branches: [main] }
jobs:
  deploy:
    uses: Latimer-Woods-Tech/factory/.github/workflows/_app-deploy.yml@main
    with:
      environment: production
      health_url: https://your-app.example.com/healthz
    secrets: inherit
```

That's it. Inherit conventions, get free CI/CD, stop drifting.

**pnpm apps** (e.g. videoking) — use the pnpm variants instead:

```yaml
# ci.yml
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  ci:
    uses: Latimer-Woods-Tech/factory/.github/workflows/_app-ci-pnpm.yml@main
    secrets: inherit
```

```yaml
# deploy.yml — slim caller with post-deploy verify
name: deploy
on:
  push: { branches: [main] }
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
      health_url: https://your-app.adrper79.workers.dev/health
      rollback_on_failure: true
      worker_name: your-app
    secrets: inherit
```

For deeper reference: [`docs/CI_CD.md`](docs/CI_CD.md).

---

## Conventions

| Thing | Value |
|---|---|
| Node.js version | 24 (`.nvmrc`) |
| Package registry | GitHub Packages (`https://npm.pkg.github.com`) |
| Package scope | `@latimer-woods-tech/*` |
| Default branch | `main` |
| Merge style | Squash only (rulesets enforce) |
| Branch deletion | Auto-delete after merge |
| Secret naming | `SCREAMING_SNAKE_CASE`, scoped at org level when shared |
| Commit messages | Conventional Commits (`feat:`, `fix:`, `chore:`, etc.) |
| Deploy gating | GitHub Environments — `staging`, `production` |
| Auth between repos | GitHub App `factory-cross-repo` (App ID 3560471) |

---

## Repo map

```
factory/
├── .github/
│   └── workflows/
│       ├── _app-ci.yml              ← reusable CI for every app
│       ├── _app-ci-pnpm.yml         ← reusable CI for pnpm-based apps
│       ├── _app-deploy.yml          ← reusable deploy for every app
│       ├── _app-deploy-pnpm.yml     ← reusable deploy for pnpm-based apps
│       ├── _post-deploy-verify.yml  ← reusable health-check + rollback
│       └── *.yml                    ← provisioning + maintenance workflows
├── packages/                        ← shared @latimer-woods-tech/* packages
│   ├── ui/  validation/  monitoring/  seo/  stripe/
│   ├── errors/  deploy/  compliance/  admin/
│   ├── llm/  schedule/  telephony/
├── apps/                            ← apps owned by factory itself (admin, schedule worker, etc.)
├── docs/                            ← architecture, runbooks, ADRs, playbooks
│   ├── CI_CD.md                     ← READ THIS for CI architecture
│   ├── AGENTS.md                    ← READ THIS if you are an agent
│   ├── NEW_APP_CHECKLIST.md         ← READ THIS to add a new app
│   ├── runbooks/                    ← incident response, rotation, etc.
│   ├── operations/                  ← post-org-migration plan, ops state
│   └── archive/                     ← historical phase docs (archived)
└── README.md                        ← you are here
```

---

## Status snapshot

`docs/STATUS.md` is retired as a current-state source. Use `docs/STATE.md` for the generated platform snapshot, `docs/service-registry.yml` for worker/domain truth, and GitHub Actions for live workflow state. If `docs/STATE.md` is stale, fix `generate-state.yml` / `scripts/generate_state.py` rather than hand-editing status tables.

Quick one-liners:
- Org-level Actions secrets: `gh api /orgs/Latimer-Woods-Tech/actions/secrets`
- Reusable workflow live test: see [`docs/CI_CD.md`](docs/CI_CD.md)
- Open PRs across the ecosystem: see `docs/STATE.md` and the GitHub PR list

---

## Ownership

Owner: [@adrper79-dot](https://github.com/adrper79-dot)
Org: [Latimer-Woods-Tech](https://github.com/Latimer-Woods-Tech)
Plan: GitHub Team
