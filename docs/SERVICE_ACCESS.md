# Service Access Reference

Maps every external service to its preferred access method in the remote execution environment.

**Priority order:**
1. **MCP tool** — pre-authenticated, call directly, no credential fetching needed
2. **GCP Secret Manager** — `node scripts/gcp.mjs get <NAME>` for credentials used in API calls
3. **Direct env** — for connection strings used by drivers/SDKs (DATABASE_URL, etc.)

---

## MCP-Backed Services (use these first)

### Cloudflare
- **MCP server:** `mcp__c7520edb-d405-4501-9b49-4aaf62764431`
- **Capabilities:** Workers, KV namespaces, R2 buckets, D1 databases, Hyperdrive configs
- **Key tools:** `workers_list`, `workers_get_worker`, `workers_get_worker_code`, `d1_database_query`, `r2_buckets_list`, `hyperdrive_configs_list`, `kv_namespaces_list`, `accounts_list`
- **Fallback secret:** `CF_API_TOKEN`, `CF_ACCOUNT_ID`
- **Endpoint reachable:** ✅ `api.cloudflare.com`

### GitHub
- **MCP server:** `mcp__github__*` (all `mcp__github__` prefixed tools)
- **Capabilities:** PRs, issues, commits, branches, files, code search, releases, collaborators
- **Key tools:** `pull_request_read`, `pull_request_review_write`, `list_issues`, `push_files`, `get_file_contents`, `list_commits`, `search_code`
- **Fallback secret:** `FACTORY_GH_PAT` (PAT for scripted git ops), `FACTORY_APP_PRIVATE_KEY` (GitHub App)
- **Endpoint reachable:** ✅ `api.github.com`
- **Note:** Restricted to `latimer-woods-tech/factory` repo via session config

### Stripe
- **MCP server:** `mcp__06558267-81d7-47f5-979d-d7e0209412d6`
- **Capabilities:** Customers, invoices, subscriptions, payment intents, refunds, coupons, products, prices, disputes, balance
- **Key tools:** `retrieve_balance`, `list_customers`, `list_subscriptions`, `list_invoices`, `create_invoice`, `stripe_api_execute`
- **Fallback secret:** `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`
- **Endpoint reachable:** ✅ `api.stripe.com`

### Sentry
- **MCP server:** `mcp__5a4f600b-92c2-408c-97f0-c0b6aa2b9f66`
- **Capabilities:** Organizations, projects, teams, issues, events, DSNs, releases, replays, profiles
- **Key tools:** `find_organizations`, `find_projects`, `search_issues`, `search_events`, `create_project`, `find_dsns`, `analyze_issue_with_seer`
- **Fallback secret:** `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_DSN`
- **Endpoint reachable:** ✅ `sentry.io`

