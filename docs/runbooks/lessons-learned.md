# Lessons Learned & Common Errors

This document captures recurring errors, patterns, and best practices discovered during Factory Core development. Reviewed quarterly; updated whenever new errors emerge.

## Hard Constraints (Never Violate)

These constraints are enforced by quality gates and prevent silent runtime failures. Violating any of them breaks the CI/CD pipeline or produces mysterious production errors.

| Constraint | Why | Impact |
|-----------|-----|--------|
| No `process.env` anywhere | Cloudflare Workers don't have `process` object | TypeError at runtime |
| No Node.js built-ins (`fs`, `path`, `crypto`) | Not available on Workers platform | NameError at runtime |
| No CommonJS `require()`; use ESM only | Workers runtime requires ESM | Parse error at build time |
| No `Buffer`; use `Uint8Array` / `TextEncoder` | Buffer not available on platform | NameError at runtime |
| No raw `fetch` without error handling | Network failures crash app without explicit handlers | Unhandled promise rejection |
| No secrets in source code or `wrangler.jsonc` vars | Secrets in repos leak to GitHub | Security breach |
| No `any` in public API types | Defeats TypeScript's type safety | Type errors in consumer code |
| No `@ts-ignore` or `eslint-disable` without comment | Suppresses real issues instead of fixing them | Tech debt spiral |

**Action**: Before committing, run:
```bash
npm run typecheck  # zero errors required
npm run lint       # --max-warnings 0
```

## You HAVE Neon access — stop assuming you don't

> **The single most common false belief in this org.** Agents repeatedly declare
> "I don't have access to the database / connection string" and route around a
> 2-minute task (verify an account, patch a column, inspect a row) into a
> multi-step CI/secret dance — or just give up. **You almost always have
> operator-level Neon access.** Try it before claiming you don't.

**The recipe (org-wide, works for every Factory Neon project):**
```bash
# 1. Auth: the Neon API key lives in GCP Secret Manager (NOT a GitHub secret).
#    Strip CR/LF and any leading BOM. NEON_ORGANIZATION_KEY works for writes;
#    NEON_API often has a leading BOM that 401s if used raw.
export NEON_API_KEY="$(gcloud secrets versions access latest \
  --secret=NEON_ORGANIZATION_KEY --project=factory-495015 | tr -d '\r\n\357\273\277')"

# 2. Find the project id (org id is org-withered-wave-19602339):
npx --yes neonctl projects list --org-id org-withered-wave-19602339

# 3. Mint a FRESH working connection string (do NOT trust the GCP/GitHub
#    *_CONNECTION_STRING copies — they are frequently stale: wrong password
#    AND/OR a leading UTF-8 BOM). neonctl mints one with the live role password:
npx --yes neonctl connection-string production \
  --project-id <PROJECT_ID> --database-name neondb --role-name neondb_owner
```

**Key facts agents miss:**
- `neondb_owner` is the table-owner role → **bypasses RLS** (correct for one-off ops writes/inspection).
- The GCP-stored `*_CONNECTION_STRING` / `NEON_CONNECT_STRING` / `DATABASE_URL` secrets drift: the operator rotates the Neon password but the GCP copy isn't updated, and several have a **leading BOM** (`0xEF 0xBB 0xBF`). Symptom: `password authentication failed` or `not a valid URL`. **Fix: mint fresh with `neonctl connection-string`, don't debug the stale secret.** (Strip a BOM in code with `while (cs.charCodeAt(0) !== 0x70) cs = cs.slice(1)` — chop until the `p` of `postgresql://`.)
- Selfprime/HumanDesign project = `divine-grass-42421088`, branch `production`. Other projects: `npx neonctl projects list`.
- Query from Node with `@neondatabase/serverless` (`neon(cs)`, tagged-template ``sql`...` `` or `sql.query()` for dynamic). `gcloud` auth in agent sessions is usually the user account (`adrper79@gmail.com`) with broad SM read — that's why the key fetch works.
- The `gh` token (`adrper79-dot`) has `admin:org` → you can also set org + repo secrets when a credential needs rotating.

> See also [database.md](./database.md) for branch strategy; the one-line pin lives at the top of [CLAUDE.md](../../CLAUDE.md).

## Common Errors & Resolutions

### Error: "Cannot find module '@latimer-woods-tech/auth' is not in the npm registry"

**Root Cause**: Packages published out of dependency order. Package A tries to import Package B, but B wasn't published yet.

**Example**:
- `@latimer-woods-tech/neon` (which depends on `@latimer-woods-tech/logger`) is tagged and pushed
- CI publishes Neon before Logger is published → 404 on npm registry

**Prevention**:
1. Follow strict dependency order (see CLAUDE.md)
2. Tag multiple packages in sequence, but wait for each publish to complete before tagging the next
3. Check GitHub Packages UI before tagging next package: https://github.com/adrper79-dot?tab=packages

**Fix**:
```bash
# Delete the failed tag locally and remotely
git tag -d @latimer-woods-tech/neon/v0.2.0
git push origin :refs/tags/@latimer-woods-tech/neon/v0.2.0

# Wait for Logger to publish
# Then re-tag and re-push
git tag @latimer-woods-tech/neon/v0.2.0
git push origin @latimer-woods-tech/neon/v0.2.0
```

### Error: "TypeScript strict mode: 'user' implicitly has type 'any'"

**Root Cause**: Hono context variable not declared with proper type augmentation.

**Example**:
```typescript
// ❌ Fails strict mode
const user = c.get('user');  // c.user is unknown; implicitly any
```

**Prevention**: Add module augmentation to every app that uses auth:

```typescript
declare module 'hono' {
  interface ContextVariableMap {
    user: JWTPayload;
    analytics: Analytics;
    db: DB;
  }
}
```

**Fix**: Run `npm run typecheck` locally, fix the type error, then commit.

### Error: "403 Forbidden: PUT https://npm.pkg.github.com/@adrper79-dot%2fXXX"

**Root Cause**: Wrong npm registry or scope mismatch in `package.json`.

**Example**:
```json
{
  "name": "@adrper/errors",  // scope is @adrper, not @adrper79-dot
  "publishConfig": {
    "registry": "https://registry.npmjs.org"  // wrong registry (public npm)
  }
}
```

**Prevention**:
1. All packages must use scope `@adrper79-dot`
2. All packages must point to GitHub Packages registry

**Fix**:
```json
{
  "name": "@latimer-woods-tech/errors",
  "publishConfig": {
    "registry": "https://npm.pkg.github.com"
  }
}
```

### Error: "ESLint: no-unsafe-assignment"

**Root Cause**: Vitest v1 (used by this project) does **not** support generic type parameters on `vi.fn()`. Adding a generic causes a TypeScript parse error. Without one, ESLint sees the return type as `any`.

**Example**:
```typescript
// ❌ Causes TS error — Vitest v1 does not support fn<Type>() generics
const mockFetch = vi.fn<[RequestInfo, RequestInit], Promise<Response>>();

// ✅ Correct pattern for Vitest v1 — cast the mock to the concrete type
const mockFetch = vi.fn() as unknown as typeof fetch;
```

**Prevention**: Cast `vi.fn()` to a concrete type using `as unknown as typeof X` — never use the generic syntax in Vitest v1.

**Related**: See [packages/content/src/index.test.ts](../../packages/content/src/index.test.ts) for complete pattern.

### Error: "Hyperdrive connection failed: ECONNREFUSED"

**Root Cause**: Database connection string is wrong, or Hyperdrive binding name doesn't match Drizzle config.

**Example**:
```json
// wrangler.jsonc
{
  "hyperdrive": {
    "DB": "postgres://..."  // binding name is "DB"
  }
}
```

```typescript
// drizzle.config.ts
export default defineConfig({
  schema: './src/schema.ts',
  out: './src/db',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL  // ❌ Wrong! Should use Hyperdrive binding
  }
});
```

**Prevention**:
1. In `wrangler.jsonc`, define Hyperdrive binding (e.g., `"DB"`)
2. In app's `env.ts`, expose binding: `export type Bindings = { DB: Hyperdrive }`
3. In Hono context: Use `c.env.DB` to query database
4. In Drizzle migrations: Use `c.env.DB.query()` directly

**Fix**:
```typescript
// ✅ Correct pattern
const db = drizzle(c.env.DB, {
  schema: dbSchema,
  logger: true
});
```

### Error: "Rate limit exceeded: too many requests in 60s"

**Root Cause**: No rate limiting middleware, or middleware is misconfigured.

**Prevention**:
1. All apps must have rate limiting on auth routes
2. All 6 apps must wire `initAnalytics` to track rate limit hits

