# Admin UI Agent: Full Capability Plan

**Date:** 2026-05-27  
**Objective:** Enable the admin-studio AI agent to replace Sauna (Claude Code session) by giving it full access to the repo, GCP secrets, and external MCPs.

**Status:** ✅ Shipped — all 4 phases live in `main` (verified 2026-06-01; status was stale).

> **Verification (2026-06-01):**
> - **Phase 1** — `FACTORY_OWNER = 'Latimer-Woods-Tech'` in `apps/admin-studio/src/lib/github-api.ts`.
> - **Phase 2** — agentic tool-use loop live in `apps/admin-studio/src/routes/ai.ts` (`AGENT_TOOLS`, `tool_use` handling); multi-repo tools added via #1231.
> - **Phase 3** — `apps/admin-studio/src/lib/gcp-secrets.ts` exists; `GCP_SA_KEY` wired via the deploy workflow (#1239 / #1240).
> - **Phase 4** — smoke green; command-center returns live data (#1231).
>
> The unchecked `[ ]` boxes below are historical and are left as the original plan record.

---

## Executive Summary

The factory admin UI AI agent currently has zero tool access — it can only generate text. It's hardcoded to the wrong GitHub repo (`adrper79-dot/factory` instead of `Latimer-Woods-Tech/Factory`), has no GCP Secret Manager integration, and is missing required environment variables.

This plan implements 4 phases to make the agent fully autonomous:
1. **Phase 1:** Fix repo owner (1 file, 1 line)
2. **Phase 2:** Implement Anthropic tool-use loop (agentic capability)
3. **Phase 3:** Wire GCP Secret Manager to the Worker
4. **Phase 4:** Fix smoke red + FACTORY_DB placeholder

**Expected outcome:** An agent accessible 24/7 via the admin UI that can autonomously read issues, PRs, code, logs, secrets, and deploy without human context switches.

---

## Phase 1: Fix Repo Owner Bug

**File:** `apps/admin-studio/src/lib/github-api.ts`  
**Risk:** Minimal (configuration-only)  
**Time:** 15 minutes

### Change
```diff
- const FACTORY_OWNER = 'adrper79-dot';
+ const FACTORY_OWNER = process.env.GITHUB_OWNER || 'Latimer-Woods-Tech';

- const FACTORY_REPO = 'factory';
+ const FACTORY_REPO = process.env.GITHUB_REPO || 'factory';
```

**Why:** The hardcoded personal fork breaks all GitHub API calls when the canonical repo is the org repo. Making it configurable via env vars allows per-environment routing.

**Verification:**
- [ ] `npm run typecheck` in admin-studio passes
- [ ] `npm test` passes
- [ ] Deploy to staging
- [ ] Test with `curl https://admin-staging.latwoodtech.work/api/repos/tree` returns org repo structure

---

## Phase 2: Implement Tool-Use Loop in `/ai/chat`

**File:** `apps/admin-studio/src/routes/ai.ts`  
**Risk:** Medium (architectural refactor)  
**Time:** 2–3 hours

### What changes
Replace single `complete()` call with **agentic tool-use loop** using Anthropic `tools` parameter.

### New tools to expose

| Tool | Endpoint | Purpose |
|---|---|---|
| `github_read_file` | GitHub REST API | Read any file in repo |
| `github_list_issues` | GitHub REST API | List open issues filtered by label/state |
| `github_read_pr` | GitHub REST API | Fetch PR details + reviews |
| `github_list_workflows` | GitHub REST API | Check CI run status |
| `sentry_list_issues` | Sentry REST API | List live errors by project |
| `sentry_get_issue` | Sentry REST API | Fetch error details + stack |
| `cloudflare_list_workers` | Cloudflare API | List deployed workers |
| `cloudflare_get_deploy_history` | Cloudflare API | Check last deployment timestamps |
| `neon_query` | Hyperdrive (DB binding) | Query factory_events, video_calendar |
| `gcp_get_secret` | GCP Secret Manager | Read any GCP secret by name |
| `posthog_query` | PostHog HogQL API | Engagement metrics |

### Loop logic
```typescript
async function agentic_chat(request: AIChatRequest, env: Env): Promise<SSEStream> {
  const systemPrompt = await loadFactoryContext(env.GITHUB_TOKEN);
  const messages = [{ role: 'user', content: request.text }];
  const tools = defineTools(); // ← new

  while (true) {
    const response = await complete({
      system: systemPrompt,
      messages,
      tools, // ← pass tools array
      maxTokens: 2048,
    });

    if (response.stopReason === 'tool_use') {
      // Execute the tool, append result, loop
      const toolCall = response.content.find(b => b.type === 'tool_use');
      const result = await executeTool(toolCall.name, toolCall.input);
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: { type: 'tool_result', tool_use_id: toolCall.id, content: result } });
      continue;
    }

    // Model returned text — stream it
    for await (const chunk of response) {
      yield chunk;
    }
    break;
  }
}
```

### Implementation checklist
- [ ] Define `Tool[]` interface matching Anthropic's schema
- [ ] Implement each tool's `fetch` call
- [ ] Add tool-result loop to main chat handler
- [ ] Update `@latimer-woods-tech/studio-core` types if needed
- [ ] Test with manual `/ai/chat` call using a simple tool
- [ ] Verify SSE streaming still works
- [ ] Update error handling for tool failures
- [ ] Add logging for tool execution

---

## Phase 3: Wire GCP Secret Manager to Worker

**File:** `apps/admin-studio/src/lib/gcp-secrets.ts` (new)  
**Risk:** Low (isolated, cryptographic code)  
**Time:** 1 hour

### Implementation
1. **Decode the SA key** from base64 env var `GCP_SA_KEY`
2. **Sign a JWT** using the SA's private key (Web Crypto RSASSA-PKCS1-v1_5)
3. **Mint an OAuth2 token** by POSTing the JWT to `https://oauth2.googleapis.com/token`
4. **Call Secret Manager** with the token to fetch any secret

```typescript
export async function gcpGetSecret(
  secretName: string,
  env: { GCP_SA_KEY: string },
): Promise<string> {
  const saKey = JSON.parse(atob(env.GCP_SA_KEY));
  const token = await mintGcpToken(saKey);
  const url = `https://secretmanager.googleapis.com/v1/projects/${saKey.project_id}/secrets/${secretName}/versions/latest:access`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await res.json()) as { payload?: { data?: string } };
  return atob(data.payload?.data ?? '');
}

async function mintGcpToken(saKey: ServiceAccountKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = createJwt(saKey, now);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const { access_token } = (await res.json()) as { access_token: string };
  return access_token;
}
```

### Checklist
- [ ] Create `src/lib/gcp-secrets.ts` with `gcpGetSecret()`
- [ ] Implement JWT signing using Web Crypto `crypto.subtle.sign()`
- [ ] Test locally (mock SA key)
- [ ] Add `gcp_get_secret` to tool definitions
- [ ] Document secret naming convention (e.g., `NEON_FACTORY_DATABASE_URL` → `neon-factory-database-url`)
- [ ] Store `GCP_SA_KEY` via `wrangler secret put --env staging`

---

## Phase 4: Fix Smoke Red + FACTORY_DB

**Files:** `apps/admin-studio/wrangler.jsonc`, `apps/admin-studio/src/routes/ai.ts`  
**Risk:** Low (env config + fallback logic)  
**Time:** 1 hour

### 4a. Make AI_GATEWAY_BASE_URL optional
**Change in `src/routes/ai.ts`:**
```typescript
// Before: AI_GATEWAY_BASE_URL required, return 503 if absent
if (!env.AI_GATEWAY_BASE_URL) return new Response('503 Service Unavailable', { status: 503 });

// After: graceful fallback
const missing = getMissingCompleteLlmConfig(env);
// Only error on ANTHROPIC_API_KEY + Vertex creds; AI_GATEWAY_BASE_URL is optional
if (!env.ANTHROPIC_API_KEY) {
  return errorResponse('ANTHROPIC_API_KEY is required');
}
// AI_GATEWAY_BASE_URL absence is handled inside the @latimer-woods-tech/llm package
```

### 4b. Replace FACTORY_DB placeholder
**Get the real UUID:**
1. Query GCP Secret Manager for `NEON_FACTORY_DATABASE_URL` (from Phase 3)
2. Parse the connection string to get the Neon project ID
3. Run: `wrangler hyperdrive list` to find or create the binding
4. **If not found:** Run `wrangler hyperdrive create factory-db-staging --connection-string <THE_FACTORY URL>`
5. Update `wrangler.jsonc` staging env:
```json
"hyperdrive": [
  { "binding": "DB", "id": "efe957f404bb457593e6bd08b733b7c4" },
  { "binding": "FACTORY_DB", "id": "NEW_REAL_UUID_HERE" }
]
```

### 4c. Verify smoke probe is green
After Phase 1 deploys, re-run the smoke test:
```bash
curl https://admin-staging.latwoodtech.work/health
# Should return 200 OK
```

### Checklist
- [ ] Verify `ANTHROPIC_API_KEY` is set as a Worker secret
- [ ] Update error handling in `/ai/chat` to gracefully handle missing `AI_GATEWAY_BASE_URL`
- [ ] Get real `FACTORY_DB` Hyperdrive UUID
- [ ] Update `wrangler.jsonc` with real UUID
- [ ] Redeploy and verify `/api/command-center` returns real data (not empty)

---

## Rollout Sequence

```
Session 1:
  [ ] Phase 1 — Fix FACTORY_OWNER (15 min, commit, deploy staging, test)
  [ ] Phase 2 — Tool-use loop (2-3 hrs, commit, test locally)
  
Session 2 (if needed):
  [ ] Phase 3 — GCP Secret Manager (1 hr, store secret, test)
  [ ] Phase 4 — Smoke + FACTORY_DB (1 hr, update config, deploy, verify)
```

---

## Definition of Done

- [ ] Phase 1: Repo calls target `Latimer-Woods-Tech/Factory`
- [ ] Phase 2: `/ai/chat` with a simple prompt returns a tool call and executes it
- [ ] Phase 3: Agent can read a GCP secret via `gcp_get_secret` tool
- [ ] Phase 4: Smoke passes, `/api/command-center` returns non-empty data
- [ ] All changes committed to `claude/charming-hamilton-XKOVK`
- [ ] Staging deployment successful with no new errors in Sentry

---

## Known constraints
- **Worker limits:** 50ms CPU time per request; tool calls must complete fast (cache results in KV if needed)
- **No Node.js:** All tool implementations via `fetch` only; no `node:crypto` or `jsonwebtoken`
- **Web Crypto only:** JWT signing uses `crypto.subtle`
- **Token budget:** Anthropic API costs ~$0.003 per 1M input tokens; agent loop may need rate limiting

---

## Success metrics
1. Agent can autonomously list open P0/P1 issues
2. Agent can fetch a PR, read its diff, and propose a fix
3. Agent can query Sentry for live errors
4. Agent can check last deployment time via Cloudflare API
5. Agent can fetch a GCP secret without human intervention