### Slack
- **MCP server:** `mcp__77218124-9c3a-4caa-9263-cf142719a112`
- **Capabilities:** Send/schedule messages, read channels and threads, search, manage canvases
- **Key tools:** `slack_send_message`, `slack_read_channel`, `slack_read_thread`, `slack_search_public_and_private`, `slack_search_users`
- **GCP secrets (app credentials):** `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, `SLACK_APP_ID`
  - Factory app: `SLACK_FACTORY_*` variants
  - SelfPrime app: `SLACK_SELFPRIME_*` variants
  - Webhooks: `SLACK_WEBHOOK_OPS`, `SLACK_WEBHOOK_REVENUE`, `SLACK_WEBHOOK_DELIVERY_KPIS`
- **Endpoint reachable:** ✅ `slack.com`

### Google Calendar
- **MCP server:** `mcp__72375a7d-e8b1-46dc-b7ca-fcac3e1be6fc`
- **Capabilities:** List calendars, create/update/delete/get events, suggest times, respond to invites
- **Key tools:** `list_calendars`, `list_events`, `create_event`, `update_event`, `suggest_time`
- **GCP secret (service account):** `GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON`

### Gmail
- **MCP server:** `mcp__8b79d5ac-f801-4aa4-98aa-a517052d114b`
- **Capabilities:** Read threads, create drafts, manage labels, search
- **Key tools:** `search_threads`, `get_thread`, `create_draft`, `list_labels`, `label_thread`

### Google Drive
- **MCP server:** `mcp__fd011596-013b-4e40-aa3f-4e9ee30ac492`
- **Capabilities:** Read, search, create, copy files; metadata and permissions
- **Key tools:** `list_recent_files`, `search_files`, `read_file_content`, `create_file`, `get_file_permissions`

### ClickUp
- **MCP server:** `mcp__2b04e471-8160-48b5-b926-0cd0aba0bd9a`
- **Capabilities:** Tasks, lists, folders, comments, time tracking, documents, chat
- **Key tools:** `clickup_get_workspace_hierarchy`, `clickup_create_task`, `clickup_update_task`, `clickup_filter_tasks`, `clickup_create_document`, `clickup_send_chat_message`

### HuggingFace
- **MCP server:** `mcp__8d9019bc-941f-4508-9a0c-44605d0181b1`
- **Capabilities:** Model/dataset/space search, paper search, hub queries, doc fetch
- **Key tools:** `hub_repo_search`, `paper_search`, `hf_hub_query`, `hf_doc_search`, `hf_whoami`
- **Fallback secret:** `HUGGINGFACE_API_TOKEN`
- **Authenticated as:** `adrper79`

---

## GCP-Only Services (no MCP)

Fetch credentials via `node scripts/gcp.mjs get <NAME>`, then use with SDK or curl.

### Anthropic / Claude API
- **Secrets:** `ANTHROPIC_API_KEY`, `ANTHROPIC_ADMIN_KEY`, `SELFPRIME_CLAUDE_API`
- **Endpoint reachable:** ✅ `api.anthropic.com`
- **Usage:** `x-api-key` header; `anthropic-version: 2023-06-01`

### OpenAI
- **Secret:** `FACTORY_OPENAI_TOKEN`
- **Endpoint reachable:** ✅ `api.openai.com`
- **Usage:** `Authorization: Bearer <token>`

### xAI / Grok
- **Secrets:** `FACTORY_XAI_TOKEN`, `GROK_API_KEY`, `GROK_GENERAL_API`, `GROK_WIB_API`
- **Endpoint reachable:** ✅ `api.x.ai`

### Groq
- **Secret:** `GROQ_API_KEY`
- **Endpoint reachable:** ✅ `api.groq.com`

### Google Vertex AI / Gemini
- **Secrets:** `LATIMERWOODS_GEMINI_KEY`, `VERTEX_SA_KEY`, `VERTEX_ACCESS_TOKEN`
- **Connection strings:** `GEMINI_PRODUCTION_CONNECTION_STRING`, `GEMINI_STAGING_CONNECTION_STRING`
- **Endpoint reachable:** ✅ `generativelanguage.googleapis.com`

### Resend (email delivery)
- **Secret:** `RESEND_API_KEY`
- **Endpoint reachable:** ✅ `api.resend.com`
- **Usage:** `Authorization: Bearer <key>`

### Loops (email marketing)
- **Secret:** `LOOPS_API_KEY`
- **Endpoint reachable:** ✅ `app.loops.so`

### ElevenLabs (text-to-speech)
- **Secrets:** `ELEVENLABS_API_KEY`
- **Voice IDs:** `ELEVENLABS_VOICE_DEFAULT`, `ELEVENLABS_VOICE_CYPHER`, `ELEVENLABS_VOICE_PRIME_SELF`
- **Endpoint reachable:** ✅ `api.elevenlabs.io`
- **Usage:** `xi-api-key` header

### Telnyx (voice/SMS/SIP)
- **Secrets (shared):** `TELNYX_API_KEY`, `TELNYX_CONNECTION_ID`, `TELNYX_PHONE_NUMBER`, `TELNYX_PUBLIC_KEY`
- **Secrets (per-app):** `SELFPRIME_TELNYX_API`, `THECALLING_TELNYX_API`, `WIB_TELNYX_API`, `XPELEVATOR_TELNYX_API`
- **Endpoint reachable:** ✅ `api.telnyx.com`
- **Usage:** Bearer auth

### Deepgram (speech-to-text)
- **Secret:** `FACTORY_DEEPGRAM_API`
- **Endpoint reachable:** unconfirmed (network not tested)
- **Usage:** `Authorization: Token <key>`

### PostHog (analytics)
- **Secrets:** `POSTHOG_API_KEY`, `POSTHOG_PROJECT_ID`, `POSTHOG_CIMD_SECRET`, `SELFPRIME_ANALYTICS_API`
- **Endpoint reachable:** ✅ `us.posthog.com`
- **Usage:** `Authorization: Bearer <key>`

### Mintlify (docs)
- **Secret:** `MINTLIFY_API`
- **Endpoint reachable:** ✅ `api.mintlify.com`

### Discord
- **Secrets:** `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`
- **Endpoint reachable:** ✅ `discord.com/api`
- **Usage:** `Authorization: Bot <token>`

### Apple OAuth
- **Secrets:** `APPLE_CLIENT_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, `APPLE_TEAM_ID`
- **Usage:** Sign in with Apple (SIWA) flows

### YouTube OAuth
- **Secrets:** `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`
- **Endpoint reachable:** ✅ `youtube.googleapis.com`

### Google OAuth (per-app)
- **Secrets:** `FACTORY_GOOGLE_CLIENT_ID`, `FACTORY_GOOGLE_SECRET`, `FACTORY_GOOGLE_API`
  - App variants: `SELFPRIME_GOOGLE_CLIENTID`, `SELFPRIME_GOOGLE_SECRET`, `CAPRICAST_OAUTH_CLIENTID`, `CAPRICAST_OAUTH_SECRET`

