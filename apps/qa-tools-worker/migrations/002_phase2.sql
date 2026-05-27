-- QA Tools Platform — Phase 2 migration
-- Tables: qa_tools_credentials, qa_tools_templates, qa_tools_notification_prefs
-- See: docs/architecture/QA_TOOLS_ARCHITECTURE.md §3.3, §3.5, §3.6

-- ────────────────────────────────────────────────────────────────────────────
-- 3.3  qa_tools_credentials — encrypted test-user login credentials
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS qa_tools_credentials (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  app_id       TEXT NOT NULL,
  environment  TEXT NOT NULL CHECK (environment IN ('staging', 'production', 'custom')),
  label        TEXT NOT NULL,            -- human-readable, e.g. "QA Test User (admin)"

  -- Encrypted payload: AES-256-GCM, format "{iv_hex}:{ciphertext_hex}"
  -- Decrypted JSON: { username, password, mfa_secret?, headers? }
  encrypted_payload TEXT NOT NULL,

  -- Non-sensitive metadata (searchable without decryption)
  username_hint TEXT,                    -- e.g. "qa+capricast@latimer...." (partial)
  last_used_at  TIMESTAMPTZ,
  last_used_by  TEXT,                    -- user sub

  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(app_id, environment, label)
);

CREATE INDEX IF NOT EXISTS idx_qa_creds_app_env
  ON qa_tools_credentials (app_id, environment);

-- ────────────────────────────────────────────────────────────────────────────
-- 3.5  qa_tools_templates — audit configuration presets
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS qa_tools_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  name        TEXT NOT NULL,
  description TEXT,
  app_id      TEXT,   -- NULL = global template (applies to all apps)

  -- Preset config — same shape as POST /runs body
  test_type   TEXT NOT NULL,
  profile     TEXT NOT NULL DEFAULT 'full',
  test_config JSONB NOT NULL DEFAULT '{}',

  -- CI defaults
  is_ci_default          BOOLEAN NOT NULL DEFAULT FALSE,
  ci_fail_on_regression  BOOLEAN NOT NULL DEFAULT TRUE,

  -- Threshold overrides
  thresholds  JSONB,  -- { lcp_max_ms, cls_max, violations_max }

  created_by  TEXT,
  is_system   BOOLEAN NOT NULL DEFAULT FALSE,  -- system-managed; no delete/update by users

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(name, app_id)
);

CREATE INDEX IF NOT EXISTS idx_qa_templates_app
  ON qa_tools_templates (app_id);

-- Seed system templates (idempotent — ON CONFLICT DO NOTHING)
INSERT INTO qa_tools_templates
  (name, description, test_type, profile, is_system, ci_fail_on_regression, thresholds)
VALUES
  ('WCAG 2 AA Audit',
   'Full accessibility audit — all axe rules, WCAG 2.1 AA',
   'a11y', 'a11y', TRUE, TRUE,
   '{"violations_max": 0}'),

  ('Core Web Vitals',
   'Lighthouse performance audit — LCP, CLS, FID, TTFB',
   'performance', 'performance', TRUE, TRUE,
   '{"lcp_max_ms": 2500, "cls_max": 0.1}'),

  ('Login Flow',
   'Authenticated scenario: navigate to sign-in, log in, verify dashboard loads',
   'scenario', 'scenario', TRUE, FALSE,
   NULL),

  ('Release Gate',
   'Full audit run at every release — a11y + performance + screenshots',
   'full-audit', 'full', TRUE, TRUE,
   '{"violations_max": 0, "lcp_max_ms": 3000}'),

  ('CI Fast Check',
   'Fast axe-critical scan + single screenshot (< 15 s). Suitable for every PR.',
   'a11y', 'fast', TRUE, TRUE,
   '{"violations_max": 0}')
ON CONFLICT (name, app_id) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- 3.6  qa_tools_notification_prefs — per-app notification configuration
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS qa_tools_notification_prefs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  app_id      TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('staging', 'production', 'custom')),

  -- Slack
  slack_webhook_url  TEXT,           -- app-specific override (falls back to global SLACK_QA_WEBHOOK_URL)
  slack_channel      TEXT,           -- '#qa-alerts'

  -- GitHub
  github_assignees   TEXT[],         -- auto-assign on created issues
  auto_create_github_issue BOOLEAN NOT NULL DEFAULT FALSE,
  github_repo        TEXT,           -- 'Latimer-Woods-Tech/capricast'
  github_labels      TEXT[] DEFAULT ARRAY['qa-findings'],

  -- Triggers
  notify_on_pass           BOOLEAN NOT NULL DEFAULT FALSE,
  notify_on_fail           BOOLEAN NOT NULL DEFAULT TRUE,
  notify_on_regression     BOOLEAN NOT NULL DEFAULT TRUE,
  daily_digest_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  daily_digest_hour        INT     NOT NULL DEFAULT 9 CHECK (daily_digest_hour BETWEEN 0 AND 23),
  min_severity_to_notify   TEXT    NOT NULL DEFAULT 'serious'
    CHECK (min_severity_to_notify IN ('critical', 'serious', 'moderate', 'minor')),

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(app_id, environment)
);

CREATE INDEX IF NOT EXISTS idx_qa_notif_app_env
  ON qa_tools_notification_prefs (app_id, environment);
