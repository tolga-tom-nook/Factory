# Add a New Standalone App

Use this runbook when onboarding a brand-new Factory app that is **not** one of the original 6 apps (wordis-bond, cypher-healing, prime-self, ijustus, the-calling, neighbor-aid). New apps use a standalone per-app workflow pattern rather than the bulk scripts (`setup-all-apps.mjs`, `scaffold-all-apps.yml`).

## Rate Limiter ID Registry

Each app gets a **unique** Cloudflare rate limiter namespace ID. IDs are integers; never reuse one.

| App | Binding | Namespace ID | Limit | Notes |
|-----|---------|--------------|-------|-------|
| wordis-bond | (auth) | 1001 | per-app | |
| prime-self | (auth) | 1002 | per-app | |
| cypher-healing | (auth) | 1003 | per-app | |
| ijustus | (auth) | 1004 | per-app | |
| the-calling | (auth) | 1005 | per-app | |
| neighbor-aid | (auth) | 1006 | per-app | |
| xpelevator | (auth) | 1007 | per-app | |
| xico-city (prod) | `AUTH_RATE_LIMITER` | 1008 | 60/m/IP | Auth routes |
| xico-city (prod) | `API_RATE_LIMITER` | 1009 | 600/m/user | `/v1/*` authed routes — closes BUILD_PLAN_v2 D-007 |
| xico-city (staging) | `AUTH_RATE_LIMITER` | 1010 | 60/m/IP | Staging auth (separated from prod) |
| xico-city (staging) | `API_RATE_LIMITER` | 1011 | 600/m/user | Staging `/v1/*` |
| status-prober | `STATUS_RATE_LIMITER` | 1012 | 120/m | Public `/current` + `/health` read endpoints |
| agent-gateway (prod) | `RATE_LIMITER` | 1013 | per-tenant (JWT sub) | `/sessions/*` agent session routes — Agent Runtime Phase 3 |

**Next available ID: 1014**

Allocate **separate ids per environment** so a misconfigured staging worker
cannot exhaust the prod rate-limit budget. Update this table every time a new
app or environment is added.

---

## Prerequisites

Before starting:

- [ ] Neon project created for this app
- [ ] Connection string stored as a GitHub Secret in `Latimer-Woods-Tech/factory`: `{APP_UPPER}_CONNECTION_STRING`
  - Example: app `xico-city` → secret `MEXXICO_CITY_CONNECTION_STRING`
- [ ] `CF_API_TOKEN` set in Factory GitHub Secrets
- [ ] `GH_PAT` (classic PAT with `repo` + `read:packages`) set in Factory GitHub Secrets
- [ ] GitHub repo created: `gh repo create Latimer-Woods-Tech/{app} --private`

---

## Step 1 — Add App to Factory Scripts

Edit **three files** in `packages/deploy/scripts/`:

### 1a. `create-hyperdrive.mjs`

Add an entry to the `CONFIGS` array:

```js
{ envKey: '{APP_UPPER}_ID', name: '{app}-db', conn: process.env.{APP_UPPER}_CONN },
```

### 1b. `write-schema.mjs`

Add a schema entry to the `SCHEMAS` object with the app's canonical Drizzle ORM schema.

### 1c. `add-app-deps.mjs`

Add an entry specifying which `@latimer-woods-tech/*` packages the app uses beyond the defaults:

```js
'{app}': ['@latimer-woods-tech/stripe'],  // only extras needed
```

---

## Step 2 — Update `create-hyperdrive.yml`

In `.github/workflows/create-hyperdrive.yml`, add:

1. **Env var** in the `Create Hyperdrive instances` step:
   ```yaml
   {APP_UPPER}_CONN: ${{ secrets.{APP_UPPER}_CONNECTION_STRING }}
   ```

2. **Store step** (even though it will fail with 403 — the log still captures the UUID):
   ```yaml
   store HYPERDRIVE_{APP_UPPER} "${{ steps.hyperdrive.outputs.{APP_UPPER}_ID }}"
   ```

---

## Step 3 — Create Standalone Workflow Files

Create two new files in `.github/workflows/`:

### `scaffold-{app}.yml`

Copy `scaffold-xpelevator.yml` and replace all occurrences of `xpelevator` with `{app}`, then:
- Set the correct rate limiter ID (from the registry above)
- Leave `--hyperdrive-id` as a placeholder (`"REPLACE_AFTER_STEP_4"`) until Step 4

### `setup-{app}-secrets.yml`

Copy `setup-xpelevator-secrets.yml` and replace all occurrences of `xpelevator` with `{app}`.
- The JWT secret references `JWT_SECRET_{APP_UPPER}` — add this to Factory GitHub Secrets before running
- The Sentry DSN references `SENTRY_DSN_{APP_UPPER}` — add this to Factory GitHub Secrets before running

---