### BetterStack (uptime monitoring)
- **Secret:** `BETTERSTACK_API_TOKEN`
- **Endpoint reachable:** ✅ `uptime.betterstack.com`

### ChartMogul (revenue analytics)
- **Secret:** `CHARTMOGUL_API_TOKEN`
- **Endpoint reachable:** ✅ `api.chartmogul.com`

### News API
- **Secrets:** `NEWS_API_KEY`, `FACTORY_NEWS_API`
- **Endpoint reachable:** ✅ `newsapi.org`

### Namecheap (DNS/domains)
- **Secret:** `NAMECHEAP_API`

### NPM (package publishing)
- **Secret:** `NPM_TOKEN`
- **Usage:** `NODE_AUTH_TOKEN` for `.npmrc` or `npm publish --token`

### Cloudflare R2 (S3-compatible object storage)
- **Secrets:** `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_DOMAIN`
  - Browser agent bucket: `browser-agent-r2-access-key-id`, `browser-agent-r2-secret-access-key`
- **Preferred access:** Use Cloudflare MCP (`r2_buckets_list`) for management; use S3 SDK with R2 secrets for object read/write
- **Endpoint:** `https://<account-id>.r2.cloudflarestorage.com`

### GCP Secret Manager (self)
- **Auth:** `GCP_SA_KEY` env var (service account key, auto-injected)
- **Project:** `factory-495015`
- **SA:** `claude-code-agent@factory-495015.iam.gserviceaccount.com`
- **Commands:**
  ```bash
  node scripts/gcp.mjs list              # list all 181 secrets
  node scripts/gcp.mjs get <name>        # read a secret
  node scripts/gcp.mjs set <name> <val>  # create or update
  ```
- **Endpoint reachable:** ✅ `secretmanager.googleapis.com`

---

## Database Connections

Access via `DATABASE_URL` or app-specific connection strings from GCP. The Neon management API (`api.neon.tech`) is **not reachable** from this environment — use the connection strings directly.

| Secret | App |
|--------|-----|
| `DATABASE_URL` | Factory Core (primary) |
| `NEON_CONNECT_STRING` | Factory Core (alias) |
| `FACTORY_CONNECTION_STRING` | Factory Core worker |
| `PRIME_SELF_CONNECTION_STRING` | SelfPrime |
| `SELFPRIME_CONNECTION_STRING` | SelfPrime (alias) |
| `WORDISBOND_CONNECTION_STRING` | Wordis Bond |
| `WORDIS-BOND_NEON_CONNECTION_STRING` | Wordis Bond (alias) |
| `WORDIS_BOND_FACTORY_CONNECTION_STRING` | Wordis Bond factory worker |
| `THECALLING_CONNECTION_STRING` | The Calling |
| `THE_CALLING_FACTORY_CONNECTION_STRING` | The Calling factory worker |
| `CYPHEROFHEALING_CONNECTION_STRING` | Cypher of Healing |
| `HUMAN_DESIGN_CONNECTION_STRING` | Human Design |
| `KAIROSCOUNCIL_CONNECTION_STRING` | Kairos Council |
| `NICHESTREAM_CONNECTION_STRING` | NicheStream |
| `XPELEVATOR_CONNECTION_STRING` | XP Elevator |
| `MEXXICO_CITY_CONNECTION_STRING` | Mexico City |
| `GEMINI_PRODUCTION_CONNECTION_STRING` | Gemini (prod) |
| `GEMINI_STAGING_CONNECTION_STRING` | Gemini (staging) |

**Neon admin credentials:** `NEON_API`, `NEON_ORGANIZATION_ID`, `NEON_ORGANIZATION_KEY`

---

## Network Reachability Matrix

Tested from this remote execution environment.

| Service / Endpoint | Reachable |
|--------------------|-----------|
| `api.anthropic.com` | ✅ |
| `api.stripe.com` | ✅ |
| `api.resend.com` | ✅ |
| `api.elevenlabs.io` | ✅ |
| `api.telnyx.com` | ✅ |
| `us.posthog.com` | ✅ |
| `sentry.io` | ✅ |
| `api.cloudflare.com` | ✅ |
| `api.github.com` | ✅ |
| `secretmanager.googleapis.com` | ✅ |
| `oauth2.googleapis.com` | ✅ |
| `api.openai.com` | ✅ (untested, expected) |
| `api.x.ai` | ✅ (untested, expected) |
| `api.groq.com` | ✅ (untested, expected) |
| `api.neon.tech` | ❌ **BLOCKED** — use `DATABASE_URL` directly |

---

## Quick Lookup

```bash
# All available secrets (181 total)
node scripts/gcp.mjs list

# Fetch any credential
KEY=$(node scripts/gcp.mjs get ANTHROPIC_API_KEY)

# MCP tools are pre-authenticated — load schema with ToolSearch, then call directly
# Example: ToolSearch "select:mcp__c7520edb-d405-4501-9b49-4aaf62764431__workers_list"
```
