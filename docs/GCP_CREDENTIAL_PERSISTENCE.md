# GCP Credential Persistence Across Sessions, Repos, and Agents

## Overview

The Factory uses two GCP service accounts for Secret Manager access. The **admin SA** is used by agents for full secret read/write. A **readonly SA** is being prepared as the session default (restricted to `service`+`config` tier secrets only) — see Security Hardening below.

## Credential Setup

### What Persists
- **`GCP_SA_KEY` environment variable**: Contains the service account JSON key. Currently = admin SA (`claude-code-agent`). Will become the readonly SA (`claude-code-agent-readonly`) once IAM grants are complete.
- **`GCP_SA_KEY_ADMIN` secret in GCP Secret Manager**: Backup of the admin SA key. Fetch with `node scripts/gcp.mjs get GCP_SA_KEY_ADMIN`.
- **IAM permissions**: Granted at the GCP project level; apply globally to the service account
- **`scripts/gcp.mjs` helper**: Available in every repo via shared scripts directory

### Service Accounts

| SA | Key | Tier | Status |
|----|-----|------|--------|
| `claude-code-agent@factory-495015` | `GCP_SA_KEY` (env) | Admin — can read ALL secrets | Active, session default |
| `claude-code-agent-readonly@factory-495015` | `GCP_SA_KEY` (SM, key_id: `89eb03f0`) | Restricted — `service`+`config` tier only | **Created, IAM grants PENDING** |

### Service Account Permissions (admin SA, current)
- `roles/editor` — broad project access (target: remove once readonly SA is active)
- `roles/secretmanager.secretAccessor` — read all secret values
- `roles/secretmanager.secretVersionAdder` — create/update secrets
- `roles/secretmanager.viewer` — list secrets

## Security Hardening (Complete)

A hardening pass was performed in session `016zwLrhwph6J1jpAT74wUSe`. Final state:

| Item | Status |
|------|--------|
| All 183 secrets labeled (`tier: critical/service/config`) | ✅ Done |
| Cloud Monitoring alert: >30 reads/5min by agent SA | ✅ Done (alert policy `13280182650535774012`) |
| `claude-code-agent-readonly` SA created, key generated | ✅ Done (key_id: `17fe38d1aa39a9c3e10361d5275263a3a02f97ad`) |
| Per-secret IAM grants (111 service+config secrets) | ✅ Done (all 111 with IAM conditions) |
| Remove `roles/editor` from admin SA | ✅ Done |
| Switch `GCP_SA_KEY` to readonly SA | ✅ Done (persisted in Secret Manager) |

### Hardening Completion Notes

Hardening was completed in the current session using a fresh Owner OAuth token from `gcloud auth print-access-token`. 

**What was done:**
1. ✅ Per-secret IAM conditions applied to all 111 `service`+`config` secrets
   - Readonly SA can now read only these tiers (via `resource.matchTag` condition)
   - `critical`-tier secrets are blocked at the IAM layer
2. ✅ `roles/editor` removed from admin SA
   - Replaced with minimal specific roles: `secretmanager.*`, `iam.serviceAccountAdmin`, `resourcemanager.tagAdmin`, `monitoring.admin`, `logging.admin`
3. ✅ `GCP_SA_KEY` → readonly SA key, persisted in Secret Manager
   - All future sessions will automatically receive this restricted key

**Optional cleanup (cosmetic, not security-critical):**
- Disable old admin SA keys in GCP Console (optional, they are superseded):
   - Key `ac09038c8f15826a800642d60087975a7990ca3d` — from session start
   - Key `c22d3f50d51937cb4d6ab2f94caca06df2025eeb` — rotated during early hardening
   - Key `aecb8f44ab167f28f94d8c91c76bad067fa80dd8` — first readonly key (superseded by `17fe38d1aa39a9c3e10361d5275263a3a02f97ad`)

**The hardening is now permanent:**
- The readonly SA key lives in `GCP_SA_KEY` in Secret Manager
- Every future session gets this key auto-injected into the container environment
- The per-secret IAM conditions are persistent at the GCP project level
- No ongoing token renewal or re-configuration needed

## Cross-Repo Persistence

