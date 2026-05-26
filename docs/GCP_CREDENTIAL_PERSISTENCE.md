# GCP Credential Persistence Across Sessions, Repos, and Agents

## Overview

The Factory uses a single GCP service account (`claude-code-agent@factory-495015.iam.gserviceaccount.com`) for all GCP API access across all repositories and sub-agents. Credentials persist at the **container environment level**, not per-repo or per-agent.

## Credential Setup

### What Persists
- **`GCP_SA_KEY` environment variable**: Contains the service account JSON key (with outer braces stripped for compact storage)
- **IAM permissions**: Granted at the GCP project level; apply globally to the service account
- **`scripts/gcp.mjs` helper**: Available in every repo via shared scripts directory

### Service Account Permissions
- `roles/secretmanager.secretAccessor` — read secret values
- `roles/secretmanager.secretVersionAdder` — create/update secrets
- `roles/secretmanager.viewer` — list secrets
- Plus broad editor-level permissions for other GCP services

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