## Step 4 — Commit, Push, Create Hyperdrive

```bash
git add packages/deploy/scripts/create-hyperdrive.mjs \
        packages/deploy/scripts/write-schema.mjs \
        packages/deploy/scripts/add-app-deps.mjs \
        .github/workflows/create-hyperdrive.yml \
        .github/workflows/scaffold-{app}.yml \
        .github/workflows/setup-{app}-secrets.yml
git commit -m "feat(deploy): add {app} \u2014 hyperdrive, schema, workflows"
```

Push (use the GCM workaround on Windows):
```powershell
$token = gh auth token
$encoded = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$token"))
git -c credential.helper="" -c "http.extraheader=Authorization: Basic $encoded" push origin main
```

Then trigger the Hyperdrive creation workflow:
```bash
gh workflow run create-hyperdrive.yml --repo Latimer-Woods-Tech/factory
```

---

## Step 5 — Extract Hyperdrive UUID from Logs

The "Store" step will fail with 403 (expected — see [lessons-learned.md](./lessons-learned.md#error-create-hyperdrive-workflow-store-step-fails-with-403)). Get the UUID from the successful "Create" step:

```bash
RUN_ID=$(gh run list --repo Latimer-Woods-Tech/factory --workflow create-hyperdrive.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run view $RUN_ID --repo Latimer-Woods-Tech/factory --log | grep "{app}-db ->"
# Output: [created] {app}-db -> <UUID>
```

Then:
1. Hard-code the UUID in `scaffold-{app}.yml`
2. Store it as a Factory secret:
   ```bash
   echo "<UUID>" | gh secret set HYPERDRIVE_{APP_UPPER} --repo Latimer-Woods-Tech/factory
   ```
3. Commit and push the updated scaffold workflow

---

## Step 6 — Add Required Secrets to Factory

Before running the scaffold and secrets workflows, ensure these exist in `Latimer-Woods-Tech/factory` GitHub Secrets:

| Secret | Description |
|--------|-------------|
| `JWT_SECRET_{APP_UPPER}` | Random 32-byte base64 string for this app's JWT signing |
| `SENTRY_DSN_{APP_UPPER}` | Sentry DSN for this app's Sentry project |

Generate JWT secret:
```bash
openssl rand -base64 32 | gh secret set JWT_SECRET_{APP_UPPER} --repo Latimer-Woods-Tech/factory
```

---

## Step 7 — Run Scaffold and Secrets Workflows

```bash
# 1. Scaffold the app repo
gh workflow run scaffold-{app}.yml --repo Latimer-Woods-Tech/factory

# Wait for completion
gh run watch $(gh run list --repo Latimer-Woods-Tech/factory --workflow scaffold-{app}.yml --limit 1 --json databaseId --jq '.[0].databaseId') --repo Latimer-Woods-Tech/factory --exit-status

# 2. Verify scaffold succeeded
gh api repos/Latimer-Woods-Tech/{app}/contents/src/index.ts --jq '.name'
# Expected: "index.ts"

# 3. Wire secrets to the app repo and Worker
gh workflow run setup-{app}-secrets.yml --repo Latimer-Woods-Tech/factory
```

---

## Step 8 — Update This Registry

Add the new app and its rate limiter ID to the registry table at the top of this file. Commit the update.

---

## Checklist Summary

- [ ] Rate limiter ID reserved (next available: 1012+)
- [ ] Neon connection string in Factory Secrets as `{APP_UPPER}_CONNECTION_STRING`
- [ ] GitHub repo created: `Latimer-Woods-Tech/{app}`
- [ ] `create-hyperdrive.mjs` updated
- [ ] `write-schema.mjs` updated with canonical Drizzle schema
- [ ] `add-app-deps.mjs` updated with app-specific package deps
- [ ] `create-hyperdrive.yml` updated with new env var + store step
- [ ] `scaffold-{app}.yml` created
- [ ] `setup-{app}-secrets.yml` created
- [ ] All changes committed and pushed
- [ ] `create-hyperdrive.yml` workflow triggered; UUID extracted from logs
- [ ] UUID hard-coded in scaffold workflow + stored as `HYPERDRIVE_{APP_UPPER}` secret
- [ ] `JWT_SECRET_{APP_UPPER}` added to Factory Secrets
- [ ] `SENTRY_DSN_{APP_UPPER}` added to Factory Secrets
- [ ] `scaffold-{app}.yml` workflow run successfully
- [ ] `setup-{app}-secrets.yml` workflow run successfully
- [ ] Rate limiter registry table updated in this file
- [ ] Update `github-secrets-and-tokens.md` to include new app in the app list
- [ ] Create `.github/repo-contexts/{app}/CLAUDE.md` with the repo's standing orders (stack, hard constraints, surfaces, commit format). The CI `validate` job will fail until this file exists — see coh or humandesign for examples.
