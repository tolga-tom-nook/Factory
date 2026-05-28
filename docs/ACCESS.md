---
date: 2026-05-28
status: operator-access-map
companion-to: docs/architecture/SURFACES.md, docs/service-registry.yml
---

# Factory Access Map

This is the human-facing map for finding Factory surfaces, logging in, and knowing what each one is for. Canonical service metadata still lives in `docs/service-registry.yml`.

## Credential Policy

Admin Studio / AP Unlimited and QA Tools use the same operator credential policy:

- Primary login is Google Sign-In for the `latwoodtech.com` Workspace domain.
- Access is additionally constrained by the configured allowlist secret.
- Break-glass email/password login exists for continuity and is provisioned through GitHub Actions secrets.
- User-facing access should use branded domains. Raw `pages.dev` and `workers.dev` URLs are implementation details only.

## Operator Surfaces

| Surface | Production | Staging | How to log in | What to do first |
| --- | --- | --- | --- | --- |
| Admin Studio / AP Unlimited | `https://apunlimited.com` | `https://staging.admin.latimerwoods.dev` | Google Sign-In with an allowlisted `latwoodtech.com` account, or break-glass credentials | Open the dashboard and check runs, gates, digest, and admin workflows. |
| Admin Studio API | `https://api.apunlimited.com` | `https://api.admin.latimerwoods.dev` | Browser UI obtains the token; direct calls use the same operator JWT | Check `/health` before debugging UI behavior. |
| QA Tools | `https://qa.latimerwoods.dev` | `https://staging.qa.latimerwoods.dev` | Same policy as Admin Studio / AP Unlimited | Review recent QA runs, replay browser-agent context, and inspect failure artifacts. |
| QA Tools API | `https://api.qa.latimerwoods.dev` | `https://api.qa.latimerwoods.dev` | Browser UI obtains the token; direct calls use the same QA JWT | Check `/health` and `/auth/config` before debugging login. |
| Developer Index | `https://dev.latimerwoods.dev` | none | Public/internal reference surface | Use it as a quick launchpad for platform links. |
| Status | `https://latwoodtech.com/status/` | none | Public status page | Confirm public availability before deeper incident triage. |
| Factory Core API | `https://core.latwoodtech.work` | same branded host for active runtime | GitHub OIDC exchange for workflow clients; service secrets for trusted Workers | Use `/health` for liveness and `/v1/auth/token` for workflow token exchange. |
| Webhook Fanout | `https://webhooks.latwoodtech.work/stripe` | none | Vendor HMAC signatures and service secrets | Check recent Stripe/PostHog/Resend fanout behavior from provider dashboards and logs. |

## Local Code Paths

| Surface | UI code | API/Worker code | Primary deploy workflow |
| --- | --- | --- | --- |
| Admin Studio / AP Unlimited | `apps/admin-studio-ui` | `apps/admin-studio` | `.github/workflows/deploy-admin-studio-ui.yml`, `.github/workflows/deploy-admin-studio-worker.yml` |
| QA Tools | `apps/qa-tools-ui` | `apps/qa-tools-worker` | `.github/workflows/deploy-qa-tools-ui.yml`, `.github/workflows/deploy-qa-tools-worker.yml` |
| Factory Core API | none | `apps/factory-core-api` | `.github/workflows/deploy-factory-core-api.yml` |
| Webhook Fanout | none | `apps/webhook-fanout` | `.github/workflows/deploy-webhook-fanout.yml` |
| Developer Index | static | `apps/developer-index` | `.github/workflows/deploy-developer-index.yml` |
| Status | static | `apps/status-page` | `.github/workflows/deploy-status-page.yml` |

## Quick Health Checks

```bash
curl -fsS https://api.apunlimited.com/health
curl -fsS https://api.admin.latimerwoods.dev/health
curl -fsS https://api.qa.latimerwoods.dev/health
curl -fsS https://core.latwoodtech.work/health
```

If login fails, check `/auth/config` on the matching API host first. If the branded staging URL does not resolve, run the Cloudflare domain reconcile workflow before treating it as an application bug.