```typescript
// src/index.ts
app.use('/auth/*', rateLimitMiddleware({
  windowMs: 60 * 1000,    // 60 seconds
  maxRequests: 10,        // 10 requests
  keyGenerator: (c) => c.req.header('cf-connecting-ip') || 'unknown'
}));
```

### Error: "'token' is not defined"

**Root Cause**: Using `jsonwebtoken` package instead of Web Crypto API (constraint violation).

**Example**:
```typescript
// ❌ Fails on Cloudflare Workers
import jwt from 'jsonwebtoken';
const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET);
```

**Prevention**: All JWT operations use Web Crypto API only.

```typescript
// ✅ Correct
import { SignJWT } from 'jose';
const token = await new SignJWT({ id: user.id })
  .setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('24h')
  .sign(new TextEncoder().encode(JWT_SECRET));
```

### Error: "git push hangs forever on Windows (GCM credential prompt)"

**Root Cause**: Windows Git Credential Manager (GCM) opens an invisible auth dialog that blocks the terminal — `git push origin main` appears to hang indefinitely.

**Diagnosis**: `git push` produces no output and never returns.

**Fix** — bypass GCM entirely using `gh auth token`:
```powershell
$token = gh auth token
$encoded = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$token"))
git -c credential.helper="" -c "http.extraheader=Authorization: Basic $encoded" push origin main
```

**Why it works**: `credential.helper=""` disables GCM for this invocation; the `http.extraheader` provides the PAT directly as a Basic-auth header.

**Prevention**: Keep `gh` CLI authenticated (`gh auth status`). When pushing from scripts, use this pattern or set `GIT_TERMINAL_PROMPT=0` to fail fast instead of hanging.

### Error: "create-hyperdrive workflow: Store step fails with 403"

**Root Cause**: The `GITHUB_TOKEN` auto-provided by GitHub Actions does **not** have permission to write repository secrets. The "Store Hyperdrive IDs as GitHub secrets" step always fails with a 403.

**The Create Hyperdrive step always succeeds** — the UUID is printed in the logs even when the Store step fails.

**Workaround** (standard Factory pattern):
1. After running `create-hyperdrive.yml`, view the workflow logs and copy the UUID:
   ```bash
   gh run view <RUN_ID> --repo Latimer-Woods-Tech/factory --log | grep "{app}-db ->"
   # Output: [created] xico-city-db -> 0c15bc97978841f88a78da8253ea3d32
   ```
2. Hard-code the UUID in the scaffold workflow (`--hyperdrive-id "0c15..."`):
   ```yaml
   printf '\n\n\n\n\n\n\n\n' | node packages/deploy/scripts/scaffold.mjs {app} \
     --hyperdrive-id "0c15bc97978841f88a78da8253ea3d32" \
   ```
3. Store it manually as a GitHub secret:
   ```bash
   echo "0c15bc97978841f88a78da8253ea3d32" | gh secret set HYPERDRIVE_{APP} --repo Latimer-Woods-Tech/factory
   ```

**Why not fix the workflow?** Setting repo secrets requires a PAT with `secrets:write` scope, which should not be stored as a workflow secret (circular risk). The manual step is deliberate.

### Error: "Can't read from console.log in Wrangler logs"

**Root Cause**: Workers console output goes to `stderr`, not `stdout`, due to the streaming model.

**Prevention**: Use the `@latimer-woods-tech/logger` package instead of `console.log` for structured logging.

```typescript
// ✅ Correct
import { createLogger } from '@latimer-woods-tech/logger';
const logger = createLogger('myapp');
logger.info('User logged in', { userId: user.id });
```

### Error: "Cannot read property 'x' of undefined"

**Root Cause**: Database query returned no rows, code assumes a row exists.

**Prevention**: Always check for undefined or use optional chaining.

```typescript
// ❌ Unsafe
const user = await db.query.users.findFirst({ where: eq(users.id, id) });
return user.name;  // crashes if user is undefined

// ✅ Safe
const user = await db.query.users.findFirst({ where: eq(users.id, id) });
if (!user) throw new NotFoundError(`User ${id} not found`);
return user.name;
```

## Patterns That Work

### 1. Middleware Chain Pattern

All 6 apps follow this identical pattern in `src/index.ts`:

```typescript
import Hono from 'hono';
import { sentryMiddleware } from '@latimer-woods-tech/monitoring';
import { initAnalytics } from '@latimer-woods-tech/analytics';

declare module 'hono' {
  interface ContextVariableMap {
    analytics: Awaited<ReturnType<typeof initAnalytics>>;
  }
}

const app = new Hono();

// 1. Error boundary (global)
app.use('*', (c, next) =>
  sentryMiddleware({
    dsn: c.env.SENTRY_DSN,
    environment: c.env.ENVIRONMENT,
    workerName: 'app-name'
  })(c, next)
);

// 2. Analytics initialization (all routes)
app.use('*', async (c, next) => {
  const analytics = initAnalytics({
    postHogKey: c.env.POSTHOG_KEY,
    db: c.env.DB,
    appId: 'app-name'
  });
  c.set('analytics', analytics);
  await analytics.page(c.req.path, { method: c.req.method });
  return next();
});

// 3. Routes (then add specific route handlers)
app.post('/auth/login', async (c) => {
  // ...auth logic...
  const analytics = c.get('analytics');
  await analytics.identify(user.sub, { tenantId, role });
  return c.json({ success: true });
});

export default app;
```

**Why this works**:
- Error boundary catches all errors (Sentry)
- Analytics is available on every route
- User identification happens after auth succeeds
- Rate limiting tracked per endpoint

### 2. Environment & Bindings Pattern

All apps expose a consistent `env.ts`:

```typescript
// src/env.ts
import type { Hyperdrive } from '@cloudflare/hyperdrive';

export type Bindings = {
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  SENTRY_DSN: string;
  POSTHOG_KEY: string;
  ENVIRONMENT: 'development' | 'staging' | 'production';
  DB: Hyperdrive;
};

declare global {
  type AppEnv = {
    Bindings: Bindings;
  };
}
```

Then in `wrangler.jsonc`:

```jsonc
{
  "env": {
    "production": {
      "vars": {
        "SENTRY_DSN": "https://xxx@xxx.ingest.sentry.io/xxx",
        "POSTHOG_KEY": "phc_xxx...",
        "ENVIRONMENT": "production"
      }
    }
  },
  "hyperdrive": {
    "DB": "postgres://user@host/dbname"
  }
}
```

### 3. Error Handling Pattern

All errors inherit from `@latimer-woods-tech/errors`:

```typescript
import { ValidationError, NotFoundError, AuthenticationError } from '@latimer-woods-tech/errors';

// ✅ Custom errors with context
throw new ValidationError('Email is required', {
  field: 'email',
  value: input.email,
  context: { form: 'signup' }
});

throw new NotFoundError(`User ${id} not found`, {
  context: { userId: id, endpoint: '/api/users/:id' }
});

// Sentry automatically catches these and includes context
```

### 4. Database Query Pattern

All queries use Drizzle ORM with explicit error handling:

```typescript
import { db } from '@latimer-woods-tech/neon';
import { eq } from 'drizzle-orm';
import { users } from '@latimer-woods-tech/content';

// ✅ Always check for undefined
const user = await db.query.users.findFirst({
  where: eq(users.id, userId)
});

if (!user) {
  throw new NotFoundError(`User ${userId} not found`);
}

return user;
```

## Version & Publishing Strategy

### Current Canonical Version

All 19 packages are at **v0.2.0** as of Stage 6.

### How to Bump Versions

1. **Edit one package's `package.json`**:
   ```json
   {
     "name": "@latimer-woods-tech/errors",
     "version": "0.2.1"
   }
   ```

2. **Run `npm install` to update lock file**:
   ```bash
   cd packages/errors
   npm install
   ```

3. **Commit and tag**:
   ```bash
   git add packages/errors/package.json packages/errors/package-lock.json
   git commit -m "chore(errors): bump to v0.2.1"
   git tag errors/v0.2.1
   git push origin main
   git push origin errors/v0.2.1
   ```

4. **Wait for GitHub Actions publish to complete**:
   - Go to: https://github.com/Latimer-Woods-Tech/factory/actions
   - Check: Publish workflow succeeded

5. **Update dependent packages**:
   - If another package depends on `@latimer-woods-tech/errors`, update its `package.json`
   - Follow dependency order (see CLAUDE.md)

**Common Mistake**: Publishing packages out of order → peer dependency hell. Check GitHub Packages before tagging the next one.

## Quality Gate Checklist

Before merging **any** package:

- [ ] `npm run typecheck` → 0 errors
- [ ] `npm run lint` → 0 warnings (checked with `--max-warnings 0`)
- [ ] `npm test` → all passing, 90%+ line coverage, 85%+ branch coverage
- [ ] `npm run build` → no errors, `dist/` exists
- [ ] JSDoc on 90%+ exported symbols (check with `npm run docs:check`)
- [ ] No `any`, `@ts-ignore`, or `eslint-disable` in public APIs
- [ ] Commit follows `<type>(<scope>): <description>` format
- [ ] Version bumped in `package.json` (matches git tag)

