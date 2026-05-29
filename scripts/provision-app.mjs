#!/usr/bin/env node
/**
 * provision-app.mjs
 *
 * Unified provisioner for a new Factory app. Encodes all 21 per-app
 * plumbing operations that would otherwise be manual:
 *
 *   A. Neon project + connection string
 *   B. Cloudflare Hyperdrive (UUID extraction)
 *   C. Rate limiter ID allocation
 *   D. GitHub repo (optional)
 *   E. Factory repo GH Actions secrets
 *   F. setup-all-apps.mjs APPS array patch
 *   G. docs/service-registry.yml entry
 *   H. docs/runbooks/add-new-app.md rate-limiter table update
 *   I. wrangler.jsonc snippet (stdout — copy into the new app repo)
 *   J. CLAUDE.md standing-orders file (stdout — copy into .github/repo-contexts/)
 *
 * Usage:
 *   node scripts/provision-app.mjs \
 *     --app my-app \
 *     --worker-name my-app-api \
 *     --db new \
 *     --domain api.myapp.com \
 *     --rate-limiter-id 1012 \
 *     --extra-secrets STRIPE_SECRET_KEY,ANTHROPIC_API_KEY \
 *     --dry-run
 *
 * Flags:
 *   --app              Kebab-case app name (also used as GitHub repo name under Latimer-Woods-Tech/)
 *   --worker-name      Cloudflare Worker name in wrangler.jsonc (defaults to --app)
 *   --db               "new" to create a fresh Neon project, or "shared:<project-id>" to use THE_FACTORY
 *   --domain           Custom domain hostname (default: {app}.latwoodtech.work). Pass "none" to skip.
 *   --rate-limiter-id  Integer namespace ID for AUTH_RATE_LIMITER (prod). The next 3 IDs are auto-computed.
 *   --extra-secrets    Comma-separated list of extra Wrangler secret names beyond the standard set
 *   --create-repo      Create the GitHub repo (default: skip if it already exists)
 *   --scaffold         After provisioning, scaffold app code using packages/deploy/scripts/scaffold.mjs
 *   --recipe <id>      Capability recipe ID to drive scaffold (requires --scaffold)
 *   --dry-run          Print all commands without executing any
 *
 * Prerequisites (env vars):
 *   GITHUB_TOKEN       - GitHub PAT or App token with repo + secrets scopes
 *   CF_API_TOKEN       - Cloudflare "Edit Workers" token
 *   CF_ACCOUNT_ID      - Cloudflare account ID
 *   NEON_API_KEY       - Neon console API key (only needed for --db new)
 *
 * What runs automatically vs. what is printed for manual action:
 *   - Automatic: Neon project/connection, Hyperdrive, GH secrets, registry patches
 *   - Printed:   Wrangler.jsonc snippet, repo-context CLAUDE.md, CF custom-domain curl command
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ─── CLI Arguments ────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag, def = null) => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] ?? def : def;
  };
  const has = (flag) => args.includes(flag);

  const app = get('--app');
  if (!app) { console.error('ERROR: --app is required'); process.exit(1); }

  const workerName = get('--worker-name', app);
  const db = get('--db', 'new');
  const domain = get('--domain', `${app}.latwoodtech.work`);
  const rateLimiterId = parseInt(get('--rate-limiter-id', '0'), 10);
  const extraSecrets = (get('--extra-secrets', '') || '').split(',').filter(Boolean);
  const createRepo = has('--create-repo');
  const scaffold = has('--scaffold');
  const recipe = get('--recipe', null);
  const dryRun = has('--dry-run');

  if (!rateLimiterId) {
    console.error('ERROR: --rate-limiter-id is required (check docs/runbooks/add-new-app.md for next available)');
    process.exit(1);
  }

  return { app, workerName, db, domain, rateLimiterId, extraSecrets, createRepo, scaffold, recipe, dryRun };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  if (opts.dryRun) {
    console.log(`  [DRY-RUN] ${cmd}`);
    return '';
  }
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts.execOpts }).trim();
  } catch (err) {
    const msg = (err.stderr ?? err.stdout ?? '').toString().trim();
    throw new Error(`Command failed: ${cmd}\n${msg}`);
  }
}

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`ERROR: Required environment variable not set: ${name}`);
    process.exit(1);
  }
  return val;
}

function toEnvKey(appName) {
  // wordis-bond → WORDIS_BOND
  return appName.replace(/-/g, '_').toUpperCase();
}

function section(title) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
}

function printSnippet(label, content) {
  console.log(`\n  ┌─ ${label} ${'─'.repeat(Math.max(0, 55 - label.length))}┐`);
  content.split('\n').forEach(l => console.log(`  │  ${l}`));
  console.log(`  └${'─'.repeat(58)}┘`);
}

// ─── Step A: Neon Database ─────────────────────────────────────────────────────

async function provisionNeon({ app, db, envKey, dryRun }) {
  section('A. Neon Database');

  if (db.startsWith('shared:')) {
    const projectId = db.split(':')[1];
    console.log(`  Using shared Neon project: ${projectId} (THE_FACTORY)`);
    console.log(`  ℹ️  Manually create a database named '${app}' in that project if it does not exist.`);
    return null; // no connection string to return — use THE_FACTORY's existing one
  }

  // db === 'new'
  const neonApiKey = process.env.NEON_API_KEY;
  if (!neonApiKey) {
    console.log('  ⚠️  NEON_API_KEY not set — skipping automated Neon project creation.');
    console.log(`  Manually create a Neon project named '${app}' at https://console.neon.tech`);
    console.log(`  Then export: NEON_CONN_STR_${envKey}="postgresql://..."`);
    return null;
  }

  console.log(`  Creating Neon project: ${app}`);
  const createCmd = `curl -sS -X POST https://console.neon.tech/api/v2/projects \
    -H "Authorization: Bearer ${neonApiKey}" \
    -H "Content-Type: application/json" \
    -d '{"project":{"name":"${app}","pg_version":16}}'`;

  let projectId = null;
  let connectionString = null;

  if (!dryRun) {
    const raw = run(createCmd, { dryRun: false });
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Failed to parse Neon API response: ${raw}`);
    }
    if (parsed.message) throw new Error(`Neon API error: ${parsed.message}`);
    projectId = parsed.project?.id;
    connectionString = parsed.connection_uris?.[0]?.connection_uri;
    if (!connectionString) throw new Error('Neon API did not return a connection_uri');
    console.log(`  ✅ Neon project created: ${projectId}`);
    console.log(`  Connection string retrieved (stored as GH secret below)`);
  } else {
    console.log(`  [DRY-RUN] POST https://console.neon.tech/api/v2/projects {name:"${app}"}`);
    connectionString = 'postgresql://user:pass@host/dbname?sslmode=require';
    projectId = 'dry-run-project-id';
  }

  return { projectId, connectionString };
}

// ─── Step B: Cloudflare Hyperdrive ────────────────────────────────────────────

function createHyperdrive({ app, connectionString, envKey, dryRun }) {
  section('B. Cloudflare Hyperdrive');

  if (!connectionString) {
    console.log(`  ⚠️  No connection string available — skipping Hyperdrive creation.`);
    console.log(`  Run manually: wrangler hyperdrive create ${app}-db --connection-string "..." --json`);
    return null;
  }

  const hdName = `${app}-db`;
  const cmd = `wrangler hyperdrive create ${hdName} --connection-string "${connectionString}" --json`;

  console.log(`  Creating Hyperdrive: ${hdName}`);

  if (dryRun) {
    console.log(`  [DRY-RUN] ${cmd}`);
    return 'dry-run-hyperdrive-uuid';
  }

  const cfApiToken = requireEnv('CF_API_TOKEN');
  const cfAccountId = requireEnv('CF_ACCOUNT_ID');

  const raw = run(cmd, {
    dryRun: false,
    execOpts: {
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: cfApiToken,
        CLOUDFLARE_ACCOUNT_ID: cfAccountId,
      },
    },
  });

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse wrangler hyperdrive output: ${raw}`);
  }

  const uuid = parsed.id ?? parsed.result?.id;
  if (!uuid) throw new Error(`Hyperdrive UUID not found in output: ${raw}`);

  console.log(`  ✅ Hyperdrive UUID: ${uuid}`);
  return uuid;
}

// ─── Step C: Rate Limiter Registration ────────────────────────────────────────

function claimRateLimiterIds({ app, rateLimiterId, dryRun }) {
  section('C. Rate Limiter IDs');

  // Allocate 4 IDs: prod-auth, prod-api, staging-auth, staging-api
  const ids = {
    prod_auth:    rateLimiterId,
    prod_api:     rateLimiterId + 1,
    staging_auth: rateLimiterId + 2,
    staging_api:  rateLimiterId + 3,
  };

  console.log(`  Allocating IDs:`);
  console.log(`    prod AUTH_RATE_LIMITER:     ${ids.prod_auth}`);
  console.log(`    prod API_RATE_LIMITER:      ${ids.prod_api}`);
  console.log(`    staging AUTH_RATE_LIMITER:  ${ids.staging_auth}`);
  console.log(`    staging API_RATE_LIMITER:   ${ids.staging_api}`);

  // Patch the rate-limiter registry table in add-new-app.md
  const registryPath = resolve(ROOT, 'docs/runbooks/add-new-app.md');
  const content = readFileSync(registryPath, 'utf8');

  const nextIdLine = `**Next available ID: ${rateLimiterId}**`;
  if (!content.includes(nextIdLine)) {
    console.log(`  ⚠️  Could not find "Next available ID: ${rateLimiterId}" in add-new-app.md.`);
    console.log(`  Update the rate-limiter registry table manually.`);
    return ids;
  }

  const newRows = [
    `| ${app} (prod) | \`AUTH_RATE_LIMITER\` | ${ids.prod_auth} | 60/m/IP | Auth routes |`,
    `| ${app} (prod) | \`API_RATE_LIMITER\` | ${ids.prod_api} | 600/m/user | \`/v1/*\` authed routes |`,
    `| ${app} (staging) | \`AUTH_RATE_LIMITER\` | ${ids.staging_auth} | 60/m/IP | Staging auth |`,
    `| ${app} (staging) | \`API_RATE_LIMITER\` | ${ids.staging_api} | 600/m/user | Staging \`/v1/*\` |`,
  ].join('\n');

  const nextNextId = rateLimiterId + 4;
  const updatedContent = content
    .replace(nextIdLine, `${newRows}\n\n**Next available ID: ${nextNextId}**`);

  if (!dryRun) {
    writeFileSync(registryPath, updatedContent, 'utf8');
    console.log(`  ✅ docs/runbooks/add-new-app.md updated (next available ID now: ${nextNextId})`);
  } else {
    console.log(`  [DRY-RUN] Would update docs/runbooks/add-new-app.md → next available: ${nextNextId}`);
  }

  return ids;
}

// ─── Step D: GitHub Repo ──────────────────────────────────────────────────────

function createGitHubRepo({ app, dryRun }) {
  section('D. GitHub Repository');

  const cmd = `gh repo create Latimer-Woods-Tech/${app} --private --clone=false`;
  console.log(`  Creating: Latimer-Woods-Tech/${app}`);

  if (dryRun) {
    console.log(`  [DRY-RUN] ${cmd}`);
  } else {
    try {
      run(cmd, { dryRun: false });
      console.log(`  ✅ Repository created: https://github.com/Latimer-Woods-Tech/${app}`);
    } catch (err) {
      if (err.message.includes('already exists') || err.message.includes('Name already exists')) {
        console.log(`  ℹ️  Repository already exists — skipping.`);
      } else {
        throw err;
      }
    }
  }
}

// ─── Step E: Factory Repo GH Secrets ─────────────────────────────────────────

function setFactorySecrets({ app, envKey, connectionString, dryRun }) {
  section('E. Factory Repo GH Secrets');

  const FACTORY_REPO = 'Latimer-Woods-Tech/factory';

  function setSecret(name, value) {
    const cmd = `gh secret set ${name} --repo ${FACTORY_REPO} --body "${value}"`;
    console.log(`  Setting: ${name}`);
    if (!dryRun) run(cmd, { dryRun: false });
    else console.log(`  [DRY-RUN] ${cmd}`);
  }

  if (connectionString) {
    setSecret(`${envKey}_CONNECTION_STRING`, connectionString);
  } else {
    console.log(`  [skipped] ${envKey}_CONNECTION_STRING — no connection string (set manually)`);
  }

  // Generate a JWT secret
  let jwtSecret;
  if (!dryRun) {
    try {
      jwtSecret = run('openssl rand -base64 32', { dryRun: false });
    } catch {
      // openssl may not be available on Windows; use node crypto
      jwtSecret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    }
    setSecret(`JWT_SECRET_${envKey}`, jwtSecret);
  } else {
    console.log(`  [DRY-RUN] gh secret set JWT_SECRET_${envKey} --repo ${FACTORY_REPO} --body "<generated>"`);
  }

  console.log(`  ℹ️  Set SENTRY_DSN_${envKey} manually after creating Sentry project.`);
}

// ─── Step F: Patch setup-all-apps.mjs ─────────────────────────────────────────

function patchSetupAllApps({ app, workerName, envKey, extraSecrets, dryRun }) {
  section('F. Patch packages/deploy/scripts/setup-all-apps.mjs');

  const filePath = resolve(ROOT, 'packages/deploy/scripts/setup-all-apps.mjs');
  const content = readFileSync(filePath, 'utf8');

  // Check if already registered
  if (content.includes(`name: '${app}'`)) {
    console.log(`  ℹ️  '${app}' is already in APPS array — skipping.`);
    return;
  }

  const extraStr = extraSecrets.length
    ? `\n    extraSecrets: [${extraSecrets.map(s => `'${s}'`).join(', ')}],`
    : '\n    extraSecrets: [],';

  const newEntry = `  {
    name: '${app}',
    workerName: '${workerName}',
    envKey: '${envKey}',${extraStr}
  },`;

  // Insert before the closing bracket of the APPS array
  const insertMark = '];\n\n// ─── CLI Args';
  if (!content.includes(insertMark)) {
    console.log(`  ⚠️  Could not find APPS array closing bracket — patch manually.`);
    printSnippet('Add to APPS array in setup-all-apps.mjs', newEntry);
    return;
  }

  const updated = content.replace(insertMark, `${newEntry}\n${insertMark}`);

  if (!dryRun) {
    writeFileSync(filePath, updated, 'utf8');
    console.log(`  ✅ APPS array updated in setup-all-apps.mjs`);
  } else {
    console.log(`  [DRY-RUN] Would insert APPS entry for '${app}'`);
    printSnippet('New APPS entry', newEntry);
  }
}

// ─── Step G: Patch service-registry.yml ───────────────────────────────────────

function patchServiceRegistry({ app, workerName, domain, envKey, extraSecrets, dryRun }) {
  section('G. docs/service-registry.yml');

  const filePath = resolve(ROOT, 'docs/service-registry.yml');
  const content = readFileSync(filePath, 'utf8');

  if (content.includes(`  - id: ${app}\n`) || content.includes(`  - id: ${app}  `)) {
    console.log(`  ℹ️  '${app}' already in service-registry.yml — skipping.`);
    return;
  }

  const customDomainLine = domain !== 'none'
    ? `custom_domain: ${domain}                             # CF custom domain — attach via CF API\n    custom_domain_status: pending`
    : `custom_domain: null`;

  const workersDevUrl = `https://${workerName}.adrper79.workers.dev`;
  const canonicalUrl = domain !== 'none' ? `https://${domain}` : workersDevUrl;

  const requiredSecrets = ['JWT_SECRET', 'SENTRY_DSN', ...extraSecrets].map(s => `      - ${s}`).join('\n');

  const newEntry = `
  - id: ${app}
    name: ${workerName}                                      # matches wrangler.jsonc \`name\`
    repo: Latimer-Woods-Tech/${app}
    url: ${canonicalUrl}
    workers_dev_url: ${workersDevUrl}
    ${customDomainLine}
    health_endpoint: /health
    telemetry_required: false
    required_bindings:
      - DB
      - AUTH_RATE_LIMITER
    required_secrets:
${requiredSecrets}
    required_vars:
      - ENVIRONMENT
    consumers: []
`;


  // Append before end-of-file
  const updated = content.trimEnd() + '\n' + newEntry;

  if (!dryRun) {
    writeFileSync(filePath, updated, 'utf8');
    console.log(`  ✅ service-registry.yml updated`);
  } else {
    console.log(`  [DRY-RUN] Would append entry to service-registry.yml`);
    printSnippet('New service-registry entry', newEntry.trim());
  }
}

// ─── Step H: setup-app-secrets.yml patch hint ────────────────────────────────

function printSecretsWorkflowPatch({ app, envKey, extraSecrets }) {
  section('H. .github/workflows/setup-app-secrets.yml — manual patch required');

  const standardKeys = new Set(['SENTRY_DSN', 'POSTHOG_KEY', 'STRIPE_SECRET_KEY', 'JWT_SECRET']);
  const extraFiltered = extraSecrets.filter(s => !standardKeys.has(s));
  const standardVars = [
    `          SENTRY_DSN_${envKey}: \${{ secrets.SENTRY_DSN_${envKey} }}`,
    `          POSTHOG_KEY_${envKey}: \${{ secrets.POSTHOG_PROJECT_TOKEN }}`,
    `          STRIPE_SECRET_KEY_${envKey}: \${{ secrets.STRIPE_SECRET_KEY }}`,
    `          JWT_SECRET_${envKey}: \${{ secrets.JWT_SECRET_${envKey} }}`,
    ...extraFiltered.map(s => `          ${s}_${envKey}: \${{ secrets.${s} }}`),
  ];

  printSnippet('Add to env: block in setup-app-secrets.yml', standardVars.join('\n'));
  console.log('  ℹ️  Add these lines to the setup-app-secrets.yml env: block and commit.');
}

// ─── Step I: Wrangler.jsonc Snippet ───────────────────────────────────────────

function printWranglerSnippet({ app, workerName, domain, rateLimiterIds, hyperdriveUuid }) {
  section('I. wrangler.jsonc — copy into app repo');

  const hdBinding = hyperdriveUuid
    ? `  "hyperdrive": [{ "binding": "DB", "id": "${hyperdriveUuid}" }],`
    : `  "hyperdrive": [{ "binding": "DB", "id": "<HYPERDRIVE_UUID>" }],`;

  const routesBlock = domain !== 'none'
    ? `  "routes": [{ "pattern": "${domain}", "custom_domain": true }],`
    : '';

  const snippet = `{
  "name": "${workerName}",
  "compatibility_date": "2025-01-01",
  "compatibility_flags": ["nodejs_compat"],
  "main": "dist/index.js",
  "vars": {
    "ENVIRONMENT": "production"
  },
  ${hdBinding}
  "unsafe": {
    "bindings": [
      { "type": "ratelimit", "name": "AUTH_RATE_LIMITER", "namespace_id": "${rateLimiterIds.prod_auth}", "simple": { "limit": 60, "period": 60 } },
      { "type": "ratelimit", "name": "API_RATE_LIMITER",  "namespace_id": "${rateLimiterIds.prod_api}",  "simple": { "limit": 600, "period": 60 } }
    ]
  },
  ${routesBlock}
  "env": {
    "staging": {
      "vars": { "ENVIRONMENT": "staging" },
      "unsafe": {
        "bindings": [
          { "type": "ratelimit", "name": "AUTH_RATE_LIMITER", "namespace_id": "${rateLimiterIds.staging_auth}", "simple": { "limit": 60, "period": 60 } },
          { "type": "ratelimit", "name": "API_RATE_LIMITER",  "namespace_id": "${rateLimiterIds.staging_api}",  "simple": { "limit": 600, "period": 60 } }
        ]
      }
    }
  }
}`;

  printSnippet(`${app}/wrangler.jsonc`, snippet);
}

// ─── Step J: CLAUDE.md Standing Orders ───────────────────────────────────────

function printClaudeMd({ app, workerName, domain }) {
  section('J. .github/repo-contexts/CLAUDE.md — copy into app repo');

  const canonicalUrl = domain !== 'none' ? `https://${domain}` : `https://${workerName}.adrper79.workers.dev`;

  const claudeMd = `# ${app} — Standing Orders

## Stack
- Runtime: Cloudflare Workers only (Hono router)
- Database: Neon Postgres via Hyperdrive binding (\`env.DB\`)
- Auth: JWT self-managed with Web Crypto API
- Shared infra: \`@latimer-woods-tech/*\` packages from Factory Core
- Build: tsup (ESM only); Test: Vitest + @cloudflare/vitest-pool-workers

## Hard Constraints
- No \`process.env\` — use Hono/Worker bindings (\`c.env.VAR\` / \`env.VAR\`)
- No Node.js built-ins (fs, path, crypto) — use platform-safe APIs
- No CommonJS \`require()\` — ESM \`import\`/\`export\` only
- No \`Buffer\` — use \`Uint8Array\`, \`TextEncoder\`, \`TextDecoder\`
- No raw \`fetch\` without explicit error handling
- No \`*.workers.dev\` URLs in user-facing code
- Canonical public URL: ${canonicalUrl}

## Commit Format
\`<type>(${app}): <description>\`
Types: feat | fix | docs | test | refactor | chore | perf

## Quality Gates
- TypeScript strict, zero errors
- ESLint zero warnings
- Coverage: ≥90% lines/functions, ≥85% branches
- Build: tsup produces dist/ with no errors
`;

  printSnippet(`.github/repo-contexts/CLAUDE.md (in ${app} repo)`, claudeMd);
}

// ─── Step L: Scaffold App Code ───────────────────────────────────────────────

function scaffoldAndPush({ app, hyperdriveUuid, rateLimiterId, recipe, createRepo, dryRun }) {
  section('L. Scaffold App Code');

  const scaffoldScript = resolve(ROOT, 'packages/deploy/scripts/scaffold.mjs');
  const parts = [
    `node "${scaffoldScript}" ${app}`,
    hyperdriveUuid ? `--hyperdrive-id ${hyperdriveUuid}` : '',
    `--rate-limiter-id ${rateLimiterId}`,
    '--no-prereq',
    '--no-secrets',
    '--no-deploy',
    '--no-install',
    recipe ? `--recipe ${recipe}` : '',
  ].filter(Boolean);
  const cmd = parts.join(' ');

  console.log(`  Scaffolding: ${app}`);
  if (recipe) console.log(`  Recipe:      ${recipe}`);

  if (dryRun) {
    console.log(`  [DRY-RUN] ${cmd}`);
  } else {
    try {
      execSync(cmd, { stdio: 'inherit', cwd: ROOT });
    } catch (err) {
      throw new Error(`Scaffold failed: ${err.message}`);
    }
  }

  // Push local scaffold to the already-created GH repo (Step D)
  if (createRepo) {
    const appDir = resolve(ROOT, app);
    const remoteUrl = `https://github.com/Latimer-Woods-Tech/${app}.git`;
    const pushCmd = `git remote add origin ${remoteUrl} && git push -u origin main`;
    console.log(`  Pushing to:  ${remoteUrl}`);
    if (dryRun) {
      console.log(`  [DRY-RUN] cd ${appDir} && ${pushCmd}`);
    } else {
      try {
        execSync(pushCmd, { stdio: 'inherit', cwd: appDir });
        console.log(`  ✅ Pushed to ${remoteUrl}`);
      } catch {
        console.log(`  ⚠️  Auto-push failed — run manually:`);
        console.log(`     cd "${appDir}" && ${pushCmd}`);
      }
    }
  }
}

// ─── Step K: Domain Wiring Instructions ──────────────────────────────────────

function printDomainInstructions({ app, workerName, domain, dryRun }) {
  if (domain === 'none') return;

  section('K. Custom Domain — manual CF steps required');

  console.log(`  1. Add DNS CNAME: ${domain} → <cloudflare-ip-or-cname-target>`);
  console.log(`     (Cloudflare will show the target when you add the custom domain in the dashboard)`);
  console.log();
  console.log(`  2. Attach custom domain to worker via CF API:`);
  console.log(`     curl -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/scripts/${workerName}/domains" \\`);
  console.log(`          -H "Authorization: Bearer $CF_API_TOKEN" \\`);
  console.log(`          -H "Content-Type: application/json" \\`);
  console.log(`          -d '{"environment":"production","hostname":"${domain}","zone_id":"<ZONE_ID>"}'`);
  console.log();
  console.log(`  3. After attach, verify:`);
  console.log(`     curl https://${domain}/health`);
  console.log();
  console.log(`  4. Update service-registry.yml: custom_domain_status: attached`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const {
    app, workerName, db, domain,
    rateLimiterId, extraSecrets,
    createRepo, scaffold, recipe, dryRun,
  } = parseArgs();

  const envKey = toEnvKey(app);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Factory App Provisioner`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  App:            ${app}`);
  console.log(`  Worker:         ${workerName}`);
  console.log(`  DB:             ${db}`);
  console.log(`  Domain:         ${domain}`);
  console.log(`  Rate limiter:   ${rateLimiterId} (prod-auth), ${rateLimiterId+1} (prod-api), ${rateLimiterId+2} (stg-auth), ${rateLimiterId+3} (stg-api)`);
  console.log(`  Extra secrets:  ${extraSecrets.length ? extraSecrets.join(', ') : '(none)'}`);
  console.log(`  Scaffold:       ${scaffold ? (recipe ? `yes (recipe: ${recipe})` : 'yes') : 'no'}`);
  console.log(`  Dry run:        ${dryRun ? 'YES' : 'no'}`);

  // Validate required env
  if (!dryRun) {
    requireEnv('GITHUB_TOKEN');
    requireEnv('CF_API_TOKEN');
    requireEnv('CF_ACCOUNT_ID');
  }

  // A. Neon
  const neonResult = await provisionNeon({ app, db, envKey, dryRun });
  const connectionString = neonResult?.connectionString ?? null;

  // B. Hyperdrive
  const hyperdriveUuid = createHyperdrive({ app, connectionString, envKey, dryRun });

  // C. Rate limiter IDs + registry patch
  const rateLimiterIds = claimRateLimiterIds({ app, rateLimiterId, dryRun });

  // D. GitHub repo (optional)
  if (createRepo) {
    createGitHubRepo({ app, dryRun });
  } else {
    section('D. GitHub Repository');
    console.log(`  Skipped (pass --create-repo to create Latimer-Woods-Tech/${app})`);
  }

  // E. Factory repo GH secrets
  setFactorySecrets({ app, envKey, connectionString, dryRun });

  // F. setup-all-apps.mjs APPS patch
  patchSetupAllApps({ app, workerName, envKey, extraSecrets, dryRun });

  // G. service-registry.yml
  patchServiceRegistry({ app, workerName, domain, envKey, extraSecrets, dryRun });

  // H. setup-app-secrets.yml patch hint (manual — can't safely patch YAML programmatically)
  printSecretsWorkflowPatch({ app, envKey, extraSecrets });

  // I. wrangler.jsonc snippet
  printWranglerSnippet({ app, workerName, domain, rateLimiterIds, hyperdriveUuid });

  // J. CLAUDE.md
  printClaudeMd({ app, workerName, domain });

  // K. Domain wiring instructions
  printDomainInstructions({ app, workerName, domain, dryRun });

  // L. Scaffold (optional)
  if (scaffold) {
    scaffoldAndPush({ app, hyperdriveUuid, rateLimiterId, recipe, createRepo, dryRun });
  }

  // ── Final checklist ────────────────────────────────────────────────────────
  section('✅ Provisioning Complete — Remaining Manual Steps');
  console.log(`
  [ ] Create Sentry project for '${app}' and set SENTRY_DSN_${envKey} in Factory secrets
  [ ] Patch .github/workflows/setup-app-secrets.yml (see Section H above)
  [ ] Copy wrangler.jsonc snippet into ${app} repo (Section I)${scaffold ? ' — auto-done by scaffold' : ''}
  [ ] Copy .github/repo-contexts/CLAUDE.md into ${app} repo (Section J)
  [ ] Wire CF custom domain (Section K)${domain !== 'none' ? '' : ' — skipped (no domain)'}
  ${scaffold ? `[ ] Delete local scaffold dir if not needed: rm -rf ${app}/\n  ` : ''}[ ] Run: node packages/deploy/scripts/setup-all-apps.mjs --app ${app}
  [ ] Deploy worker and verify: curl https://${domain !== 'none' ? domain : workerName + '.adrper79.workers.dev'}/health
  `);
}

main().catch((err) => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
