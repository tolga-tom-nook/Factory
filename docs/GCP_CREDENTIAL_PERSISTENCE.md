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

## Security Hardening (Partially Complete)

A hardening pass was performed in session `016zwLrhwph6J1jpAT74wUSe`. Current state:

| Item | Status |
|------|--------|
| All 181 secrets labeled (`tier: critical/service/config`) | ✅ Done |
| Cloud Monitoring alert: >30 reads/5min by agent SA | ✅ Done (alert policy `13280182650535774012`) |
| `claude-code-agent-readonly` SA created, key generated | ✅ Done (key_id: `89eb03f0`) |
| Per-secret IAM grants (111 service+config secrets) | ❌ **PENDING — Owner OAuth token required** |
| Remove `roles/editor` from admin SA | ❌ **PENDING — Owner OAuth token required** |
| Switch `GCP_SA_KEY` (env) to readonly SA | ❌ **PENDING — must happen after IAM grants** |

### To Complete Hardening (requires Owner OAuth token)

**In Cloud Shell or any terminal with `gcloud` and Owner access:**
```bash
# Get a fresh token (expires in 1 hour)
gcloud auth print-access-token
```

**Then paste the token into the session and run:**
```bash
# Step 2: grants secretAccessor on all service+config secrets to the readonly SA
node scripts/gcp-harden.mjs --step=2 --oauth=<token>

# Step 4: removes roles/editor from admin SA, adds specific replacement roles
node scripts/gcp-harden.mjs --step=4 --oauth=<token>
```

**IMPORTANT**: `gcloud auth print-access-token` must be run in a terminal where `gcloud auth login` was completed with the project Owner account (`adrper79@gmail.com`). Do NOT use a token obtained via GCP Console browser UI — it may have `ACCESS_TOKEN_TYPE_UNSUPPORTED` for Direct API calls.

**After hardening completes:**
1. Update Claude Code env config: set `GCP_SA_KEY` to the readonly SA key from `node scripts/gcp.mjs get GCP_SA_KEY` (this will be the restricted key once IAM grants are in)
2. Disable old admin SA keys in GCP Console:
   - Key `ac09038c8f15826a800642d60087975a7990ca3d` — original key from session start
   - Key `c22d3f50d51937cb4d6ab2f94caca06df2025eeb` — rotated during hardening

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