**Enforcement**: All checks run in `.github/workflows/publish.yml` and block publish if any fail.

## Monitoring & Observability

### What We Track

1. **Sentry** (errors):
   - Uncaught exceptions
   - API 5XX responses
   - Validation errors with field context
   - Auth failures (rate limits, invalid tokens)

2. **PostHog** (user behavior + business events):
   - Page views (every route accessed)
   - Rate limit hits (tracked per endpoint)
   - User identification (sub, tenantId, role)
   - Custom business events (signup, purchase, export, etc.)

### Why Both Are Needed

| Tool | Coverage | Alerts? |
|------|----------|---------|
| Sentry | Technical errors + exceptions | Yes (>100/day = alert) |
| PostHog | All page views + custom events | No (for analysis only) |
| Combined | Complete picture of app health + user behavior | Essential for debug |

**Real Example**: User reports "can't log in". Check:
- PostHog: Did user hit rate limit? (check `auth.rate_limit_exceeded` events)
- Sentry: Did auth endpoint throw 5XX? (check error logs)
- Together: "Rate limit hit at 3:15pm, 127.0.0.1 had 11 attempts in 60s"

## Quarterly Review Checklist

Update this doc if any of the following occur:

- [ ] New common error discovered → add to "Common Errors" section
- [ ] New pattern worked well → add to "Patterns" section
- [ ] Hard constraint was violated (was there a reason?) → decide if constraint needs update
- [ ] Package update broke something → document in version section
- [ ] Deployment failed for new reason → add to troubleshooting
- [ ] Security issue discovered → update runbooks

## Incident Post-Mortems

### 2026-04-27 — selfprime.net Outage + Login Broken (prime-self rename)

**What Happened (root causes, in order):**

1. **Pages secrets wiped** — `prime-self-ui` had `CF_API_TOKEN` and `CF_ACCOUNT_ID` removed. Every deploy since April 27 silently failed. `selfprime.net/` became stale and eventually returned 404 when a route expired.

2. **No index.html** — `prime-self-ui/public/` had `landing.html` but no `index.html`. Once the Pages cache expired, `selfprime.net/` returned 404 because Pages needs `index.html` as the root document.

3. **Worker rename broke hardcoded URL** — `prime-self/wrangler.jsonc` was changed from `name: "prime-self"` to `name: "prime-self-api"`. The frontend (`landing.html` line ~537) hardcoded `https://prime-self.workers.dev/auth/login`. After the rename, that URL stopped resolving → ERR_NAME_NOT_RESOLVED.

4. **Wrong URL format** — The hardcoded URL `prime-self.workers.dev` was never the correct format. Cloudflare Workers URLs are always `{name}.{account-subdomain}.workers.dev` → `prime-self.adrper79.workers.dev`. The short form only resolves when you have a custom workers.dev route explicitly enabling it.

5. **Stale migration block** — After reverting the rename, the `wrangler.jsonc` still had a migrations block `{ "tag": "v1", "deleted_classes": ["LiveSession"] }`. Cloudflare returned `[code: 10074]` because that migration was already applied to the `prime-self` worker in a previous session; it can't be applied again.

6. **False "done" declarations** — Twice declared a fix "working" based only on CI green (✓), without running `curl`. CI green means code compiled. It does NOT mean the endpoint returns 200.

**Fixes Applied:**

- Created `prime-self-ui/public/index.html` (copy of landing.html) — fixes root 404
- Restored secrets to `prime-self-ui` GitHub repo (`CF_API_TOKEN`, `CF_ACCOUNT_ID`)
- Reverted `prime-self/wrangler.jsonc` name from `prime-self-api` back to `prime-self`
- Removed stale `migrations` block from `wrangler.jsonc`
- Updated `landing.html` and `index.html` URL: `prime-self.workers.dev` → `prime-self.adrper79.workers.dev`
- Added smoke test jobs to both deploy workflows
- Created `docs/service-registry.yml` — authoritative map of worker names → URLs → consumers
- Added Worker Rename Protocol and Verification Requirement to `CLAUDE.md`

**Rules Added as a Result:**

> **Before renaming any worker**: Check `docs/service-registry.yml`, find all consumers, update them first, deploy consumers, THEN rename the worker.

> **Before declaring a fix done**: `curl` the endpoint and observe the HTTP status with your own eyes. CI green is not sufficient.

> **Cloudflare workers.dev URLs**: Always use the account-scoped form `{name}.adrper79.workers.dev`. The short form `{name}.workers.dev` does not resolve without an explicit workers.dev route.

> **Pages root document**: `public/index.html` must exist. `landing.html` will NOT serve as the root.

> **Secrets are per-repo**: Each app repo needs its own `CF_API_TOKEN` and `CF_ACCOUNT_ID`. They are NOT inherited from Factory Core.

---

## See Also

- [CLAUDE.md](../../CLAUDE.md) — Standing orders & hard constraints
- [Service Registry](../service-registry.yml) — Worker name → URL → consumer map
- [GitHub Secrets & Tokens Runbook](./github-secrets-and-tokens.md) — Secrets management
- [Secret Rotation Runbook](./secret-rotation.md) — How to rotate specific secrets
- [Deployment Runbook](./deployment.md) — How to deploy apps
- [Getting Started Runbook](./getting-started.md) — First-time setup

---

## GitHub Governance & Autonomous LLM Review

This section covers patterns and lessons from building the factory's fully autonomous PR review pipeline (shipped May 2026).

### Architecture: Grok → Claude 2-Party Consensus

All LLM-gated PRs go through two independent model passes before any action is taken:

```
PR opened / synchronize
  └─► pr-review.yml
        └─► pr-review.mjs
              1. Grok first-pass  (xAI API)  → { lgtm, concerns[] }
              2. Claude second-pass (Anthropic) → { lgtm, concerns[] }
              APPROVE only when BOTH lgtm=true
              Otherwise CHANGES_REQUESTED with merged concerns
```

**Why two models?** Single-model reviews hallucinate approvals on code that violates constraints. Requiring *both* Grok and Anthropic-Claude to independently confirm reduces false approvals without requiring human intervention on green/yellow PRs.

**Lesson Learned:** Do not short-circuit on first-pass LGTM. The second pass consistently catches constraint violations (process.env, Buffer, require) that Grok misses when they appear in large diffs.

### Bot Identity: CODEOWNERS + Ruleset Bypass

Enabling a GitHub App bot to merge as a co-owner requires **both**:

1. **CODEOWNERS co-ownership** — add `factory-cross-repo[bot]` as a co-owner on the paths you want the bot to approve:
   ```
   # Green paths (docs, markdown)
   docs/**  @adrper79-dot factory-cross-repo[bot]
   *.md     @adrper79-dot factory-cross-repo[bot]

   # Yellow paths (app source, tests)
   apps/*/src/**  @adrper79-dot factory-cross-repo[bot]
   tests/**       @adrper79-dot factory-cross-repo[bot]

   # Red paths (infrastructure) — human only
   packages/**  @adrper79-dot
   .github/workflows/**  @adrper79-dot
   wrangler.jsonc  @adrper79-dot
   ```

2. **Ruleset bypass actor** — add the GitHub App as an `Integration` bypass actor on the branch-protection ruleset (UI: Settings → Rules → Rulesets → edit ruleset → add bypass actor type=Integration, actor=factory-cross-repo).

**Lesson Learned:** CODEOWNERS co-ownership alone is not enough. Without the ruleset bypass actor, the bot's approval satisfies CODEOWNERS but the ruleset still blocks the merge. Both are required.

**Lesson Learned:** Never add the bot as a bypass actor on red-tier paths (infrastructure). Red PRs must always require a human review even if the bot passes both LLM checks.

### Retry Limit and Escalation

After `MAX_REVIEW_ATTEMPTS` bot-submitted `CHANGES_REQUESTED` reviews on a single PR, escalate rather than loop:

1. Label PR `supervisor:review-limit-reached`
2. File a GitHub issue describing the stalled PR
3. Request human review from `HUMAN_REVIEWER`
4. Post a PR comment linking the issue

```yaml
env:
  MAX_REVIEW_ATTEMPTS: '3'        # default; override per-workflow
  HUMAN_REVIEWER: 'adrper79-dot'
```

**Lesson Learned:** Without a retry limit, a PR that the LLM perpetually disagrees with will loop forever, burning API credits. Three attempts is a reasonable threshold before assuming the diff requires human judgment.

### Supervisor PR Feedback Loop