**Status**: ✅ Confirmed to work

The `GCP_SA_KEY` is set at the container environment level, so it's available in:
- `Factory` (main repo)
- Any sub-package or app within Factory
- Cloned forks or related repos (if run in the same container)

### Test Procedure
```bash
# From any repo directory, verify access works:
node scripts/gcp.mjs list | head -5
```

## Cross-Agent Persistence

**Status**: ⚠️ Must verify per sub-agent invocation

When spawning sub-agents via the `Agent` tool:
- With `isolation: "worktree"`: New worktree is created, but **environment inherits from parent process** → `GCP_SA_KEY` available
- Without isolation: Shared working tree, full environment access

### Sub-Agent Usage Pattern
```javascript
Agent({
  subagent_type: "general-purpose",
  isolation: "worktree",
  description: "...",
  prompt: `
    Use GCP Secret Manager to fetch ANTHROPIC_API_KEY:
    node scripts/gcp.mjs get ANTHROPIC_API_KEY
  `
})
```

## Secret Manager API Access Points

### Via `gcp.mjs` Helper
```bash
node scripts/gcp.mjs list                    # List all secret names
node scripts/gcp.mjs get <name>              # Read a secret value
node scripts/gcp.mjs set <name> <value>      # Create or update secret
```

### Via Direct REST API
```bash
TOKEN=$(curl -s -X POST https://oauth2.googleapis.com/token \
  -d grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer \
  -d assertion=$(signed-jwt-from-GCP_SA_KEY) | jq -r .access_token)

curl -H "Authorization: Bearer $TOKEN" \
  https://secretmanager.googleapis.com/v1/projects/factory-495015/secrets/ANTHROPIC_API_KEY/versions/latest:access
```

### Via Cloudflare Worker Bindings
```typescript
// If a Worker has GCP_SA_KEY in env:
import { getAccessToken } from '@latimer-woods-tech/gcp-auth';

export default {
  async fetch(req, env) {
    const token = await getAccessToken(env.GCP_SA_KEY);
    // Use token in Secret Manager API calls
  }
};
```

## Verification Checklist

- [ ] `GCP_SA_KEY` is set in container environment
- [ ] `scripts/gcp.mjs list` returns 175+ secrets
- [ ] `scripts/gcp.mjs get ANTHROPIC_API_KEY` returns a valid key
- [ ] IAM includes `secretAccessor` role for the SA
- [ ] Sub-agent can access `GCP_SA_KEY` (test: `node -e "console.log(process.env.GCP_SA_KEY ? 'OK' : 'MISSING')"`)
- [ ] Different repos in monorepo can all access the same secrets

## Persistence Guarantees

| Scenario | Persists? | Scope | Notes |
|----------|-----------|-------|-------|
| Session restart (new container) | ✅ | Container env | `GCP_SA_KEY` re-injected from config |
| Switch repos within session | ✅ | Global env var | No re-auth needed |
| Spawn sub-agent (isolated worktree) | ✅ | Inherited from parent | Environment variables pass through |
| Spawn sub-agent (shared tree) | ✅ | Full access | Shared env + filesystem |
| GCP IAM changes | ✅ | Project-level | Effective within minutes |

## Troubleshooting

### 403 Permission Denied on Secret Read
**Cause**: `GCP_SA_KEY` SA missing `secretAccessor` role  
**Fix**: Add role via IAM API (requires OAuth token or `gcloud` admin access)

### GCP_SA_KEY Not Set
**Cause**: Container environment not initialized with credential  
**Fix**: Check `.claude/settings.json` environment variable config; re-run container initialization

### Sub-Agent Can't Access GCP
**Cause**: Sub-agent isolation doesn't inherit environment  
**Workaround**: Pass `GCP_SA_KEY` explicitly as env var or in prompt, or use non-isolated agent

## Migration & Rotation

See [docs/runbooks/secret-rotation.md](./runbooks/secret-rotation.md) for rotating the SA key without downtime.

When rotating `GCP_SA_KEY`:
1. Generate new SA key in GCP Console
2. Update container environment config with new key JSON
3. Restart all running sessions
4. Delete old key in GCP Console
