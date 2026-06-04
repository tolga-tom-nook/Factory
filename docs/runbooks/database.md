# Database Runbook

This runbook covers the migration workflow, Neon branch strategy, and RLS testing for Factory apps.

## Architecture

Every Factory app gets an isolated **Neon project** (not just a schema). This ensures:
- No cross-app data leakage at the database level
- Independent scaling and compute pause per app
- Clean isolation during app transfer to a buyer

Connections from the Cloudflare Worker are routed through a **Hyperdrive** binding (`env.DB`) for connection pooling and latency reduction.

## Neon branch strategy

| Branch | Purpose |
|---|---|
| `main` | Production database |
| `staging` | Staging environment (branched from `main`) |
| Per-PR (optional) | Ephemeral branches for integration testing |

```bash
# Create a staging branch from main
neonctl branches create --project-id <PROJECT_ID> --name staging --parent main

# List branches
neonctl branches list --project-id <PROJECT_ID>

# Delete ephemeral branch after PR merge
neonctl branches delete <BRANCH_ID> --project-id <PROJECT_ID>
```

## Running migrations

Migrations live in `src/db/migrations/` as numbered SQL files (`001_init.sql`, etc.).

### Apply manually

```bash
# Set connection string
export DATABASE_URL="postgresql://user:pass@host/db?sslmode=require"

# Run a specific migration
psql $DATABASE_URL -f src/db/migrations/001_init.sql

# Run all pending migrations (if using Drizzle Kit)
npx drizzle-kit migrate
```

### Apply via CI

The `migrate.yml` workflow runs on push to `main` and applies migrations automatically using the `DATABASE_URL` GitHub secret.

```yaml
- name: Run migrations
  run: npx drizzle-kit migrate
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
```

## Inspecting the schema

```bash
# Using Drizzle Kit
npx drizzle-kit introspect

# Or psql
psql $DATABASE_URL -c '\dt'
psql $DATABASE_URL -c '\d+ factory_events'
```

## Factory events table

Each app maintains its own `factory_events` table inside its **own isolated Neon database**. The schema is identical across all apps (shared DDL from the scaffold), but there is no central database — each app writes and queries its own events independently via `@latimer-woods-tech/analytics`.

A future `factory_core` Neon project will aggregate events across all apps when `factory-admin` is built. Until then, cross-app analytics require querying each app's database separately.

```sql
CREATE TABLE IF NOT EXISTS factory_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id      TEXT        NOT NULL,
  event       TEXT        NOT NULL,
  user_id     TEXT,
  properties  JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS factory_events_app_id_idx
  ON factory_events (app_id, created_at DESC);
```

## Row-Level Security (RLS)

Factory apps use RLS to isolate tenant data when multiple tenants share a table.

### Enabling RLS

```sql
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- Policy: users can only see their own tenant's rows
CREATE POLICY tenant_isolation ON users
  USING (tenant_id = current_setting('app.tenant_id', true));
```

### Setting the tenant context per request

```typescript
import { createDb, sql } from '@latimer-woods-tech/neon';

const db = createDb(env.DB);

// Set tenant context before query
await db.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
const rows = await db.execute(sql`SELECT * FROM users`);
```

### Testing RLS in development

```sql
-- Simulate tenant A
SET app.tenant_id = 'tenant-a';
SELECT * FROM users; -- should only return tenant-a rows

-- Confirm isolation
SET app.tenant_id = 'tenant-b';
SELECT * FROM users; -- should only return tenant-b rows (or nothing)
```

## Backup and restore

Neon provides continuous branching which doubles as PITR (Point-in-Time Recovery). For explicit backups:

```bash
# Dump production
pg_dump $DATABASE_URL > {app}_$(date +%Y%m%d).sql

# Restore to a Neon branch
psql $STAGING_DATABASE_URL < {app}_20250101.sql
```

## Neon connection strings

Connection strings follow this format:
```
postgresql://{user}:{password}@{host}/{database}?sslmode=require
```

### Getting a WORKING string (you have operator access — use it)

Do **not** assume you lack DB access, and do **not** trust the stored
`*_CONNECTION_STRING` secrets blindly — they drift (rotated password not
propagated to GCP) and several carry a leading UTF-8 BOM. Mint a fresh one:

```bash
# Neon API key lives in GCP Secret Manager (strip CR/LF + BOM):
export NEON_API_KEY="$(gcloud secrets versions access latest \
  --secret=NEON_ORGANIZATION_KEY --project=factory-495015 | tr -d '\r\n\357\273\277')"

# Project ids (org id is org-withered-wave-19602339):
npx --yes neonctl projects list --org-id org-withered-wave-19602339
#   selfprime.net → divine-grass-42421088   (branch: production)

# Mint a fresh, live-password connection string (neondb_owner bypasses RLS):
npx --yes neonctl connection-string production \
  --project-id <PROJECT_ID> --database-name neondb --role-name neondb_owner
```

Symptoms that mean "stale secret — mint fresh instead of debugging":
`password authentication failed` (rotated pw) or `is not a valid URL`
(leading BOM — strip with `while (cs.charCodeAt(0) !== 0x70) cs = cs.slice(1)`).

See [lessons-learned.md → "You HAVE Neon access"](./lessons-learned.md) for the full rationale.

### Storing for an app

Store in GitHub Secrets as `{APP}_CONNECTION_STRING` and pass to Wrangler:

```bash
wrangler secret put DATABASE_URL --name {app}
# paste the connection string when prompted
```

## Hyperdrive setup

```bash
# Create Hyperdrive binding (one-time)
wrangler hyperdrive create {app}-db --connection-string "$DATABASE_URL"

# Copy the returned ID to wrangler.jsonc
```

```jsonc
// wrangler.jsonc
{
  "hyperdrive": [
    {
      "binding": "DB",
      "id": "<hyperdrive-id>"
    }
  ]
}
```