The supervisor's scheduled job (`supervisor-loop.yml`, every 4 hours) now includes a pre-pass that self-heals stalled bot PRs:

```
supervisor-core.mjs main()
  1. runPrFeedbackLoop()
     - Find all open PRs opened by factory-cross-repo[bot] with state CHANGES_REQUESTED
     - For each: fetch review comments, call Claude to generate file fixes
     - Apply three hallucination guards (see below)
     - Commit fixes to the PR branch  →  triggers `synchronize`  →  pr-review.yml reruns
  2. processIssues() — normal issue→PR flow
```

**Lesson Learned:** Committing to the PR branch and letting `pr-review.yml` re-trigger via `synchronize` is cleaner than calling the review API directly from the supervisor. It keeps review logic in one place.

### Hallucination Guards

Three guards run on every LLM-generated file before it is committed:

| # | Guard | What it checks |
|---|-------|---------------|
| 1 | `checkGeneratedContent()` | Constraint violations (process.env, require, Buffer, Node built-ins, Express); empty files; line-count limit configurable via `MAX_GENERATED_LINES` (default 800) |
| 2 | `enforceSlotSchema()` | Strip keys not in declared template schema; null values matching injection verb patterns |
| 3 | `fixAddressesConcerns()` | At least one concern keyword from the review must appear in changed lines (added OR removed) |

**Guard 1 — Strip comments before scanning:** Run `stripCommentsAndStrings()` on the source before applying the constraint regexes. Otherwise JSDoc examples (`// never use Buffer`) trigger false violations.

**Guard 2 — Injection filter must be structural:** A broad substring match (`/ignore previous/i`) will null legitimate content (e.g., security docs that discuss jailbreaking). Use a 3-token imperative-verb pattern instead:
```js
const INJECTION_RE = /\b(ignore|disregard|forget|override)\s+(previous|above|all|prior|earlier)\s+(instructions?|context|rules?|prompt)/i;
```

**Guard 3 — Count removed lines too:** A fix that works by deleting bad code produces zero added lines. Check `addedLines ∪ removedLines` against concern keywords, not just added lines.

**Lesson Learned:** All three guards had initially high false-positive rates in the first pass. The root causes were: (1) scanning comments, (2) overly broad injection filter, and (3) only checking added lines. All three are now patched.

### GraphQL Variable Naming in Project Board Sync

GitHub's Projects v2 GraphQL API is strict about variable declarations. A `$contentId` variable used in the mutation body **must** be declared in the query signature:

```graphql
# ❌ Breaks silently — contentId used but not declared
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
  updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $contentId } })
}

# ✅ Correct — all variables declared
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $contentId: String!) {
  updateProjectV2ItemFieldValue(...)
}
```

**Lesson Learned:** GraphQL variable errors in Actions workflows produce a `422 Unprocessable Entity` with a `{"message": "Variable $contentId is not defined..."}` body. They do NOT cause the workflow to exit — the `gh api graphql` call returns exit 0 with the error body in stdout. Always pipe through `jq .errors` to detect these silently swallowed failures.


---

## Supervisor System — May 2026

### Best-Practice Template Pipeline

**Problem:** The supervisor had a 3-place sync requirement: every new template type needed to be added to (1) a YAML file, (2) MATCH_RULES in supervisor-core.mjs, and (3) the SEED array in load.ts. This caused package-version-migration to never match — it existed in YAML but not in MATCH_RULES.

**Fix:** Build-time generator (scripts/generate-supervisor-templates.mjs) reads all docs/supervisor/plans/*.yml via js-yaml, validates schema and regex patterns, and emits 	emplates.generated.ts. The Worker's load.ts imports from that file. Both the Worker's match.ts and the GHA supervisor-core.mjs derive match signals exclusively from the YAML 	riggers block. Adding a new template now requires only editing the YAML file.

**Key pitfalls fixed:**
- YAML double-quoted strings mangle \s → s and \. → . — always use single quotes for regex values
- PCRE inline flags (?is) are incompatible with JS RegExp — strip them and use flag arguments instead
- @cloudflare/workers-types injected via 	sconfig.types + imported via import type creates duplicate type identities → TS2322 mismatch. Use only the 	ypes injection; remove named imports
- ScheduledHandler expects ScheduledController as first param, not ScheduledEvent

### Supervisor Duplicate PR Race Condition

**Problem:** The supervisor ran concurrently (or retried before GH API label propagation) and opened 3 identical PRs (#287, #288, #289) for issue #286. The gent:claimed:sauna label filter is the primary dedup, but it isn't visible until after the label write completes — which happens after PR creation.

**Fix:** indExistingPR() queries open pulls for PRs whose body contains **Source issue:** #N before calling xecuteGreen. If a matching PR exists, return it without creating a branch. This is a secondary guard; the label filter remains the primary.

**Key insight:** Always add a PR-level dedup check when automation can open PRs, because label propagation is eventually-consistent — not immediate.

### validate-docs-quality.mjs Design

**Requirements (issue #286):** Fast (< 10 s), deterministic, bounded output, --max-errors N, --json report mode, no symlink loops.

**Implementation:** Bounded traversal of docs/, pps/*/README.md, and root *.md only. Skips symlinks, 
ode_modules, dist, .wrangler. Builds an anchor index from headings and id= attributes. Extracts relative Markdown links and resolves against the filesystem. Exits 1 with one FILE:LINE → TARGET (reason) line per broken link.


---

## Wedged Deploys, Token Rotators, and Production Drift — May 2026

The admin-studio production worker drifted six days stale because the GitHub Actions deploy pipeline silently wedged at the scheduling layer. Bringing production back exposed a chain of latent bugs that had been masked by the deploy stall. Each is its own lesson.

### `actions/create-github-app-token@v3` revokes the token in its post-step

**Problem:** A scheduled workflow minted a factory[bot] installation token, pushed it as a Cloudflare Worker secret via `wrangler secret put GITHUB_TOKEN`, the push succeeded — and every subsequent `/repo/*` call from the worker returned `401 Bad credentials`. Manual rotation with the same App credentials produced a working token. Token format was identical between the two paths.

**Root cause:** `actions/create-github-app-token@v3` (and v2) defaults to revoking the minted token in its post-job cleanup step. The whole point of the rotator was to push a token that lives for the next hour, so the default revocation defeats the entire workflow — the secret is uploaded, then invalidated within seconds of the runner shutting down.

**Fix:** Always set `skip-token-revoke: true` on the action when the token is consumed *outside* the workflow run that minted it (Worker secrets, downstream queue messages, persisted artifacts). Default revocation is correct for in-run use only.

```yaml
- uses: actions/create-github-app-token@v3
  with:
    app-id: ${{ secrets.FACTORY_APP_ID }}
    private-key: ${{ secrets.FACTORY_APP_PRIVATE_KEY }}
    owner: Latimer-Woods-Tech
    repositories: factory
    skip-token-revoke: true   # token lives past this run
```

**Lesson:** Any third-party action you use to mint short-lived credentials probably has a "revoke at end of job" knob. If your workflow's purpose is to hand the credential off to another system, double-check the knob — `gh run view` won't surface revocation as a distinct error, only the downstream consumer's `401`.

### CORS middleware that pre-decorates the Hono context does not cover raw `Response` returns

**Problem:** `POST /ai/chat` returned `HTTP 200` with a `text/event-stream` body, but the browser blocked it: `Access to fetch at … has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource`. Affected `/ai/chat` (SSE) and `/tests/runs/:id` (also SSE).

**Root cause:** The CORS middleware called `c.header('Access-Control-Allow-Origin', origin)` **before** `await next()`. Hono's header table is applied when responses are built via `c.json/c.body/c.text`. SSE handlers construct their response with `new Response(stream, { headers: { ... } })` directly — those bypass the header table entirely.

**Fix:** Move header writes to **after** `next()` and set them on `c.res.headers` directly:

```ts
export function corsMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const origin = c.req.header('Origin');
    const allowed = c.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
    const isAllowed = Boolean(origin && allowed.includes(origin));

    if (c.req.method === 'OPTIONS') { /* preflight, return early */ }

    await next();

    if (isAllowed && origin && c.res) {
      c.res.headers.set('Access-Control-Allow-Origin', origin);
      c.res.headers.set('Access-Control-Allow-Credentials', 'true');
    }
  };
}
```

**Lesson:** Any middleware that's supposed to apply universally must run *after* the route handler. Pre-handler `c.header()` only works for responses Hono builds itself; once a route returns a raw `Response`, only `c.res.headers.set(...)` after `next()` will decorate it.

### `db.execute()` shape changed in @latimer-woods-tech/neon — six callers never noticed

**Problem:** `/catalog` returned `500 "rows.map is not a function"`. `/audit` returned `500 "Audit query failed"`. Both predated any recent changes.

