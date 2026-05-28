---
title: QA Tools Platform — Production Architecture
date: 2026-05-27
version: 2.0
status: approved-for-implementation
companion-to: docs/architecture/SURFACES.md, docs/architecture/ADMIN_TECHNICAL_GUIDE.md
applies-to: selfprime.net, capricast.com, cipherofhealing.com, xicocity.com
---

# QA Tools Platform — Mature Design (v2.0)

> **What this is:** A production-grade QA testing platform (browser automation + accessibility + performance auditing) designed for cross-app deployment at Factory scale. Covers architecture, data models, API contracts, UI/UX, security, phases, and operational concerns.
>
> **What this is NOT:** A quick integration into existing admin UI. This is a standalone, extensible system with its own surface, data layer, and user personas.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture](#2-system-architecture)
   - 2.1 High-Level Data Flow
   - 2.2 Component Ownership
   - 2.3 Auth & RBAC Model
   - 2.4 Audit Profiles
3. [Data Models](#3-data-models)
4. [API Contract](#4-api-contract)
5. [UI/UX Design](#5-uiux-design)
6. [Security & Compliance](#6-security--compliance)
7. [Integrations](#7-integrations)
8. [Implementation Phases](#8-implementation-phases)
9. [Deployment & Operations](#9-deployment--operations)
10. [Scalability & Performance](#10-scalability--performance)
11. [Success Metrics](#11-success-metrics)
- [Appendix A: API Request Examples](#appendix-a-api-request-examples)
- [Appendix B: Lighthouse Configuration](#appendix-b-lighthouse-audit-configuration)
- [Appendix C: Test User Rotation Policy](#appendix-c-test-user-rotation-policy)
- [Appendix D: CI/CD GitHub Actions Integration](#appendix-d-cicd-github-actions-integration)
- [Appendix E: Normalized Finding Type](#appendix-e-normalized-finding-type)

---

## 1. Executive Summary

### Problem
Today, testing a Factory app requires:
- Manually running Playwright tests locally
- Opening DevTools to inspect console errors
- Visiting Sentry for error reports (lag, no real-time replay)
- No accessibility audit before shipping
- No performance baseline to catch regressions
- No credential management for test users
- No shared audit history across apps

### Solution
**QA Tools Platform** — unified dashboard for:
- One-click accessibility audits (WCAG 2 AA + axe-core)
- Screenshot + visual regression detection
- Multi-step scenario automation (login, form flows)
- Performance metrics (Lighthouse, Core Web Vitals)
- Form validation testing
- Credential-secured testing of protected pages
- Audit profiles: fast (CI), full (release), and custom
- Real-time results + 90-day history
- Regression alerts and trend analytics
- GitHub issue creation from findings
- Slack/email reporting with configurable notification prefs

### Scale
- **Apps:** selfprime.net, capricast.com, cipherofhealing.com, xicocity.com (+ future)
- **Users:** QA engineers, developers, product managers (RBAC enforced)
- **Frequency:** On-demand + scheduled (daily/weekly) + CI-triggered (on PR)
- **SLA:** 99.5% uptime (non-critical path), < 2 min per full audit, < 15s for fast/CI profile

### Tech Stack
- **Backend:** Cloudflare Worker (Hono) + browser-agent Cloud Run service
- **Database:** Neon Postgres (factory-core project)
- **Storage:** R2 (screenshots, videos, JSON exports)
- **Frontend:** Next.js app on Cloudflare Pages
- **Auth:** JWT (factory-auth pattern) with app_id + role claims
- **Monitoring:** Sentry + PostHog

---

## 2. System Architecture

### 2.1 High-Level Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                         QA Tools Dashboard                          │
│               (Next.js app on Cloudflare Pages)                     │
│  - Select app + environment + profile + test type                   │
│  - Configure credentials + custom assertions + thresholds           │
│  - View results, diffs, remediation hints, trends                   │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ POST /runs (JSON)
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│              QA Tools Worker (Hono on CF Workers)                     │
│  - Validate JWT + authorize (check role claim)                       │
│  - Enforce rate limit (per-app, per-user)                            │
│  - Decrypt credentials from Neon                                     │
│  - Resolve profile → checks, timeout, retry policy                  │
│  - Dispatch to browser-agent (Cloud Run)                             │
│  - Poll + retry on transient failure (circuit breaker)              │
│  - Store metadata in Neon, upload artifacts to R2                   │
│  - Write factory_audit_log on every credential read                 │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ POST /scrape, /screenshot, /audit, /visual-review
                                ▼
                    ┌────────────────────────────┐
                    │   browser-agent            │
                    │  (Cloud Run, Playwright)   │
                    │ - Headless Chrome          │
                    │ - axe-core                 │
                    │ - Lighthouse               │
                    │ - pixelmatch / pHash       │
                    │ - Video capture (MP4)      │
                    └────────────────────────────┘
                                │
                    ┌───────────┴────────────┐
                    ▼                        ▼
         ┌──────────────────┐    ┌───────────────────────┐
         │  Cloudflare R2   │    │  Neon Postgres         │
         │  Screenshots     │    │  qa_tools_runs         │
         │  Videos          │    │  qa_tools_results      │
         │  JSON exports    │    │  qa_tools_credentials  │
         │  Diff images     │    │  qa_tools_comparisons  │
         └──────────────────┘    │  qa_tools_templates    │
                                 │  qa_tools_notif_prefs  │
                                 └───────────────────────┘

Downstream integrations:
  GitHub  → Issue creation, PR comments, status checks
  Slack   → Channel notifications, daily digests
  Sentry  → Error linkage, issue clustering
  PostHog → qa_audit_run events, trends dashboard
```

### 2.2 Component Ownership

| Component | Tech | Purpose |
|-----------|------|---------|
| **QA Dashboard** | Next.js 15 + React 19 | UI for all QA operations |
| **QA Worker** | Hono on CF Workers | API, orchestration, auth, rate limiting |
| **browser-agent** | Cloud Run + Playwright | Headless browser + automation engine |
| **Neon tables** | PostgreSQL | Audit trail, credentials, history, templates |
| **R2 bucket** | Cloudflare R2 | Screenshots, videos, JSON result exports |

### 2.3 Auth & RBAC Model

**JWT Claims (factory-auth pattern, extended):**
```json
{
  "sub": "user-uuid",
  "email": "dev@latwoodtech.com",
  "role": "qa_runner",
  "app_ids": ["capricast", "selfprime"],
  "exp": 1748390400
}
```

**Roles:**

| Role | Can view results | Can run audits | Can manage credentials | Can manage schedules | Can delete history |
|------|-----------------|---------------|----------------------|---------------------|-------------------|
| `qa_viewer` | ✅ (own app_ids only) | ❌ | ❌ | ❌ | ❌ |
| `qa_runner` | ✅ (own app_ids only) | ✅ (own app_ids only) | ❌ | ❌ | ❌ |
| `qa_admin` | ✅ (all apps) | ✅ (all apps) | ✅ | ✅ | ✅ |

**Enforcement:**
- Worker validates `role` claim on every request
- `app_ids` claim is checked per-operation: `POST /runs` with `appId=capricast` requires `capricast` in `app_ids` or `qa_admin` role
- Credentials are doubly scoped: JWT `app_ids` + `qa_tools_credentials.app_id` must match
- The `qa_admin` role is not self-grantable; requires manual key issuance (Adrian only for now)

**CI/CD Integration (non-user JWT):**
- GitHub Actions calls QA Worker with a service-account JWT (`aud: "qa-tools-ci"`, no `app_ids` restriction, `role: "qa_runner"`)
- Service JWT signed from `QA_TOOLS_CI_SECRET` in GCP Secret Manager
- No credential decryption allowed from CI context (avoids secrets in GHA logs)

### 2.4 Audit Profiles

Profiles are named presets that set checks, timeout, retry policy, and thresholds. Users can select a profile or override individual settings.

| Profile | Checks | Timeout | Retries | Est. Duration | Use Case |
|---------|--------|---------|---------|---------------|----------|
| `fast` | screenshots, axe (critical only) | 15s | 1 | ~10s | CI on every PR, quick sanity |
| `a11y` | axe (WCAG 2 AA full) | 30s | 2 | ~20s | Pre-deploy accessibility gate |
| `performance` | lighthouse, screenshots | 45s | 1 | ~25s | Performance regression gate |
| `full` | axe + lighthouse + screenshots + network | 90s | 2 | ~45s | Nightly scheduled, release gates |
| `scenario` | screenshots + axe + multi-step scenario | 120s | 2 | ~60s | Login flow, authenticated pages |
| `custom` | caller-defined | caller-defined | caller-defined | varies | Advanced / one-off |

Profile overrides in `testConfig` always take precedence over profile defaults.

---

## 3. Data Models

### 3.1 `qa_tools_runs` (Neon)

```sql
CREATE TABLE qa_tools_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identification
  app_id TEXT NOT NULL,  -- 'selfprime' | 'capricast' | 'cipherofhealing' | 'xicocity'
  environment TEXT NOT NULL,  -- 'staging' | 'production' | 'custom'
  custom_url TEXT,  -- NULL unless environment='custom'

  -- Test configuration
  test_type TEXT NOT NULL,  -- 'a11y' | 'performance' | 'form-validation' | 'scenario' | 'visual-regression' | 'full-audit'
  profile TEXT NOT NULL DEFAULT 'full',  -- 'fast' | 'a11y' | 'performance' | 'full' | 'scenario' | 'custom'
  test_config JSONB NOT NULL DEFAULT '{}',

  -- Execution
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  duration_ms INT,

  -- Retry / flakiness tracking
  attempt_number INT NOT NULL DEFAULT 1,    -- which attempt (1 = first try)
  max_attempts INT NOT NULL DEFAULT 2,       -- from profile.retries
  flake_score NUMERIC(5,2) DEFAULT 0.0,     -- 0–100 how flaky this check is historically
  parent_run_id UUID REFERENCES qa_tools_runs(id),  -- if this is a retry

  -- Results summary
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'running' | 'passed' | 'failed' | 'error' | 'flaky'
  violations_count INT DEFAULT 0,
  passes_count INT DEFAULT 0,
  warnings_count INT DEFAULT 0,
  error_message TEXT,  -- if status='error', short description

  -- CI context (if triggered from GitHub Actions)
  ci_context JSONB,  -- { pr_number, sha, workflow, repo }

  -- Metadata
  created_by UUID,
  template_id UUID,  -- if launched from a saved template
  tags TEXT[] DEFAULT '{}',

  -- Storage
  r2_prefix TEXT,  -- 'qa-tools/{app}/{id}/'
  sentry_issue_id TEXT,
  github_issue_url TEXT,

  -- Audit
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT valid_environment CHECK (environment IN ('staging', 'production', 'custom')),
  CONSTRAINT valid_status CHECK (status IN ('pending','running','passed','failed','error','flaky')),
  CONSTRAINT valid_profile CHECK (profile IN ('fast','a11y','performance','full','scenario','custom'))
);

CREATE INDEX idx_qa_runs_app_created ON qa_tools_runs(app_id, created_at DESC);
CREATE INDEX idx_qa_runs_environment ON qa_tools_runs(app_id, environment, created_at DESC);
CREATE INDEX idx_qa_runs_status ON qa_tools_runs(status, created_at DESC);
CREATE INDEX idx_qa_runs_ci ON qa_tools_runs((ci_context->>'pr_number')) WHERE ci_context IS NOT NULL;
```

### 3.2 `qa_tools_results` (Neon)

```sql
CREATE TABLE qa_tools_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES qa_tools_runs(id) ON DELETE CASCADE,

  -- Source
  category TEXT NOT NULL,  -- 'axe' | 'lighthouse' | 'console-errors' | 'form-validation' | 'network' | 'visual' | 'custom-assertion'

  -- Finding (normalized — see Appendix E)
  violation_id TEXT,       -- from axe: 'color-contrast'; from lighthouse: 'lcp'; custom: caller-defined
  severity TEXT NOT NULL,  -- 'critical' | 'serious' | 'moderate' | 'minor' | 'info' | 'pass'
  title TEXT NOT NULL,
  description TEXT,
  remediation_hint TEXT,

  -- Location evidence
  html_snippet TEXT,        -- truncated to 500 chars
  selector TEXT,
  url TEXT,                 -- page URL where finding was captured
  affected_nodes INT DEFAULT 1,

  -- Screenshots
  screenshot_key TEXT,       -- R2 key: qa-tools/{app}/{run-id}/findings/{finding-id}.png
  screenshot_diff_key TEXT,  -- R2 key for visual diff image

  -- Visual regression
  is_regression BOOLEAN NOT NULL DEFAULT FALSE,
  baseline_id UUID REFERENCES qa_tools_runs(id),
  similarity_score NUMERIC(5,4),  -- 0.0000–1.0000 (1.0 = identical)
  diff_pixel_count INT,

  -- Custom assertion result
  assertion_name TEXT,   -- user-defined name if category='custom-assertion'
  assertion_passed BOOLEAN,
  assertion_actual TEXT,    -- actual value observed
  assertion_expected TEXT,  -- expected value

  -- Tracking
  status TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'acknowledged' | 'fixed' | 'false-positive'
  acknowledged_by UUID,
  acknowledged_at TIMESTAMPTZ,

  -- Audit
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_qa_results_run ON qa_tools_results(run_id);
CREATE INDEX idx_qa_results_severity ON qa_tools_results(run_id, severity);
CREATE INDEX idx_qa_results_regression ON qa_tools_results(baseline_id, is_regression) WHERE is_regression = TRUE;
```

### 3.3 `qa_tools_credentials` (Neon, encrypted)

```sql
CREATE TABLE qa_tools_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  app_id TEXT NOT NULL,
  environment TEXT NOT NULL,  -- 'staging' | 'production'
  credential_type TEXT NOT NULL,  -- 'test-user' | 'existing-user' | 'api-key' | 'session-cookie' | 'oauth-token'

  -- Encrypted fields (pgcrypto AES-256-CBC)
  encrypted_username TEXT,
  encrypted_password TEXT,
  encrypted_data JSONB,  -- { sessionCookie, headers, oauthToken, ... }

  -- Metadata
  label TEXT NOT NULL,           -- 'QA Test User', 'Admin Account', etc.
  description TEXT,              -- optional notes (who this cred is for)
  created_by UUID,
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,        -- NULL = persistent (rotated per schedule)
  last_verified_at TIMESTAMPTZ,  -- when we last confirmed this cred works

  -- Security
  key_id TEXT NOT NULL,  -- encryption key version ref (rotate quarterly: Jan/Apr/Jul/Oct)

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(app_id, environment, label)
);

-- Pattern: never select encrypted fields without explicit decrypt intent
-- SELECT id, app_id, environment, label, last_used_at, last_verified_at
-- FROM qa_tools_credentials
-- WHERE app_id=$1 AND environment=$2 ORDER BY label;
```

### 3.4 `qa_tools_comparisons` (Neon)

```sql
CREATE TABLE qa_tools_comparisons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  current_run_id UUID NOT NULL REFERENCES qa_tools_runs(id),
  baseline_run_id UUID NOT NULL REFERENCES qa_tools_runs(id),

  -- Diff summary (a11y)
  violations_added INT DEFAULT 0,
  violations_fixed INT DEFAULT 0,
  violations_unchanged INT DEFAULT 0,

  -- Performance diff
  lcp_delta_ms INT,           -- positive = regression (slower), negative = improvement
  cls_delta NUMERIC(8,4),
  fid_delta_ms INT,
  lighthouse_score_delta INT,

  -- Visual diff
  diff_algorithm TEXT DEFAULT 'phash',  -- 'phash' | 'pixelmatch'
  pages_with_changes INT DEFAULT 0,
  max_diff_percent NUMERIC(5,2),        -- 0–100, highest single-page diff

  -- Regression detection
  is_regression BOOLEAN NOT NULL DEFAULT FALSE,
  regression_reasons TEXT[],  -- ['new-a11y-violations', 'lcp-degradation', 'visual-change']
  regression_severity TEXT,   -- 'critical' | 'warning' | 'info' (derived from reasons)

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 3.5 `qa_tools_templates` (Neon)

```sql
CREATE TABLE qa_tools_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  name TEXT NOT NULL,
  description TEXT,
  app_id TEXT,  -- NULL = applies to all apps

  -- Preset configuration (same shape as POST /runs body)
  test_type TEXT NOT NULL,
  profile TEXT NOT NULL DEFAULT 'full',
  test_config JSONB NOT NULL DEFAULT '{}',

  -- CI integration
  is_ci_default BOOLEAN NOT NULL DEFAULT FALSE,  -- run on every PR for this app
  ci_fail_on_regression BOOLEAN NOT NULL DEFAULT TRUE,

  -- Threshold overrides (for performance regression gates)
  thresholds JSONB,  -- { lcp_max_ms: 2500, cls_max: 0.1, violations_max: 0 }

  created_by UUID,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,  -- system-managed presets (a11y-audit, etc.)

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(name, app_id)
);

-- Seed system templates on deploy
INSERT INTO qa_tools_templates (name, description, test_type, profile, is_system, ci_fail_on_regression, thresholds)
VALUES
  ('WCAG 2 AA Audit', 'Full accessibility audit, all axe rules', 'a11y', 'a11y', TRUE, TRUE, '{"violations_max": 0}'),
  ('Core Web Vitals', 'Lighthouse + CWV for LCP/CLS/FID', 'performance', 'performance', TRUE, TRUE, '{"lcp_max_ms": 2500, "cls_max": 0.1}'),
  ('Login Flow', 'Authenticated scenario through sign-in', 'scenario', 'scenario', TRUE, FALSE, NULL),
  ('Release Gate', 'Full audit — runs at every release', 'full-audit', 'full', TRUE, TRUE, '{"violations_max": 0, "lcp_max_ms": 3000}'),
  ('CI Fast Check', 'Fast axe-critical + screenshot', 'a11y', 'fast', TRUE, TRUE, '{"violations_max": 0}');
```

### 3.6 `qa_tools_notification_prefs` (Neon)

```sql
CREATE TABLE qa_tools_notification_prefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  app_id TEXT NOT NULL,
  environment TEXT NOT NULL,

  -- Channels
  slack_webhook_url TEXT,    -- app-specific override (falls back to global)
  slack_channel TEXT,        -- '#qa-alerts' etc.
  github_assignees TEXT[],   -- auto-assign on created issues

  -- Triggers
  notify_on_pass BOOLEAN NOT NULL DEFAULT FALSE,
  notify_on_fail BOOLEAN NOT NULL DEFAULT TRUE,
  notify_on_regression BOOLEAN NOT NULL DEFAULT TRUE,
  daily_digest_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  daily_digest_hour INT NOT NULL DEFAULT 9,  -- UTC hour
  min_severity_to_notify TEXT NOT NULL DEFAULT 'serious',  -- 'critical' | 'serious' | 'moderate' | 'minor'

  -- GitHub issue creation
  auto_create_github_issue BOOLEAN NOT NULL DEFAULT FALSE,
  github_repo TEXT,  -- 'Latimer-Woods-Tech/capricast'
  github_labels TEXT[] DEFAULT ARRAY['qa-findings'],

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(app_id, environment)
);
```

---

## 4. API Contract

### 4.1 POST `/runs` — Start an Audit

**Request:**
```json
{
  "appId": "capricast",
  "environment": "production",
  "customUrl": null,
  "testType": "full-audit",
  "profile": "full",
  "testConfig": {
    "checks": ["axe", "lighthouse", "screenshots", "form-validation"],
    "includeAuthentication": true,
    "credentialId": "uuid-of-stored-cred",

    "scenario": {
      "steps": [
        {"action": "goto", "url": "/"},
        {"action": "waitForSelector", "selector": "[data-testid='header']", "timeout": 10000},
        {"action": "click", "selector": "[data-testid='login-button']"},
        {"action": "fill", "selector": "#email", "value": "${CRED_USERNAME}"},
        {"action": "fill", "selector": "#password", "value": "${CRED_PASSWORD}"},
        {"action": "click", "selector": "[data-testid='submit']"},
        {"action": "waitForUrl", "pattern": "/(dashboard|home)", "timeout": 15000}
      ]
    },

    "customAssertions": [
      {
        "name": "Dashboard heading visible",
        "type": "assertVisible",
        "selector": "[data-testid='dashboard-title']"
      },
      {
        "name": "User email shown",
        "type": "assertText",
        "selector": "[data-testid='user-email']",
        "contains": "@"
      },
      {
        "name": "No console errors",
        "type": "assertConsoleErrors",
        "maxErrors": 0
      },
      {
        "name": "API health",
        "type": "assertHttpStatus",
        "url": "/api/health",
        "expectedStatus": 200
      }
    ],

    "retryPolicy": {
      "maxAttempts": 2,
      "retryOn": ["timeout", "network-error", "browser-crash"],
      "backoffMs": 5000
    },

    "thresholds": {
      "lcpMaxMs": 2500,
      "clsMax": 0.1,
      "fidMaxMs": 100,
      "violationsMax": 0
    },

    "compareAgainstBaseline": true,
    "setAsNewBaseline": false,
    "notifyOnComplete": ["slack"],
    "tags": ["pre-deploy", "release-v2.1.0"],
    "templateId": null
  }
}
```

**Response (`202 Accepted`):**
```json
{
  "runId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending",
  "profile": "full",
  "estimatedDurationMs": 45000,
  "createdAt": "2026-05-27T15:30:00Z",
  "pollUrl": "https://qa-tools.lwt.internal/runs/550e8400.../status",
  "resultsUrl": "https://qa-tools.lwt.internal/runs/550e8400..."
}
```

**Validation errors (`422`):**
```json
{
  "error": "validation_error",
  "issues": [
    { "field": "testConfig.credentialId", "message": "Credential not found or not authorized for this app" }
  ]
}
```

**Rate limited (`429`):**
```json
{
  "error": "rate_limited",
  "message": "App capricast already has 3 runs in-flight (max 3 concurrent)",
  "retryAfterMs": 30000
}
```

---

### 4.2 GET `/runs/:id/status` — Poll for Progress

**Response (running):**
```json
{
  "runId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "running",
  "attemptNumber": 1,
  "maxAttempts": 2,
  "progress": {
    "currentPhase": "axe-audit",
    "completedPhases": ["screenshot"],
    "remainingPhases": ["lighthouse", "form-validation"],
    "percentComplete": 35,
    "estimatedSecondsRemaining": 30
  }
}
```

**Response (complete):**
```json
{
  "runId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "passed",
  "attemptNumber": 1,
  "completedAt": "2026-05-27T15:30:45Z",
  "durationMs": 45000,
  "summary": {
    "totalIssues": 3,
    "critical": 1,
    "serious": 1,
    "moderate": 1,
    "minor": 0,
    "lighthouseScore": 87,
    "coreWebVitals": { "lcp": 1200, "fid": 45, "cls": 0.05 },
    "thresholdBreaches": [],
    "formsValidated": 5,
    "formErrors": 1
  },
  "isRegression": false,
  "comparisonToBaseline": {
    "violationsAdded": 1,
    "violationsFixed": 2,
    "lcpDeltaMs": -80,
    "pagesWithVisualChanges": 0
  }
}
```

**Response (error — retriable):**
```json
{
  "runId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "error",
  "attemptNumber": 1,
  "maxAttempts": 2,
  "errorMessage": "browser-agent timeout after 90s",
  "willRetry": true,
  "nextAttemptAt": "2026-05-27T15:32:00Z"
}
```

---

### 4.3 GET `/runs/:id/results` — Detailed Findings

```json
{
  "runId": "550e8400-e29b-41d4-a716-446655440000",
  "appId": "capricast",
  "environment": "production",
  "testType": "full-audit",
  "profile": "full",
  "results": {
    "axe": [
      {
        "violationId": "color-contrast",
        "severity": "critical",
        "count": 2,
        "description": "Elements have insufficient color contrast",
        "remediationHint": "Increase text or background lightness to achieve ≥4.5:1 ratio",
        "affected": [
          {
            "selector": ".pricing-card h3",
            "htmlSnippet": "<h3 class='text-brand-500'>Starter Plan</h3>",
            "contrastRatio": 3.2,
            "requiredRatio": 4.5,
            "screenshotUrl": "https://r2.../findings/color-contrast-1.png"
          }
        ]
      }
    ],
    "lighthouse": {
      "scores": {
        "performance": 87,
        "accessibility": 92,
        "bestPractices": 85,
        "seo": 95
      },
      "metrics": {
        "lcp": 1200, "fid": 45, "cls": 0.05,
        "ttfb": 200, "fcp": 600
      },
      "opportunities": [
        { "id": "unused-css", "description": "Reduce unused CSS", "savingsKb": 28 }
      ]
    },
    "customAssertions": [
      {
        "name": "Dashboard heading visible",
        "passed": true
      },
      {
        "name": "User email shown",
        "passed": false,
        "actual": "(element not found)",
        "expected": "contains '@'"
      }
    ],
    "screenshots": {
      "fullPage": "https://r2.../full.png",
      "hero": "https://r2.../hero.png",
      "criticalSections": [
        {
          "name": "Pricing Table",
          "url": "https://r2.../pricing.png",
          "hasChangedFromBaseline": true,
          "diffUrl": "https://qa-tools.lwt.internal/runs/550e8400.../diffs/pricing",
          "similarityScore": 0.9743,
          "diffPixelCount": 1248
        }
      ]
    },
    "formValidation": {
      "tested": 5,
      "passed": 4,
      "failed": 1,
      "errors": [
        {
          "formName": "Sign Up",
          "fieldName": "email",
          "issue": "Accepts invalid email format",
          "example": "test@invalid"
        }
      ]
    },
    "network": {
      "failedRequests": [
        { "method": "GET", "url": "https://api.capricast.com/videos/trending", "status": 500 }
      ],
      "slowRequests": [
        { "url": "https://stream.cloudflare.com/...", "durationMs": 3200, "sizeBytes": 2500000 }
      ]
    }
  }
}
```

---

### 4.4 POST `/runs/:id/create-issue` — Export to GitHub

**Request:**
```json
{
  "title": "Accessibility: Color contrast failures on /pricing (Capricast)",
  "severityFilter": "critical",
  "includeScreenshots": true,
  "assignees": ["adrper79"],
  "labels": ["qa-findings", "accessibility", "capricast"]
}
```

**Response:**
```json
{
  "issueUrl": "https://github.com/Latimer-Woods-Tech/capricast/issues/42",
  "issueNumber": 42
}
```

---

### 4.5 POST `/runs/:id/rerun` — Retry a Run

**Purpose:** Manual re-run (flaky result), re-test after a fix, or re-run with a different profile.

**Request:**
```json
{
  "reason": "manual-rerun",
  "overrideProfile": "full",
  "setAsNewBaseline": false
}
```

**Response:** Same shape as POST `/runs` — returns new `runId` with `parent_run_id` pointing to the original.

---

### 4.6 GET `/apps/:appId/health` — App Health Summary

**Response:**
```json
{
  "appId": "capricast",
  "statusLabel": "degraded",
  "statusColor": "yellow",
  "lastRunAt": "2026-05-27T09:00:00Z",
  "lastRunStatus": "failed",
  "openViolationsCount": 3,
  "regressionsSince": "2026-05-25T00:00:00Z",
  "lighthouseScore": 87,
  "trend": "declining",
  "details": {
    "critical": 1,
    "serious": 2,
    "moderate": 0
  }
}
```

**Health status logic:**
- `healthy` (green): Last run passed, no regressions in 7d, 0 critical/serious violations
- `degraded` (yellow): Last run failed OR any serious violations open OR performance score dropped > 5pts
- `critical` (red): 1+ critical violations OR last 3 consecutive runs failed OR LCP > configured max

---

### 4.7 GET `/runs` — List Runs

**Query params:** `appId`, `environment`, `status`, `profile`, `dateFrom`, `dateTo`, `limit=20`, `offset=0`

**Response:**
```json
{
  "runs": [
    {
      "id": "550e8400...",
      "appId": "capricast",
      "environment": "production",
      "profile": "full",
      "status": "failed",
      "violationsCount": 3,
      "durationMs": 44210,
      "createdAt": "2026-05-27T09:00:00Z",
      "isRegression": true,
      "tags": ["nightly"]
    }
  ],
  "total": 47,
  "limit": 20,
  "offset": 0
}
```

---

### 4.8 PATCH `/runs/:id/results/:resultId` — Acknowledge a Finding

**Request:**
```json
{
  "status": "false-positive",
  "note": "This element is decorative only (aria-hidden)"
}
```

**Response:** `200 OK` with updated result.

---

### 4.9 POST `/templates` / GET `/templates` / DELETE `/templates/:id`

Standard CRUD. System templates (`is_system: true`) are read-only — `403` on delete/update.

---

## 5. UI/UX Design

### 5.1 Information Architecture

```
qa-tools.lwt.internal/
├── /               Dashboard (health grid + recent runs + regression alerts)
├── /apps/:appId    Per-app view (history, trends, open violations)
├── /runs
│   ├── /             List (filter: app, env, profile, status, date range)
│   └── /:id
│       ├── /summary       High-level (status, scores, threshold breaches)
│       ├── /violations    Findings with severity filter + acknowledge action
│       ├── /lighthouse    Perf scores, CWV, opportunities
│       ├── /screenshots   Full-page + hero + compare slider
│       ├── /diffs         Per-section visual diff (before/after with diff overlay)
│       ├── /network       Failed/slow requests
│       ├── /video         Scenario recording (MP4)
│       └── /export        Create GH issue | Download PDF | Download CSV | Share link
├── /setup
│   ├── /credentials   Manage encrypted test-user logins
│   ├── /environments  Configure custom URLs + headers per app
│   ├── /notifications App-level notification preferences (Slack, GitHub)
│   └── /integrations  Slack webhook, GitHub token, Sentry DSN
├── /templates
│   ├── /             List (system + custom)
│   └── /create       Build your own (profile picker + check builder + threshold editor)
└── /schedule
    ├── /             Configured schedules (daily/weekly per app)
    └── /:id          Edit schedule + run history + skip/disable
```

### 5.2 Key Screens

**Dashboard**
- Health grid: 4 apps × 2 environments (staging/prod) — color-coded (green/yellow/red)
- Regression alerts strip: "3 new violations on capricast/prod since yesterday"
- Quick-start: "Run Fast Audit", "Run Release Gate", "Run Login Flow"
- Recent runs table (last 10): app | env | profile | status | issues | duration | ago

**App Detail (`/apps/:appId`)**
- WCAG trend chart (30d)
- Lighthouse score trend (30d, per metric)
- Open violations list (filterable by severity)
- Baseline history (when baselines were set + who)

**Run Results (`/runs/:id`)**
- Header: app + env + profile + timestamp + status badge + duration
- Threshold breach banner (if any thresholds exceeded)
- Tabs: Summary | Violations | Lighthouse | Screenshots | Diffs | Network | Forms | Video
- Violations: severity chip + axe ID + selector + remediation hint + screenshot thumbnail + "Acknowledge" button
- Before/after screenshot slider on `/diffs` tab

**Credentials Manager (`/setup/credentials`)**
- Table: App | Env | Label | Type | Last Used | Last Verified | Expires
- "Test Login" button (runs `fast` profile with credentials, no audit — just verify login works)
- Expiry warning at 7 days; badge turns red at 1 day
- Add new: wizard (email/password → session cookie → OAuth token)
- Show encrypted indicator on all cred fields; never expose plaintext

---

## 6. Security & Compliance

### 6.1 Credential Storage

```typescript
// Encrypt before insert
const encrypted = await encryptWithPgcrypto(
  { username: email, password: pwd },
  env.QA_TOOLS_ENCRYPTION_KEY,
  currentKeyId  // 'key-2026-q2'
);

// Decrypt only at run dispatch — never persisted in logs or R2
const creds = await decryptCredential(
  stored.encrypted_username,
  stored.encrypted_password,
  env.QA_TOOLS_ENCRYPTION_KEY,
  stored.key_id
);

// Inject into browser-agent request; credentials cleared from memory after response
const result = await browserAgent.runScenario(url, scenario, {
  auth: creds  // transmitted over HTTPS only; not logged
});
creds.username = '';  // zero out before GC
creds.password = '';
```

### 6.2 Access Control (RBAC)

| Operation | `qa_viewer` | `qa_runner` | `qa_admin` |
|-----------|------------|------------|-----------|
| View run results | ✅ (own apps) | ✅ (own apps) | ✅ (all) |
| Run audit | ❌ | ✅ (own apps) | ✅ (all) |
| Read credential metadata | ✅ (own apps) | ✅ (own apps) | ✅ (all) |
| Write/delete credentials | ❌ | ❌ | ✅ |
| Acknowledge findings | ❌ | ✅ (own apps) | ✅ |
| Create/edit templates | ❌ | ✅ | ✅ |
| Manage schedules | ❌ | ❌ | ✅ |
| Delete run history | ❌ | ❌ | ✅ |
| Set baseline | ❌ | ✅ (own apps) | ✅ |
| Create GitHub issues | ❌ | ✅ (own apps) | ✅ |

App-level isolation: all operations that touch app data also enforce `app_ids` claim on JWT. A `qa_runner` for capricast cannot trigger a run against selfprime even if they guess the `appId`.

### 6.3 Audit Trail

Every credential decrypt writes to `factory_audit_log`:
```sql
INSERT INTO factory_audit_log (
  entity_type, entity_id, action, actor, app_id, details
) VALUES (
  'qa_tools_credential', cred_uuid, 'decrypt',
  user_id, 'capricast',
  '{"environment":"production","label":"QA Test User","run_id":"..."}'
);
```

Credential creates, updates, and deletes also logged. Retention: 90 days.

### 6.4 Error Recovery & Circuit Breaker

The QA Worker implements a circuit breaker over the browser-agent:

```
States: CLOSED → OPEN → HALF-OPEN → CLOSED

CLOSED: normal operation, all requests pass through
OPEN:   triggered after 3 consecutive browser-agent timeouts in 5 min window
        - All new runs rejected with 503 (retry_after_ms: 120000)
        - Status page shows "browser-agent degraded"
HALF-OPEN: after 2 min, allow 1 test request
        - If succeeds → CLOSED; if fails → OPEN (reset timer)

Timeout escalation:
  Attempt 1: profile.timeoutMs
  Attempt 2: profile.timeoutMs × 1.5
  Max timeout cap: 180s (hard)

On browser-agent 5xx: immediate retry (attempt 2) after 5s
On browser-agent 429: back off per Retry-After header
On browser-agent unavailable (DNS/network): circuit breaks after 1 failure
```

All circuit state changes emit a PostHog `qa_circuit_breaker_state_change` event and a Sentry breadcrumb.

### 6.5 Rate Limiting

```
Per-app concurrent runs:     3 (queue 10, reject beyond)
Per-user runs/hour:          20
Per-CI-token runs/hour:      100 (higher for scheduled workloads)
browser-agent parallelism:   10 total (all apps combined)
```

Rate limit state stored in Cloudflare KV (`QA_TOOLS_RATE_KV`). Headers on every response:
```
X-RateLimit-App-Concurrent: 2/3
X-RateLimit-User-Remaining: 18/20
```

---

## 7. Integrations

### 7.1 GitHub Issues (Auto-creation)

Issue body template includes: severity summary table, WCAG IDs + remediation hints, affected selectors, link to QA Tools run, screenshot thumbnails (embedded as data URLs if small enough).

Labels: `qa-findings`, `accessibility` (if a11y), `performance` (if Lighthouse), `{app-name}`, `automated`.

Set `auto_create_github_issue: true` in `qa_tools_notification_prefs` to run this automatically on every failing audit.

### 7.2 GitHub PR Comments (CI Mode)

When `ci_context.pr_number` is set on a run:
```
POST /repos/{owner}/{repo}/issues/{pr_number}/comments
Body:
## QA Audit Results — capricast/staging

| Check | Status | Details |
|-------|--------|---------|
| ♿ A11y (WCAG 2 AA) | ❌ 2 violations | color-contrast, heading-order |
| 🚀 Performance | ✅ LCP 1.2s | Score: 87 |
| 📸 Visual regression | ✅ No changes | — |

[View full results →](https://qa-tools.lwt.internal/runs/550e8400...)
```

### 7.3 GitHub Status Check (CI Mode)

```
POST /repos/{owner}/{repo}/statuses/{sha}
{
  "state": "failure",
  "context": "qa-tools/a11y",
  "description": "2 critical violations found",
  "target_url": "https://qa-tools.lwt.internal/runs/550e8400..."
}
```

Status check name maps to template: `qa-tools/{templateName}`. Required checks can be enforced via branch protection rules.

### 7.4 Slack Notifications

Per `qa_tools_notification_prefs`, either send to the app-specific webhook or the global fallback:

- **On failure:** Immediate alert with severity summary + link
- **Daily digest (9 AM):** All apps, pass/fail summary, top open violations, trend vs last week
- **On regression detection:** Immediate with diff summary

### 7.5 Sentry Event Linkage

When a run finds console errors or network failures:
1. Search Sentry for issues matching the same URL + error message
2. If found, store `sentry_issue_id` on `qa_tools_runs`
3. Add `qa-tools` tag to the Sentry issue for cross-filtering

### 7.6 PostHog Analytics

Events emitted per run:
```typescript
posthog.capture('qa_audit_run', {
  app_id, environment, profile,
  status, duration_ms,
  violations_count, passes_count,
  is_regression,
  lighthouse_score,
  lcp, cls, fid,
  attempt_number,
  template_id
});
```

Powers:
- Violations/week trend (per app)
- WCAG compliance score trend
- Average audit duration by profile
- Regression detection rate

---

## 8. Implementation Phases

### Phase 1: MVP — A11y + Screenshots (2 weeks)

**Goal:** One-click a11y audit + screenshot for all 4 apps. Working dashboard. Core infra.

**Infrastructure:**
- Neon tables: `qa_tools_runs`, `qa_tools_results` (Phase 1 schema only)
- R2 bucket: `qa-tools` (with `/qa-tools/{app}/{run-id}/` prefix structure)
- CF Worker (`apps/qa-tools-worker`): `POST /runs`, `GET /runs/:id/status`, `GET /runs/:id/results`
- Next.js app (`apps/qa-tools-ui`): scaffold + pages skeleton

**Features:**
- Audit type: `a11y` profile (axe-core full WCAG 2 AA via browser-agent `/audit`)
- Screenshots: full page + hero (via browser-agent `/screenshot`)
- Results page: violations table + screenshot viewer
- `GET /apps/:appId/health` endpoint (basic: last run status only)
- factory_audit_log writes (no credential access yet, just run creation)

**NOT in Phase 1:** Credentials, auth pages, scenarios, performance, scheduling, templates, CI integration.

**Acceptance criteria:**
- Run `fast` profile audit on capricast.com/production
- Receive WCAG violations with violation IDs + remediation hints
- View screenshots side-by-side in dashboard
- Create GitHub issue from a finding (manual POST to `/runs/:id/create-issue`)

---

### Phase 2: Credentials + Scenarios + Templates (2 weeks)

**Features:**
- `qa_tools_credentials` table + encryption
- `/setup/credentials` UI (CRUD + "Test Login" button)
- Multi-step scenario execution (scenario steps dispatched to browser-agent `/run-scenario`)
- Form validation testing (auto-fill + submit)
- `qa_tools_templates` table + seeded system templates
- `/templates` UI (list + create custom)
- `qa_tools_notification_prefs` table + `/setup/notifications` UI
- Retry logic: `retryPolicy` in test_config → `attempt_number` + `parent_run_id` on re-runs
- RBAC enforcement: `qa_viewer` / `qa_runner` / `qa_admin` JWT claims

**Acceptance criteria:**
- Add test user credentials for capricast/production
- Run `scenario` profile through sign-in to dashboard
- Audit authenticated `/dashboard` page (a11y on protected page)
- Launch run from "Login Flow" system template
- Verify second attempt auto-fires on timeout

---

### Phase 3: Performance + Baselines + Export (2 weeks)

**Features:**
- `performance` profile: Lighthouse via browser-agent `/audit` (see Appendix B for config)
- `qa_tools_comparisons` table: baseline comparison + regression detection
- "Set as baseline" action on any passing run
- Threshold spec enforced: `thresholds.lcpMaxMs`, `thresholds.clsMax`, `thresholds.violationsMax`
  - Run status = `failed` if any threshold breached, even if no violations
- Network auditing: failed XHR (4xx/5xx) + slow assets (> 3s)
- Export: PDF report (html-to-pdf via browser-agent), CSV of violations
- `GET /apps/:appId/health` upgraded: trend, 7-day regression history, color logic

**Diff algorithm for comparisons:**
- A11y diff: exact match on `violation_id` + `selector` pair (new vs. fixed)
- Performance diff: absolute delta on LCP/CLS/FID vs. baseline
- Thresholds evaluated against current run values, not deltas

**Acceptance criteria:**
- Run performance audit → see LCP/FID/CLS scores
- Set a baseline → run again → show comparison diff
- Trigger threshold breach on LCP > 2500ms → run status = `failed`
- Download PDF report of a full audit

---

### Phase 4: Scheduling + CI Integration (2 weeks)

**Features:**
- `qa_tools_schedules` table (cron expression, template_id, enabled flag)
- `/schedule` UI (create/edit/disable per app + environment)
- Cloudflare Worker cron trigger: run scheduled audits (Crons API)
- Daily digest Slack message (batched, not per-run noise)
- GitHub Actions integration:
  - GHA callable workflow `.github/workflows/qa-audit.yml` (see Appendix D)
  - Posts PR comment via GitHub API
  - Posts GitHub status check (`qa-tools/{templateName}`)
  - Passes CI JWT (no credential access) — only `fast` or `a11y` profiles in CI context
- `auto_create_github_issue` enforcement from notification prefs

**Acceptance criteria:**
- Configure daily `full` audit for capricast/production at 9 AM UTC
- Receive Slack digest the next day
- Open a PR → `CI Fast Check` template runs → status check posted on commit
- Regression detected → GitHub issue auto-created with correct labels

---

### Phase 5: Visual Regression + Analytics (3 weeks)

**Features:**
- Visual regression: pHash (perceptual hash) as default algorithm, pixelmatch for pixel-accurate diffs
  - pHash threshold: 8-bit hash distance ≤ 5 = no change; > 5 = flagged
  - pixelmatch fallback: configurable `diffPercent` threshold (default 0.5%)
  - Diff images rendered as overlay PNG (red highlights) → stored in R2
- Before/after slider component in Dashboard (`/runs/:id/diffs`)
- QA metrics analytics dashboard in PostHog:
  - Violations/week per app
  - WCAG compliance % trend
  - Mean audit duration by profile
  - Regression catch rate (regressions caught in CI vs. found post-deploy)
- Flakiness scoring: track `flake_score` per test type over rolling 30 days (% of runs with >1 attempt)
- Custom assertion builder: UI form that generates `customAssertions` JSON + saves to template
- (If budget): Multi-browser (Webkit, Firefox) — browser-agent `/audit?browser=firefox`
- (If budget): Video capture of scenario runs (browser-agent `video: true` flag → MP4 to R2)

**Diff algorithm spec:**
```
pHash pipeline:
  1. Resize screenshot to 32×32 grayscale
  2. Compute DCT, keep top-left 8×8 = 64 bits
  3. Compare current vs. baseline: Hamming distance
  4. Distance > 5: flag as changed; store diff metadata
  5. If flagged: run pixelmatch for pixel-level evidence (diff PNG)

pixelmatch config:
  threshold: 0.1 (color distance tolerance)
  aa: true (ignore anti-aliasing differences)
  diffColor: [255, 0, 0]
```

**Acceptance criteria:**
- Run visual regression → see before/after slider with diff overlay
- pHash catches layout shift that axe missed
- pHash does NOT flag font-rendering differences (threshold tolerance correct)
- Flakiness dashboard shows which tests retry most

---

## 9. Deployment & Operations

### 9.1 Environments

| Environment | Domain | Frontend | Worker | Browser Agent | Database |
|---|---|---|---|---|---|
| **Production** | `https://qa.latimerwoods.dev` | CF Pages (main) | `https://api.qa.latimerwoods.dev` | Cloud Run prod | Neon prod |
| **Staging** | `https://staging.qa.latimerwoods.dev` | CF Pages (branch) | `https://api.qa.latimerwoods.dev` | Cloud Run staging | Neon staging |

### 9.2 Secrets Management (GCP Secret Manager via WIF)

```
QA_TOOLS_ENCRYPTION_KEY      pgcrypto AES key   rotate: quarterly (Jan/Apr/Jul/Oct 1)
QA_TOOLS_JWT_SECRET          API JWT signing    rotate: semi-annually
GOOGLE_CLIENT_ID             Google Sign-In     shared policy with Admin Studio
QA_TOOLS_ALLOWED_USERS_JSON  Operator allowlist shared policy with Admin Studio
QA_TOOLS_ADMIN_EMAIL         Break-glass user   shared policy with Admin Studio
QA_TOOLS_ADMIN_PASSWORD_SHA256 Break-glass hash  shared policy with Admin Studio
QA_TOOLS_CI_SECRET           CI service token   rotate: annually
BROWSER_AGENT_URL            Cloud Run URL      static until service renamed
BROWSER_AGENT_AUDIENCE       Cloud Run OIDC     static
BROWSER_AGENT_SA_KEY         Service account    rotate: annually
QA_TOOLS_R2_BUCKET           R2 bucket name     static
QA_TOOLS_NEON_URL            Neon DSN           rotate: on breach
GITHUB_QA_TOKEN              GH issues/comments rotate: annually
SLACK_QA_WEBHOOK_URL         Global fallback    rotate: on breach
SENTRY_QA_DSN                Sentry DSN         static
QA_TOOLS_POSTHOG_KEY         PostHog write key  static
```

### 9.3 Monitoring

- **Sentry:** Errors from QA Worker + browser-agent timeouts + circuit breaker state changes
- **PostHog:** `qa_audit_run`, `qa_circuit_breaker_state_change`, `qa_credential_test`
- **Uptime:** Worker `/health` → `{"status":"ok","circuitBreaker":"closed","version":"..."}`
- **R2 retention:** Artifacts auto-expire at 90 days (R2 lifecycle rule)

### 9.4 Runbook: Add New App

```bash
# 1. Add to APPS enum in worker (apps/qa-tools-worker/src/config.ts)
const APPS = ['selfprime','capricast','cipherofhealing','xicocity','new-app'] as const;

# 2. Insert notification prefs (defaults — edit in UI after)
INSERT INTO qa_tools_notification_prefs (app_id, environment, daily_digest_enabled)
VALUES ('new-app','staging',TRUE), ('new-app','production',TRUE);

# 3. Add credentials (via /setup/credentials UI)

# 4. Deploy worker
wrangler deploy --env production

# 5. Verify
curl -X POST https://qa-tools.lwt.internal/runs \
  -H "Authorization: Bearer $JWT" \
  -d '{"appId":"new-app","environment":"staging","testType":"a11y","profile":"fast"}'

# 6. Add to CI workflow (Appendix D) — add app_id to matrix
```

### 9.5 Runbook: Key Rotation (Quarterly)

```bash
# 1. Generate new key
openssl rand -base64 32

# 2. Create new secret version in GCP Secret Manager
printf '%s' 'NEW_KEY_VALUE' | gcloud secrets versions add QA_TOOLS_ENCRYPTION_KEY --data-file=-

# 3. Update key_id in all qa_tools_credentials rows
UPDATE qa_tools_credentials
SET encrypted_username = encrypt_cred(decrypt_cred(encrypted_username, OLD_KEY), NEW_KEY),
    encrypted_password = encrypt_cred(decrypt_cred(encrypted_password, OLD_KEY), NEW_KEY),
    key_id = 'key-2026-q3',
    updated_at = now();

# 4. Deploy worker (picks up new secret version)

# 5. Disable old secret version
gcloud secrets versions disable VERSION --secret=QA_TOOLS_ENCRYPTION_KEY
```

---

## 10. Scalability & Performance

### 10.1 Constraints

| Resource | Limit | Behavior at limit |
|----------|-------|------------------|
| browser-agent parallelism | 10 concurrent requests | Queue held; 11th run waits or 503 |
| Per-app concurrent runs | 3 | 429 with `retry_after_ms` |
| Per-user runs/hour | 20 | 429 with `X-RateLimit-User-Remaining` |
| Audit queue depth | 100 pending | 503 when exceeded |
| R2 artifact retention | 90 days | Auto-expired by lifecycle rule |
| Run history retention | 365 days | `qa_tools_runs` rows deleted by cron |

### 10.2 Optimizations

- **Parallel checks:** axe + lighthouse + screenshot start simultaneously (not sequential)
- **Profile-based timeout:** `fast` profile aborts at 15s — never blocks CI for a hung browser
- **Screenshot caching:** Skip re-capture if same URL + profile within 5 min (KV flag)
- **R2 CDN:** Screenshots edge-cached with 1d TTL (public-read via presigned URL that embeds cache control)
- **Neon read replicas:** Results queries (`GET /runs`, `GET /runs/:id/results`) hit read replica in Phase 3+

---

## 11. Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Median audit duration (`full` profile) | < 60s | PostHog `duration_ms` p50 |
| `fast` profile duration (CI) | < 15s | PostHog `duration_ms` p95 for `fast` |
| WCAG 2 AA compliance (all 4 apps) | ≥ 95% passes | `passes_count / (passes_count + violations_count)` |
| Auto-issues created from QA findings | > 80% of failing runs | GH issues with `qa-findings` vs. failing runs |
| Regression catch rate (before prod deploy) | 100% | Regressions found in CI vs. found post-deploy |
| Flakiness rate (runs requiring retry) | < 5% | `attempt_number > 1` / total runs |
| QA Tool availability | 99.5% | Sentry uptime monitor on `/health` |
| Credential test success rate | > 99% | `qa_credential_test` PostHog events |
| Open critical violations across all apps | 0 (goal) | `violations_count WHERE severity='critical'` |

---

## Appendix A: API Request Examples

### Create a fast CI audit

```bash
curl -X POST https://qa-tools.lwt.internal/runs \
  -H "Authorization: Bearer $CI_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "appId": "capricast",
    "environment": "staging",
    "testType": "a11y",
    "profile": "fast",
    "testConfig": {
      "thresholds": { "violationsMax": 0 },
      "compareAgainstBaseline": true
    }
  }'
```

### Create a full authenticated scenario audit

```bash
curl -X POST https://qa-tools.lwt.internal/runs \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "appId": "capricast",
    "environment": "staging",
    "testType": "full-audit",
    "profile": "full",
    "testConfig": {
      "checks": ["axe", "lighthouse", "screenshots", "form-validation"],
      "includeAuthentication": true,
      "credentialId": "550e8400-e29b-41d4-a716-446655440000",
      "scenario": {
        "steps": [
          {"action": "goto", "url": "/"},
          {"action": "click", "selector": "[data-testid=login-button]"},
          {"action": "fill", "selector": "#email", "value": "${CRED_USERNAME}"},
          {"action": "fill", "selector": "#password", "value": "${CRED_PASSWORD}"},
          {"action": "click", "selector": "[data-testid=submit]"},
          {"action": "waitForUrl", "pattern": "/dashboard", "timeout": 15000},
          {"action": "screenshot", "name": "dashboard"}
        ]
      },
      "customAssertions": [
        {"name": "Dashboard loads", "type": "assertVisible", "selector": "[data-testid=dashboard-title]"},
        {"name": "No 500 errors", "type": "assertConsoleErrors", "maxErrors": 0}
      ],
      "thresholds": { "lcpMaxMs": 2500, "violationsMax": 0 },
      "compareAgainstBaseline": true
    }
  }'
```

### Poll until complete and get results

```bash
RUN_ID=550e8400-e29b-41d4-a716-446655440000

while true; do
  STATUS=$(curl -s https://qa-tools.lwt.internal/runs/$RUN_ID/status \
    -H "Authorization: Bearer $JWT" | jq -r '.status')
  
  echo "Status: $STATUS"
  if [[ "$STATUS" != "pending" && "$STATUS" != "running" ]]; then
    break
  fi
  sleep 5
done

# Get full results
curl https://qa-tools.lwt.internal/runs/$RUN_ID/results \
  -H "Authorization: Bearer $JWT" | jq '.results.axe'
```

---

## Appendix B: Lighthouse Audit Configuration

```typescript
// browser-agent passes this to lighthouse via runnerConfig
const lighthouseConfig = {
  extends: 'lighthouse:default',
  settings: {
    emulatedFormFactor: 'mobile',
    throttling: {
      downloadThroughputKbps: 1638,  // 3G
      uploadThroughputKbps: 768,
      rttMs: 150
    },
    skipAudits: [
      'canonical',               // CDN-hosted apps may not have canonical
      'csp-xss-protection',      // CF handles CSP; axe catches injections better
    ],
    onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo']
  }
};

// Key metrics captured
const METRICS_TO_EXTRACT = [
  'largest-contentful-paint',   // LCP
  'cumulative-layout-shift',    // CLS
  'first-input-delay',          // FID (replaced by INP in LH 11+)
  'total-blocking-time',        // TBT (proxy for FID in synthetic)
  'first-contentful-paint',     // FCP
  'speed-index',
  'time-to-first-byte',
  'server-response-time',
  'unused-css-rules',
  'uses-optimized-images',
  'uses-webp-images',
  'uses-text-compression',
  'uses-rel-preconnect',
  'modern-image-formats'
];
```

---

## Appendix C: Test User Rotation Policy

- **Change password:** Monthly (1st of month, 4 AM UTC)
- **Encryption key rotation:** Quarterly (Jan 1 / Apr 1 / Jul 1 / Oct 1)
- **Verify credentials work:** Weekly automated "test login" run per app × environment
- **Session expiry:** 24 hours (session cookies auto-invalidated)
- **Credential revocation triggers:** App deleted, team member offboarded, breach suspected
- **Notify on expiry warning:** 7 days before `expires_at`

```sql
-- pg_cron: monthly password-rotation placeholder
SELECT cron.schedule(
  'qa-tools-cred-verify',
  '0 4 * * 1',  -- 4 AM UTC every Monday (credential health check)
  'CALL qa_verify_all_credentials()'  -- runs "test login" for each cred
);
```

---

## Appendix D: CI/CD GitHub Actions Integration

This reusable workflow is called from any app's CI pipeline. It runs the `fast` or `a11y` profile (non-blocking for `fast`, blocking for `a11y`), posts a PR comment, and optionally fails the check.

```yaml
# .github/workflows/qa-audit.yml (reusable, lives in Factory)
name: QA Audit

on:
  workflow_call:
    inputs:
      app_id:
        required: true
        type: string
      environment:
        required: true
        type: string
        default: staging
      profile:
        required: false
        type: string
        default: fast
      fail_on_violations:
        required: false
        type: boolean
        default: true
    secrets:
      QA_TOOLS_CI_JWT:
        required: true

jobs:
  qa-audit:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      statuses: write
    steps:
      - name: Trigger QA audit
        id: trigger
        run: |
          RUN=$(curl -sf -X POST https://qa-tools.lwt.internal/runs \
            -H "Authorization: Bearer ${{ secrets.QA_TOOLS_CI_JWT }}" \
            -H "Content-Type: application/json" \
            -d '{
              "appId": "${{ inputs.app_id }}",
              "environment": "${{ inputs.environment }}",
              "testType": "a11y",
              "profile": "${{ inputs.profile }}",
              "testConfig": {
                "thresholds": { "violationsMax": 0 },
                "compareAgainstBaseline": true
              },
              "ciContext": {
                "prNumber": ${{ github.event.pull_request.number || 0 }},
                "sha": "${{ github.sha }}",
                "workflow": "${{ github.workflow }}",
                "repo": "${{ github.repository }}"
              }
            }')
          echo "run_id=$(echo $RUN | jq -r '.runId')" >> $GITHUB_OUTPUT
          echo "poll_url=$(echo $RUN | jq -r '.pollUrl')" >> $GITHUB_OUTPUT

      - name: Wait for audit to complete
        id: result
        run: |
          for i in $(seq 1 24); do  # max 2 min (5s × 24)
            STATUS=$(curl -sf ${{ steps.trigger.outputs.poll_url }} \
              -H "Authorization: Bearer ${{ secrets.QA_TOOLS_CI_JWT }}" | jq -r '.status')
            echo "Status: $STATUS (attempt $i)"
            if [[ "$STATUS" != "pending" && "$STATUS" != "running" ]]; then
              echo "final_status=$STATUS" >> $GITHUB_OUTPUT
              break
            fi
            sleep 5
          done

      - name: Post PR comment
        if: github.event.pull_request.number != ''
        run: |
          # QA Tools Worker handles PR comment via ci_context.pr_number
          # No additional step needed — Worker posts comment on run completion

      - name: Fail if violations found
        if: inputs.fail_on_violations && steps.result.outputs.final_status == 'failed'
        run: |
          echo "QA audit failed — violations found. See PR comment for details."
          exit 1
```

**Call from app CI:**
```yaml
# .github/workflows/ci.yml (capricast, for example)
qa:
  uses: Latimer-Woods-Tech/Factory/.github/workflows/qa-audit.yml@main
  with:
    app_id: capricast
    environment: staging
    profile: fast
    fail_on_violations: true
  secrets:
    QA_TOOLS_CI_JWT: ${{ secrets.QA_TOOLS_CI_JWT }}
```

---

## Appendix E: Normalized Finding Type

All checks (axe, lighthouse, network, form, custom assertion, visual) produce a normalized `Finding` type internally before being written to `qa_tools_results`. This allows the UI to render any finding category uniformly.

```typescript
interface Finding {
  category: 'axe' | 'lighthouse' | 'console-errors' | 'form-validation' | 'network' | 'visual' | 'custom-assertion';
  violationId: string;       // stable, machine-readable ID
  severity: 'critical' | 'serious' | 'moderate' | 'minor' | 'info' | 'pass';
  title: string;             // short human label
  description: string;       // full explanation
  remediationHint: string;   // actionable fix (1–2 sentences)
  url: string;               // page where found
  selector?: string;         // CSS selector (if element-level)
  htmlSnippet?: string;      // truncated HTML (≤500 chars)
  screenshotKey?: string;    // R2 key to evidence screenshot
  affectedNodes?: number;    // count for batched violations
  // Category-specific extras
  meta?: Record<string, unknown>;
}

// Adapters per source
const fromAxeViolation = (v: AxeViolation, url: string): Finding[] =>
  v.nodes.map((node) => ({
    category: 'axe',
    violationId: v.id,
    severity: mapAxeImpact(v.impact),
    title: v.help,
    description: v.description,
    remediationHint: v.helpUrl,
    url,
    selector: node.target.join(', '),
    htmlSnippet: node.html.slice(0, 500),
    affectedNodes: v.nodes.length,
  }));

const fromLighthouseAudit = (audit: LHAudit, url: string): Finding => ({
  category: 'lighthouse',
  violationId: audit.id,
  severity: audit.score < 0.5 ? 'serious' : audit.score < 0.9 ? 'moderate' : 'pass',
  title: audit.title,
  description: audit.description,
  remediationHint: audit.displayValue ?? '',
  url,
  meta: { score: audit.score, numericValue: audit.numericValue }
});
```