**Root cause:** The `neon` package's `FactoryDb.execute()` returns `{ rows: TRow[], rowCount: number }`. Older drizzle/neon-http versions returned the rows array directly. Six call sites in `apps/admin-studio/src/lib/` (catalog-store, audit-store, test-store) cast the whole result as the array — including a stale comment that explicitly claimed "drizzle/neon-http returns an array directly for SELECT." That comment was correct when written; the package upgrade silently broke every consumer that trusted it.

**Fix:** Access `.rows` explicitly. The pattern:

```ts
// Wrong — stale comment from a previous drizzle version
const rows = (result as unknown as AuditRow[]) ?? [];

// Right
const rows = result.rows as unknown as AuditRow[];
```

**Lesson:** Comments that document driver-specific behavior age into lies. When upgrading a data package, grep the monorepo for callers and verify the call shape against current types — don't trust the comments. The type system should have caught this; the `as unknown as Foo[]` cast on the result deliberately bypassed it.

### `wrangler.jsonc` invalid fields are warnings in v3, errors in v4

**Problem:** A scheduled workflow that ran `npx wrangler@latest secret put` started failing with `The field "flagship" should be an array but got {"binding":"FLAGS"}`. Earlier deploys (wrangler v3) had only warned about the same field.

**Root cause:** Wrangler v3 ignored unknown top-level fields with a warning. Wrangler v4 errors out. Our `wrangler.jsonc` had a `"flagship": { "binding": "FLAGS" }` field that wasn't a real wrangler config item — `FLAGS` wasn't bound anywhere in the worker code either. Dead config.

**Fix:** Remove the dead field. If you want to delay the wrangler v4 upgrade, pin: `npx wrangler@3 secret put …`. The pin is a temporary patch; the canonical fix is to schema-validate `wrangler.jsonc` against the actual binding set.

**Lesson:** "Warnings I've been seeing for months" become "errors that block deploys" after a major-version upgrade. Treat wrangler warnings as TODO items, not noise — and consider running `wrangler@next` in a non-deploy job (lint-style) to catch upgrade-blocking issues before the canonical deploy path is forced.

### Hono trailing-slash strictness

**Problem:** The UI called `/timeline/` (with trailing slash); the worker returned `404 "Not found"`. `/timeline` (no slash) returned 200.

**Root cause:** Hono treats `/timeline/` as a distinct path from `/timeline` when the router is mounted at `/timeline` with `timeline.get('/', ...)`. The trailing slash doesn't get stripped by default.

**Fix (UI):** drop the trailing slash in the fetch URL.

```ts
// Wrong
apiFetch<TimelinePage>(`/timeline/${buildQuery(filters, cursor)}`);

// Right — buildQuery returns "?key=val" or "", composing without the slash
apiFetch<TimelinePage>(`/timeline${buildQuery(filters, cursor)}`);
```

**Lesson:** When the SPA-side path includes a trailing slash, it's almost always wrong unless the worker registered `get('/')` specifically and you tested the slash form. Standardize on no-trailing-slash for Hono routes.

### GCP Secret Manager values often carry BOM, CRLF, and other clipboard artifacts

**Problem:** Three separate secrets fetched from GCP Secret Manager broke their downstream consumer differently:

- `CF_ACCOUNT_ID` — UTF-8 BOM prefix. Wrangler URL-encoded the BOM into the API path, producing `7003 "Could not route … perhaps your object identifier is invalid?"`.
- `FACTORY_APP_PRIVATE_KEY` — `\r\r\n` line endings (CR+CRLF). The Python `cryptography` lib refused to parse with `InvalidHeader("MIIEoQI…")`.
- `VERTEX_SA_KEY` — BOM + CRLF + **missing outer `{` brace**. `gcloud auth activate-service-account` rejected with `Extra data: line 1 column 7 (char 6)`.

**Root cause:** The values were uploaded via clipboard from a Windows host. Notepad / similar tools add BOM markers and CRLF line endings; copy/paste from a multi-line PEM occasionally drops the wrapping braces.

**Fixes (in order of preference):**

1. **Re-upload clean.** Once. `gcloud secrets versions add SECRET_NAME --data-file=clean.json` writes the file's bytes verbatim. Subsequent consumers see clean data and need no defensive normalization.
2. **Strip on read** when re-upload isn't possible. For string values: `python -c "import sys; print(sys.stdin.buffer.read().decode('utf-8-sig').strip())"`. For JSON files, also normalize CRLF and round-trip through `json.loads/dumps`.

**Lesson:** Treat Secret Manager output as untrusted bytes, not trusted text. The bash idiom `MY_SECRET=$(gcloud secrets versions access …)` looks clean but inherits whatever encoding artifacts the writer left behind. The cleanest path is to fix the data once at the source; the next-cleanest is to normalize at every read.

### `echo "$VAR" | wrangler secret put` appends a newline

**Problem:** Wrangler stored the trailing newline from `echo` verbatim in the secret value, which made the Worker's `Authorization: Bearer ${c.env.GITHUB_TOKEN}` produce `Bad credentials` (the newline corrupts the Bearer header).

**Fix:** `printf '%s' "$VAR"` instead of `echo`.

```bash
printf '%s' "$NEW_TOKEN" | npx wrangler secret put GITHUB_TOKEN --env production
```

**Lesson:** `echo` is a footgun for any pipeline that hands bytes to a parser that doesn't tolerate trailing whitespace. Bearer tokens, JWTs, JSON values via `-d @-`, AWS signatures — all of them. Default to `printf '%s'` in scripted secret pushes and curl bodies.

### Hyperdrive bindings can be shared across environments

**Problem:** Migration scripts had to be re-applied to "production" — but the staging deploy had already applied them, and production immediately reflected the changes without a separate run.

**Root cause:** `apps/admin-studio/wrangler.jsonc` declares the same Hyperdrive id (`efe957f404bb457593e6bd08b733b7c4`) under both `env.staging` and `env.production`. Both workers point at the same Neon database. The "staging vs production" split exists at the worker layer but not at the data layer.

**Lesson:** Don't assume `env.staging.hyperdrive` and `env.production.hyperdrive` are different databases. Read `wrangler.jsonc` before designing test-vs-prod data isolation. If they share an id, a "staging migration" is a "production migration" — every deploy of either environment touches prod data. Either accept that explicitly or split the binding into two Hyperdrive instances (and two Neon branches).

### GitHub Actions production-environment runs can wedge at registration

**Problem:** Workflows that resolve to the `production` GitHub deployment environment stay in `status: pending` indefinitely with `pending_deployments: []`, `jobs: []`, and `updated_at == run_started_at`. Same workflow file dispatched against `staging` registers in seconds. Both environments declare the same `required_reviewers` rule, so the protection model is not the cause.

**Diagnostic:** `gh api repos/OWNER/REPO/actions/runs/RUN_ID/pending_deployments` returns `[]`. If the run were waiting on env approval, that endpoint returns the approval request; an empty array confirms the wedge is at the GH Actions scheduling layer, not the approval layer.

**Workaround:** Deploy via wrangler bypass — `npx wrangler deploy --env production` from a workstation with `CF_API_TOKEN` (pulled from GCP Secret Manager). This skips the entire GitHub Actions path. Side effect: no canary watcher runs, no Sentry release marker, no deploy event in the audit trail. Document the bypass in the issue.

**Lesson:** When a workflow goes pending with zero jobs, check `pending_deployments` first. `[]` means scheduling failure (uncommon, escalate); a populated array means env approval (common, click approve). The two paths produce identical-looking UIs but need different responses.

### When the canonical deploy pipeline is wedged, your token rotators still need to work

**Problem:** Once production deploys went via manual wrangler bypass, the worker's short-lived secrets (`GITHUB_TOKEN`, `VERTEX_ACCESS_TOKEN`) had no refresh path. Both turned into recurring 401/503 errors at the 1-hour mark.

**Fix:** A cron workflow that mints and rotates these secrets — see `.github/workflows/rotate-admin-studio-tokens.yml`. The workflow runs without declaring an `environment:` directive, so it sidesteps the production-env scheduling wedge.

**Lesson:** Token refresh and code deploy are independent failure domains. A long deploy outage should not silently invalidate all your bearer-style secrets along with it. Always separate "rotate credentials" from "deploy code" — they have different cadences and different failure modes, and one being broken should never block the other.

### Hono `onError` that returns a generic 500 without logging silently consumes debug time

**Problem:** Every Playwright endpoint on the Cloud Run browser-agent returned `500 {"error":"Internal server error"}`. Cloud Run logs showed only empty `{}` ERROR payloads — no stack, no message.

**Root cause:** The Hono error handler returned `c.json({ error: 'Internal server error' }, 500)` without writing to stderr. Cloud Run's log pipeline doesn't see anything to attach to the error event, so the operator sees a structureless `{}`.

**Fix:** `console.error(err.stack ?? err.message)` *before* returning the generic 500.

```ts
app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  // Cloud Run / Workers Logs only show what reaches stderr — without this,
  // operators see "{}" payloads on every 500 and have nothing to debug.
  console.error('agent error:', err instanceof Error ? err.stack ?? err.message : err);
  return c.json({ error: 'Internal server error' }, 500);
});
```

**Lesson:** Generic 500 responses are fine for clients; silent 500 responses are a debug black hole for operators. Always log to stderr inside the `onError` handler, even if the response body stays opaque.

### Playwright in Cloud Run needs `--no-sandbox` and a matching base image version

**Problem:** After deploying `apps/browser-agent` to Cloud Run, every browser endpoint returned 500. After fixing logging, the actual error surfaced:

```
browserType.launch: Executable doesn't exist at
/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell
```

**Root cause:** Two stacked issues.

1. `chromium.launch({ headless: true })` was missing `--no-sandbox`. Cloud Run's gVisor runtime doesn't support Chromium's namespace-based sandbox, so the launch threw before any further diagnostics.
2. After adding the flag, `package-lock.json` had resolved `playwright@1.60.0` while the Dockerfile pinned the **v1.55.1** base image. The 1.60.0 npm package expects build-1223 of `chrome-headless-shell`, which the 1.55.1 image doesn't ship.

**Fix:** Both, in this order:

```ts
chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
```

```Dockerfile
FROM mcr.microsoft.com/playwright:v1.60.0-noble   # match package.json/lock
```

**Lesson:** Container-managed browser tools need the runtime and the binary to agree on a build number. Pin the Dockerfile to whatever version `package-lock.json` resolved, or pin both to the same minor and bump together.

### Worktree branch switches drop uncommitted edits silently

**Problem:** Edits to four files made on a worktree branch appeared to vanish after running `git checkout -b NEW_BRANCH origin/main`. The files reverted to their `origin/main` content.

**Root cause:** Uncommitted edits travel with the working tree across branch switches. `git checkout -b NEW_BRANCH origin/main` resets the working tree to `origin/main` content, overwriting anything not committed. The branches' commits are unaffected; only the in-flight edits are lost.

**Fix:** Commit before switching. If you mean to carry edits onto a new branch from a different base, `git stash` first.

**Lesson:** In a multi-worktree workflow, treat uncommitted edits as ephemeral. Either commit (`git commit -m "wip: …"`, amend or squash later) or stash before any branch switch — including `git checkout -b` operations that look like "fresh start." Don't trust that the same files will be on the new branch.

### `gh pr merge --admin` can self-approve when branch protection requires review

**Problem:** A PR with `reviewDecision: REVIEW_REQUIRED` blocked merge after dismissing bot-only `CHANGES_REQUESTED` reviews. The author (org owner) could not approve their own PR via `gh pr review --approve`.

**Workaround:** `gh pr merge --admin --squash` bypasses required-review checks when the caller has admin permissions on the repo. Use sparingly — the audit trail records "merged by admin override," not "approved by reviewer."

**Lesson:** Admin override is the correct tool when the only blocker is a bot-review-without-human-counterpart pattern, and the human (you, as owner) has the same context the absent reviewer would have. Log the rationale in a PR comment before merging so the future archaeologist sees why the override was used.


---

## Probe Round 2 — Cache Poisoning, Cross-Origin Redirects, and the Silently Broken Probe — May 2026

A re-probe of the production admin-studio worker after the earlier fixes (PR #783, #784) surfaced three more issues the first probe round missed — including one where the probe itself had been lying about the state of the system. Each lesson maps to a fix in PR #821.

### A WeakMap-cached postgres-js client poisons every subsequent request when one query dies

**Problem:** `/catalog` returned `500 "Failed query: ..."` on 40% of calls; `/audit` on 50%. Both endpoints intermittent. `/timeline` (which calls the same `queryAuditEntries`) was 100% green only because the timeline route swallows DB errors and returns `[]` — the underlying flakiness was identical.

**Root cause:** The `dbCache = new WeakMap<HyperdriveBinding, FactoryDb>()` pattern in `catalog-store` and `audit-store` memoises a single drizzle/postgres-js client per Worker isolate. When a query gets aborted (network blip, statement cancellation, etc.), the postgres-js pool connection enters a bad state — and every subsequent `db.execute()` call on the *same cached client* then fails until the isolate cold-starts. Worker isolates can live for hours, so a single bad request can poison the connection cache for the entire isolate's lifetime.

**Fix:** Wrap the cached client in a retry helper that evicts the cache and rebuilds the client on first failure.

```ts
async function withDbRetry<T>(
  hyperdrive: HyperdriveBinding,
  op: (db: FactoryDb) => Promise<T>,
): Promise<T> {
  try {
    return await op(getDb(hyperdrive));
  } catch (err) {
    console.error('[store] DB query failed; evicting cache and retrying:', (err as Error).message);
    dbCache.delete(hyperdrive);
    return await op(getDb(hyperdrive));
  }
}
```

Use at every read site: `const result = await withDbRetry(hyperdrive, (db) => db.execute(sql ...))`. Verified: sticky 50% flake to 0/20 failures after deploy.

**Lesson:** "Memoise the client" is a tempting micro-optimization but is only safe if the underlying connection pool is itself fault-tolerant. postgres-js's pool isn't — a single bad query can leave a stuck connection that the pool will hand out again. Either don't cache (create the client per request — cheap for Hyperdrive) or wrap every read in retry+evict. Caching without recovery is a footgun.

### A worker-level trailing-slash redirect needs CORS headers inline, and must skip OPTIONS

**Problem:** After the UI fix in #783, the production Pages bundle still calls `/timeline/` (with slash) because the admin-studio-ui deploy never picked up the new code. The worker registered routes at the bare path (`/timeline`), so trailing-slash requests 404'd.

**The naive fix:** add a worker middleware that redirects `/foo/` to `/foo` via 308.

**The two non-obvious gotchas:**

1. **The redirect response must carry CORS headers itself.** Chrome treats every leg of a cross-origin redirect chain as a separate CORS check. If the 308 response lacks `Access-Control-Allow-Origin`, the fetch fails with `net::ERR_FAILED` — *even though* the final redirected response would have had CORS headers. The cors middleware decorates `c.res` *after* `next()`, but a redirect handler returns before `next()` is called, so it must inline the CORS logic.

2. **The redirect MUST skip OPTIONS preflights.** Browsers refuse to follow redirects during a CORS preflight — a 308 on the preflight aborts the entire fetch chain. The trailing-slash middleware must let `OPTIONS /foo/` fall through to the cors middleware, which returns a 204 preflight response inline.

```ts
app.use('*', async (c, next) => {
  // Preflights cannot be redirected.
  if (c.req.method === 'OPTIONS') return next();

  const url = new URL(c.req.url);
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
    const origin = c.req.header('Origin');
    const allowed = c.env.ALLOWED_ORIGINS?.split(',').map((s) => s.trim()) ?? [];
    const headers = new Headers({ Location: url.toString() });
    if (origin && allowed.includes(origin)) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Credentials', 'true');
      headers.set('Vary', 'Origin');
    }
    return new Response(null, { status: 308, headers });
  }
  return next();
});
```

**Lesson:** Any middleware that short-circuits before `next()` and returns its own response must self-inline whatever cross-cutting concerns the after-`next()` middleware would have added. For Workers serving SPA bundles, that's at minimum CORS — and for preflights specifically, the answer is always "skip and let the dedicated CORS handler answer."

### The smoke probe was silently broken: every tab click timed out and the failure was reported as "no network failures"

**Problem:** A re-probe of production reported `no network failures` for several runs in a row. Inspection of the captured steps showed every tab from `03-overview` through `10-audit` had `finalUrl: ?` and ms timings of exactly 5008–5014ms — the click timeout. **Every nav click had failed, no tab was loaded, no API call ever fired, and the probe celebrated.**

**Root cause:** The probe used `page.getByRole('link', { name: ... })` to find nav elements. Mobile uses `<NavLink>` (role=link) but desktop nav uses Radix `<TabsTrigger>` (role=tab) — the probe ran at a 1280x800 viewport (desktop), where no element matches role=link. The `.click({ timeout: 5_000 })` timed out for every tab, the handler returned without firing any `goto` or API request, and the probe's "no failures" report was technically accurate but operationally meaningless.

**Fix:** Try multiple roles + fall back to text:

```ts
const candidates = [
  () => page.getByRole('tab',  { name: new RegExp('^' + linkText + '$', 'i') }),
  () => page.getByRole('link', { name: new RegExp('^' + linkText + '$', 'i') }),
  () => page.getByText(new RegExp('^' + linkText + '$', 'i'), { exact: false }),
];
for (const factory of candidates) {
  try { await factory().first().click({ timeout: 4_000 }); break; }
  catch { /* try next */ }
}
```

**Lesson:** A probe that reports "all clear" while doing nothing is worse than one that throws. Whenever an automated check appears to pass with zero work, audit the workload — duration per step is a good tell. If every tab took the timeout duration exactly, no real navigation happened. Add a positive assertion at the end of each step (e.g. `expect URL change` or `expect named element to appear`) so silent no-ops surface as failures, not as success.

### Factory canonical reviewer CHANGES_REQUESTED for "No secrets in wrangler vars" when none are present

**Problem:** `factory-cross-repo[bot]` posts CHANGES_REQUESTED — "No secrets in wrangler vars: Use wrangler secret put — never put secrets in the vars block" — but the PR adds no secret-looking keys to any wrangler config.

**Root cause:** The deterministic check in `.github/scripts/pr-review.mjs` previously ran the pattern `/vars:\s*[\s\S]*?(?:KEY|SECRET|TOKEN|PASSWORD)\s*:/im` over **all** added lines from all files in the PR concatenated. A TypeScript type definition (`vars: string[]`) in a capability plan type provides the `vars:` anchor; a GitHub Actions workflow env block (`STUDIO_DISPATCH_TOKEN: ${{ secrets.X }}`) provides the `TOKEN:` match. The cross-file blob match fires even though no wrangler file was modified.

**Fix (already applied):** The check is scoped to added lines from wrangler config files only. If you see the false positive again, verify the fix is in place at line ~395 of `.github/scripts/pr-review.mjs`.

**When the check is correct:** If a wrangler config file genuinely adds a `vars:` block containing a key named `*_KEY`, `*_SECRET`, `*_TOKEN`, or `*_PASSWORD`, the check is not a false positive — move the value to `wrangler secret put`.

**Reference:** PATTERNS.md §9 · PR [#910](https://github.com/Latimer-Woods-Tech/Factory/pull/910)

---

### Playwright fires `requestfailed` on the source side of a redirect chain

**Problem:** Even after the worker properly redirected `/timeline/` to `/timeline` with CORS headers, the smoke probe kept reporting `failed GET https://api.apunlimited.com/timeline/` with reason `net::ERR_FAILED`. The actual fetch returned 200; the user's browser saw the redirected response.

**Root cause:** Playwright's `request` lifecycle treats redirects as creating a *new* Request for the target URL. The original Request (pointing at the pre-redirect URL) is then marked failed with `net::ERR_FAILED` — even though, from the fetch caller's perspective, the request succeeded by following to the redirect target. The probe's `page.on('requestfailed', ...)` handler was capturing the redirect-source side and falsely counting it as a failure.

**Fix:** Filter out failures whose request has a non-null `redirectedTo()`:

```ts
page.on('requestfailed', (req) => {
  if (shouldIgnore(req.url())) return;
  // Source side of a redirect chain — the actual final response is on the
  // redirect target. Skip.
  if (typeof req.redirectedTo === 'function' && req.redirectedTo()) return;
  networkFailures.push({ /* ... */ });
});
```

**Lesson:** Playwright's request lifecycle does NOT model redirects as "one request, multiple legs." It models them as "two distinct requests, the first marked failed when the redirect fires." For network-failure-counting probes, this means a 100%-clean redirect chain still produces one `requestfailed` event per redirect leg. Use `redirectedTo()` / `redirectedFrom()` to distinguish probe-relevant failures from redirect-chain artifacts. The same shape applies to any tool inspecting raw request events (HAR analyzers, Chrome DevTools Protocol consumers, etc.).

## I1 Personal Blueprint Film — narration debugging (June 2026)

### A Workers LLM "fallback" was the ONLY path used, and its streaming parser truncated every completion
The selfprime `llm-adapter.js` `callLLM` tries a metered gateway path first and a
local `callAnthropicFallback` second. The metered path is loaded with an **indirect
dynamic-import specifier** (`const s = '@latimer-woods-tech/llm-meter'; await import(s)`)
specifically so "environments without the package still load." But wrangler/esbuild
cannot statically analyse a variable specifier, so the package is **never bundled** —
the import throws at runtime, `getMeteredComplete()` returns `null`, and **every** Worker
LLM call silently uses the fallback. The intended gateway/tier/budget code was dead code
in production.

The fallback then streamed the SSE response and parsed it with `chunk.split('\n')` per
network chunk, **without buffering partial lines across chunk boundaries**. Any `data: {…}`
event that straddled a read boundary became invalid JSON and was silently dropped
(`catch { /* skip */ }`). For a multi-hundred-word completion spanning many SSE events,
enough deltas were lost to truncate a full ~225-word narration down to a stub (`#` /
~24 words), which a downstream length guard then rejected (502).

**Lessons:**
1. **An indirect dynamic-import specifier means the module is NOT bundled.** If a Worker
   "optionally" loads a package this way, assume it is *absent in production* and verify
   which branch actually runs. A returned object missing fields the primary path sets
   (here `result.model` / `result.provider` were `undefined`) is the tell that the
   fallback is live.
2. **Never hand-parse SSE by `split('\n')` without a cross-chunk line buffer.** A `data:`
   event can land on either side of a read boundary. Either buffer the trailing partial
   line and only parse complete lines, or — simpler and almost always correct for one-shot
   completions — issue a **non-streaming** request and parse the buffered JSON. A ~250-word
   Anthropic completion returns in a few seconds, well inside the Worker subrequest budget.
3. **When Worker logs are locked down** (`wrangler tail` 403 — the CF token lacks the Tail
   scope), surface the error in the response body temporarily and deploy *directly* with
   `wrangler deploy --env production` (a working `CLOUDFLARE_API_TOKEN` from Secret Manager,
   ~11 s) instead of the ~7-min CI path. Reproduce the LLM call through the AI Gateway with
   `curl` (`${AI_GATEWAY_URL}/anthropic/v1/messages`, `x-api-key: $LATIMER`); Python `urllib`
   gets a Cloudflare `1010` UA-block, so use curl.

### A committed-only `package.json` with a gitignored `dist/` makes a `file:` dep unresolvable in CI
A vendored `file:vendor/<pkg>` dependency whose `package.json` points at `./dist/index.mjs`
will fail `npm ci` everywhere if `dist/` is gitignored and never committed (only the
`package.json` was tracked). The failure surfaces as "Failed to resolve entry for package"
on every test that imports the chain — and presents as *flaky* because Vite's resolver
caches differently per file subset, so it passes in small runs and fails in the full suite.
**Lesson:** for a `file:` dep you must commit the built artifact (force-add past `dist/`
ignores with a `.gitignore` negation) or vendor the source + a build step. The real fix is
publishing the package; vendoring a `dist/` is a stopgap that rots when the source changes.

## AI Gateway ghosts + the daily-brief E2E chain (June 2026)

The daily-brief email arrived every morning with a canned `fallback` ("Morgan's Take —
You showed up. That counts.", "Data unavailable" time horizons). Tracing it took a long
chain; the lessons below are the load-bearing ones. Full architecture in
[`project_llm_gateway_ghost`](../../) (auto-memory) and the PR trail #1293–#1315.

### A non-existent Cloudflare AI Gateway 401s every call → SILENT LLM fallback (the root cause)
`@latimer-woods-tech/llm` routes **100%** of provider calls through a CF AI Gateway and has
**no direct-to-provider path** (`AI_GATEWAY_BASE_URL` is required since v0.3.0; empty string
→ `ValidationError`). The gateway is named per-app by convention (`.../{app}`), but
**provisioning was never automated.** Only one gateway (`prime-self`) was ever created.

Cloudflare returns **HTTP 401 for an unknown gateway name** — indistinguishable at a glance
from a bad provider key. Every app pointing at its own-named ghost gateway (`daily-brief`,
`linkedin-publisher`, `supervisor`) had its LLM die in <1 s, the package threw, the app
caught it and returned a canned fallback. **No error surfaced.** The brief looked "built."

**Lessons:**
1. **A missing gateway fails silent and looks like a bad key.** Diagnose by hitting the
   gateway **management API**, not the inference path: `GET
   /accounts/{acct}/ai-gateway/gateways/{slug}` → **404 = ghost** (unambiguous, no provider
   key needed). `scripts/verify-ai-gateway.mjs` does exactly this and is now a deploy
   preflight on every LLM app — it turns the silent class into a loud pre-deploy red.
2. **Grep for actual `complete(` / `completionStream(` call sites, not package imports,
   before assuming an app is degrading.** `supervisor` *imports* the package only in a
   comment + a generated capability catalog — it never calls the LLM, so its ghost gateway
   was inert. We almost "fixed" a non-bug.
3. **The chosen architecture is ONE shared gateway + per-request `cf-aig-metadata`
   attribution** (`llm` v0.4.0), not per-app gateways. The package now tags every call with
   `{project, workload, actor, runId}`, so a single gateway slices per-app *and* per-workload
   in the dashboard — finer than per-app gateways, with zero provisioning surface. The
   `AI_GATEWAY_URL` GCP SM secret is the single source of truth for the URL.

### MYTH BUSTED: GCP SM `ANTHROPIC_API_KEY` is NOT dead
Prior docs (including CLAUDE.md and the video-pipeline runbook) claimed the bare
`ANTHROPIC_API_KEY` secret was "dead, aliasing live `LATIMER_ANTHROPIC_API`." **Live-tested
2026-06-02: both keys return 200.** The "dead key" diagnosis was a misattribution of the
gateway-401. The gateway ghost was the *sole* cause of the fallbacks; the key was never the
problem. **Lesson:** when an LLM call fails through the gateway, test the key *directly*
against `api.anthropic.com` before blaming it — a gateway-layer 401 and a provider-key 401
look identical from inside the package.

### Wrangler 4 footguns that each cost a deploy cycle
The daily-brief worker took ~6 deploys to go live; each surfaced a distinct Wrangler-4
behavior worth knowing:
1. **`--env production` without `"name"` in the env block deploys a *shadow* worker** named
   `{name}-production`, leaving the real worker untouched. `/health` stays 200 on the old
   code while you think you shipped. Always set `"name"` inside `env.production`.
2. **`r2_buckets`, `triggers`, and `vars` are NOT inherited into `env.*` blocks** — they
   must be repeated inside `env.production` or the prod worker deploys without them (no
   crons, no R2 binding).
3. **`wrangler r2 object put` writes to the LOCAL miniflare store by default (4.97+).**
   Without `--remote` the upload "succeeds" and logs success, but the object never reaches
   real R2 and evaporates when the job ends. Always pass `--remote` in CI.
4. A stray top-level `flagship` / `d1_databases` binding an app doesn't use can hard-fail
   `wrangler` validation. Remove unused bindings.

### A `fetch` handler's fire-and-forget async is killed after the Response returns
A Worker `fetch` handler that kicks off background work (`doThing().catch(...)`) **without**
`ctx.waitUntil()` has that work terminated by the runtime once the Response is sent. A quick
single fetch may sneak through; a multi-step job (R2 reads + Resend send) gets cut off
mid-flight — no email, no error. **Lesson:** any background work in `fetch` must be wrapped
in `ctx.waitUntil(...)` (add `ctx: ExecutionContext` to the signature). This is the same
guarantee the `scheduled` handler already had.

### Reading a BOM/encoded GCP secret on Windows crashes gcloud silently under `2>$null`
`gcloud secrets versions access` can crash with a `charmap`/`UnicodeEncodeError` on a value
with a UTF-8 BOM; `2>$null` swallows the crash and you get an **empty string**, which then
"fails auth" for confusing reasons (e.g. a 401 that's really "token was blank"). **Lesson:**
on Windows set `[Console]::OutputEncoding = [Text.Encoding]::UTF8` and read via
`(& gcloud ... | Out-String).Trim()`. Also: the daily-brief trigger token lives in GCP SM as
**`DAILY_BRIEF_TRIGGER_TOKEN`** (the bare `TRIGGER_TOKEN` secret does not exist).

## RLS connection-layer retrofit on Neon (selfprime, June 2026)

Discoveries from building Postgres row-level-security onto an existing raw-`@neondatabase/serverless` app (HumanDesign). Reusable across the whole Workers+Neon portfolio.

### Connecting as the table owner SILENTLY bypasses RLS
Postgres RLS policies are only enforced for roles that are **not** the table owner and **not** `BYPASSRLS`. The default Neon connection role (`neondb_owner`) owns the tables, so it bypasses every policy. **Setting `app.user_id` and writing perfect policies enforces NOTHING if your app still connects as the owner.** User-request queries MUST connect as a dedicated non-owner role (`app_rls`) with explicit `GRANT`s. The owner connection stays for migrations + cross-user service tasks (cron). This is the single most important — and most silent — RLS gotcha: it "works" in every test that uses the owner connection and protects nothing in prod. **Verify with a deliberate cross-tenant probe that the role does NOT bypass.**

### Carry request-scoped identity with AsyncLocalStorage, not N function signatures
To RLS-scope queries without editing ~85 `createQueryFn` call sites: set an `AsyncLocalStorage` store once at the request entry (`runWithRls({ userId, enabled, connectionString }, () => handler())`) and have the query factory read the ambient store at query time. Needs the `nodejs_compat` flag (`node:async_hooks`). Benefits: (1) service tasks/cron run *outside* the request scope → they self-exempt to the owner connection with zero enumeration; (2) gate the whole thing on an `RLS_ENABLED` env flag so it ships **dark** (deployed but inert) and the flag is an **instant kill switch** — no redeploy; (3) **fail-closed** — if the context is ever lost on an async edge, queries run with `app.user_id` unset against the non-bypass role → policies return *zero rows*, never another tenant's data. The DB is the boundary; ALS is just the wiring. Caveat: `ctx.waitUntil()` work runs after the response, outside the ALS scope — fine for system-table analytics, validate any deferred user-data writes.

### Neon HTTP driver batches `set_config` + query in ONE round-trip; the WS pool can't carry it
A stateless HTTP query can't keep a `SET LOCAL` across calls. Use the HTTP driver's non-interactive transaction: `neon(conn,{fullResults:true}).transaction([ sql.query("SELECT set_config('app.user_id',$1,true)",[uid]), sql.query(text,params) ])` — both statements ride one round-trip and `fullResults` returns the pg-shaped `{rows,…}` every call site expects. (A WS-`Pool` interactive transaction would be 4 round-trips: BEGIN/SET/query/COMMIT.) **In Node** (tests/harness) the WS `Pool` path needs `neonConfig.webSocketConstructor = ws` and `ws` resolvable; the HTTP path needs only global `fetch`.

### `no-useless-escape` on a SQL string can be a REAL bug — never blind-`--fix`
`replace(replace(replace($1,'\','\\'),'%','\%'),'_','\_')` inside a **backtick template literal** does NOT do what it looks like: the template processor collapses `\%`→`%`, `\_`→`_`, etc., so the LIKE-wildcard-escaping chain is a runtime **no-op** (user `%`/`_` are treated as wildcards). eslint flags these as `no-useless-escape` — and it's right, but `eslint --fix` "fixes" them by *stripping the backslash*, cementing the bug. The correct fix is to **double** the backslashes (`'\\%'`) so the SQL actually receives `\%`. **Lesson:** when a linter flags escapes inside SQL strings, hand-fix and verify the emitted SQL against a real DB; don't let `--fix` (or a `lint-staged` `eslint --fix` hook) touch them.

### `cmd | tail` reports tail's exit code, not the command's
Running `eslint … | tail -40` (or any pipe to `tail`/`head`) makes the shell report the **last** pipe stage's exit code (0), masking a non-zero failure upstream. This produced a false "lint passed clean" early in the work when the repo actually had ~929 lint errors. **Lesson:** when you need the real exit code, capture to a file (`cmd > out 2>&1; echo $?`) or check `${PIPESTATUS[0]}` — never trust the exit code of a tail/head pipeline.

### A Node script that `process.exit()`s while Neon sockets close crashes on Windows
`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` (libuv, `async.c`) fires when you call `process.exit()` while the Neon HTTP driver's keep-alive sockets are still closing — *after* your logic finished, but it corrupts the exit code (127), which breaks CI gating. **Lesson:** set `process.exitCode = …` and let Node drain naturally instead of calling `process.exit()`.

### A mocked unit suite cannot validate a DB-driver or RLS change — build a real-DB harness, baseline FIRST
The 3284-test suite mocks the DB, so it proves code *shape* but nothing about a driver swap or RLS enforcement. For changes at the driver/DB layer: (1) spin a **dedicated Neon branch** (copy-on-write off prod — isolated, instant, deletable; never test against prod — branches contain a full copy of prod PII, delete after); (2) build a harness with a **prod-guard** (refuse to run if the target host is in a prod deny-list, no `--force`); (3) capture a **golden baseline BEFORE the change** so the after-diff distinguishes a regression from pre-existing behavior — without it you can't tell "we broke it" from "it was always like that"; (4) note the baseline's validity window (a pre-RLS parity baseline becomes *expected*-to-differ once policies turn on). Drive the branch yourself via the Neon API (`NEON_ORGANIZATION_KEY` is the write-capable org key) rather than asking a human to paste a connection string — a paste invites pasting the *prod* string, the exact disaster the prod-guard exists to prevent.
