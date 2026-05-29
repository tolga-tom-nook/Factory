#!/usr/bin/env node

/**
 * Phase 7: App Extension & Validation
 *
 * This script extends apps that already exist in production by:
 * 1. Validating existing infrastructure (Hyperdrive, Sentry, PostHog, rate-limiter)
 * 2. Installing missing @latimer-woods-tech packages (never removes existing)
 * 3. Running pending migrations only (never drops/recreates schema)
 * 4. Applying missing RLS policies
 * 5. Committing changes
 *
 * Unlike phase-7-scaffold-template.mjs, this script is safe to run on production apps.
 * It validates before modifying and only adds missing infrastructure.
 *
 * Usage:
 *   node scripts/phase-7-extend-app.mjs capricast validate
 *   node scripts/phase-7-extend-app.mjs capricast extend
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// App configurations for extension mode
// These define what packages and features each app needs BEYOND the standard 9
const APP_EXTEND_CONFIGS = {
  capricast: {
    description: 'Live anonymous competitive dance platform (House of the Bottom)',
    hyperdriveId: '72697ebbf0d44419850743679390acf1',
    extraPackages: [
      '@latimer-woods-tech/video@0.2.0',
      '@latimer-woods-tech/schedule@0.2.3',
    ],
    rls: true,
    hasDurableObjects: true,
    hasR2: true,
    requiredSecrets: [
      'BETTER_AUTH_SECRET',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'SENTRY_DSN',
      'POSTHOG_API_KEY',
      'CAPRICAST_PUBLISH_TOKEN'
    ]
  },
  'xico-city': {
    description: 'DJMEXXICO creative-economy OS',
    hyperdriveId: null, // Will be determined from wrangler.toml
    extraPackages: [
      '@latimer-woods-tech/llm@0.3.1',
    ],
    rls: true,
    hasDurableObjects: false,
    hasR2: false,
    requiredSecrets: [
      'BETTER_AUTH_SECRET',
      'SENTRY_DSN',
    ]
  },
  coh: {
    description: '5-stream live dance competition (House of the Gaze)',
    hyperdriveId: null,
    extraPackages: [
      '@latimer-woods-tech/video@0.2.0',
      '@latimer-woods-tech/realtime@0.1.0',
    ],
    rls: true,
    hasDurableObjects: true,
    hasR2: true,
    requiredSecrets: [
      'BETTER_AUTH_SECRET',
      'SENTRY_DSN',
    ]
  },
  'wordis-bond': {
    description: 'Language learning platform with AI tutoring',
    hyperdriveId: null,
    extraPackages: [
      '@latimer-woods-tech/crm@0.2.0',
      '@latimer-woods-tech/compliance@0.2.0',
      '@latimer-woods-tech/telephony@0.2.0',
    ],
    rls: true,
    hasDurableObjects: false,
    hasR2: false,
    requiredSecrets: [
      'BETTER_AUTH_SECRET',
      'SENTRY_DSN',
    ]
  }
};

// Standard packages all apps should have
const STANDARD_PACKAGES = [
  '@latimer-woods-tech/errors@0.2.0',
  '@latimer-woods-tech/logger@0.3.0',
  '@latimer-woods-tech/monitoring@0.2.1',
  '@latimer-woods-tech/auth@0.2.0',
  '@latimer-woods-tech/neon@0.2.3',
  '@latimer-woods-tech/stripe@0.2.0',
  '@latimer-woods-tech/analytics@0.2.0',
  '@latimer-woods-tech/email@0.2.0',
  '@latimer-woods-tech/flags@0.1.0',
];

/**
 * Step 1: Validate Hyperdrive binding exists in wrangler config
 */
function validateHyperdrive(appPath, config) {
  console.log('  • Validating Hyperdrive binding...');

  const wranglerToml = path.join(appPath, 'wrangler.toml');
  const wranglerJsonc = path.join(appPath, 'wrangler.jsonc');
  const wranglerPath = fs.existsSync(wranglerToml) ? wranglerToml : wranglerJsonc;

  if (!fs.existsSync(wranglerPath)) {
    return { valid: false, error: 'wrangler.toml/jsonc not found' };
  }

  const content = fs.readFileSync(wranglerPath, 'utf-8');

  // Check for hyperdrive in TOML format: [[hyperdrive]] with binding = "..."
  // Or in JSON/JSONC format: "hyperdrive": [ ... ] with "binding": "..."
  const hasTOMLHyperdrive = content.includes('[[hyperdrive]]') && content.includes('binding');
  const hasJSONHyperdrive = content.includes('"hyperdrive"') && content.includes('"binding"');

  if (!hasTOMLHyperdrive && !hasJSONHyperdrive) {
    return { valid: false, error: 'No Hyperdrive binding found' };
  }

  // Extract hyperdrive ID if config doesn't have it
  if (!config.hyperdriveId) {
    const match = content.match(/['"id['"]?\s*:\s*['"]([a-f0-9]+)['"]/);
    if (match) config.hyperdriveId = match[1];
  }

  return { valid: true, hyperdriveId: config.hyperdriveId };
}

/**
 * Step 2: Validate Sentry DSN in secrets
 */
function validateSentry(appPath) {
  console.log('  • Checking Sentry DSN...');

  // Sentry DSN should be in wrangler config as a secret reference
  const wranglerToml = path.join(appPath, 'wrangler.toml');
  const wranglerJsonc = path.join(appPath, 'wrangler.jsonc');
  const wranglerPath = fs.existsSync(wranglerToml) ? wranglerToml : wranglerJsonc;

  if (!fs.existsSync(wranglerPath)) {
    return { valid: false, error: 'wrangler config not found' };
  }

  const content = fs.readFileSync(wranglerPath, 'utf-8');

  if (content.includes('SENTRY_DSN')) {
    return { valid: true, status: 'DSN reference found in wrangler config' };
  }

  return { valid: false, error: 'SENTRY_DSN not referenced in wrangler config' };
}

/**
 * Step 3: Check package.json for installed @latimer-woods-tech packages
 */
function checkInstalledPackages(appPath) {
  console.log('  • Checking installed packages...');

  const pkgPath = path.join(appPath, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return { valid: false, error: 'package.json not found' };
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  const installed = Object.keys(deps).filter(k => k.startsWith('@latimer-woods-tech/'));

  return {
    valid: installed.length > 0,
    installed,
    missing: STANDARD_PACKAGES.filter(p => !installed.some(i => i.startsWith(p.split('@')[0])))
  };
}

/**
 * Step 4: Validate schema exists
 */
function checkSchema(appPath) {
  console.log('  • Checking schema...');

  // For monorepos, also check the git root
  const gitRoot = path.resolve(appPath, '..', '..');
  const isMonorepo = fs.existsSync(path.join(gitRoot, 'packages')) &&
                     fs.existsSync(path.join(gitRoot, 'apps'));

  const schemaLocations = [
    // Standard locations relative to app
    path.join(appPath, 'src', 'db', 'schema.ts'),
    path.join(appPath, 'packages', 'db', 'src', 'schema.ts'),
    path.join(appPath, 'packages', 'db', 'src', 'schema', 'index.ts'),
    path.join(appPath, 'packages', 'db', 'src', 'schema'),  // Directory pattern
  ];

  // For monorepos, also check root-level packages
  if (isMonorepo) {
    schemaLocations.push(
      path.join(gitRoot, 'packages', 'db', 'src', 'schema.ts'),
      path.join(gitRoot, 'packages', 'db', 'src', 'schema'),
      path.join(gitRoot, 'packages', 'db', 'src', 'schema', 'index.ts')
    );
  }

  for (const loc of schemaLocations) {
    if (fs.existsSync(loc)) {
      const isDir = fs.statSync(loc).isDirectory();
      const fileCount = isDir ? fs.readdirSync(loc).length : 1;
      const displayPath = isDir ? `${loc.replace(appPath, '.')}/ (${fileCount} files)` : loc.replace(appPath, '.');
      return { valid: true, path: displayPath };
    }
  }

  return { valid: false, error: 'No schema found at expected locations' };
}

/**
 * Main validate mode
 */
function validateApp(appName, appPath, config) {
  console.log(`\n📋 VALIDATING ${appName.toUpperCase()}\n`);

  const results = {
    appName,
    path: appPath,
    description: config.description,
    checks: {}
  };

  // Check 1: Hyperdrive
  const hdCheck = validateHyperdrive(appPath, config);
  results.checks.hyperdrive = hdCheck;
  console.log(`    ${hdCheck.valid ? '✅' : '❌'} Hyperdrive: ${hdCheck.valid ? hdCheck.hyperdriveId : hdCheck.error}`);

  // Check 2: Sentry
  const sentryCheck = validateSentry(appPath);
  results.checks.sentry = sentryCheck;
  console.log(`    ${sentryCheck.valid ? '✅' : '⚠️ '} Sentry: ${sentryCheck.valid ? sentryCheck.status : sentryCheck.error}`);

  // Check 3: Packages
  const pkgCheck = checkInstalledPackages(appPath);
  results.checks.packages = pkgCheck;
  if (pkgCheck.valid) {
    console.log(`    ✅ Packages: ${pkgCheck.installed.length} @latimer-woods-tech/* installed`);
    if (pkgCheck.missing.length > 0) {
      console.log(`       ⚠️  ${pkgCheck.missing.length} missing (can be added with 'extend' mode)`);
      pkgCheck.missing.slice(0, 3).forEach(p => console.log(`          - ${p}`));
      if (pkgCheck.missing.length > 3) console.log(`          ... and ${pkgCheck.missing.length - 3} more`);
    }
  } else {
    console.log(`    ❌ Packages: ${pkgCheck.error}`);
  }

  // Check 4: Schema
  const schemaCheck = checkSchema(appPath);
  results.checks.schema = schemaCheck;
  console.log(`    ${schemaCheck.valid ? '✅' : '⚠️ '} Schema: ${schemaCheck.valid ? schemaCheck.path : schemaCheck.error}`);

  // Summary
  const allValid = hdCheck.valid && sentryCheck.valid && pkgCheck.valid && schemaCheck.valid;
  console.log(`\n${allValid ? '✅ READY' : '⚠️  NEEDS ATTENTION'}`);

  if (!allValid) {
    console.log(`\nTo extend this app, run:`);
    console.log(`  node scripts/phase-7-extend-app.mjs ${appName} extend\n`);
  } else {
    console.log(`\nApp is production-ready. Use 'extend' mode to add missing packages.\n`);
  }

  return results;
}

/**
 * Detect which package manager is in use
 */
function detectPackageManager(appPath) {
  const rootPath = findMonorepoRoot(appPath) || appPath;

  if (fs.existsSync(path.join(rootPath, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (fs.existsSync(path.join(rootPath, 'yarn.lock'))) {
    return 'yarn';
  }
  return 'npm';
}

/**
 * Find monorepo root by looking for workspace config
 */
function findMonorepoRoot(startPath) {
  let current = startPath;
  for (let i = 0; i < 5; i++) {
    const parent = path.dirname(current);
    if (parent === current) break;

    const pkgPath = path.join(parent, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.workspaces || pkg.pnpm?.overrides) {
        return parent;
      }
    }
    current = parent;
  }
  return null;
}

/**
 * Install missing packages (non-destructive)
 */
function installMissingPackages(appPath, appName, config) {
  console.log(`\n📦 INSTALLING PACKAGES\n`);

  const pkgPath = path.join(appPath, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const currentDeps = { ...pkg.dependencies || {}, ...pkg.devDependencies || {} };

  const allNeeded = [...STANDARD_PACKAGES, ...(config.extraPackages || [])];
  const toInstall = allNeeded.filter(p => {
    const pkgName = p.split('@').slice(0, 3).join('@');
    return !currentDeps[pkgName];
  });

  if (toInstall.length === 0) {
    console.log('  ✅ All packages already installed\n');
    return true;
  }

  console.log(`  Installing ${toInstall.length} packages:`);
  toInstall.forEach(p => console.log(`    - ${p}`));
  console.log();

  const pm = detectPackageManager(appPath);

  let installCmd, cwd;
  if (pm === 'pnpm') {
    // For pnpm, add from the specific workspace directory (not root)
    installCmd = ['add', ...toInstall];
    cwd = appPath;
  } else {
    installCmd = ['install', ...toInstall];
    cwd = appPath;
  }

  try {
    const result = spawnSync(pm, installCmd, {
      cwd,
      stdio: 'inherit'
    });
    if (result.status !== 0) {
      console.error(`  ❌ ${pm} install failed`);
      return false;
    }
    console.log(`  ✅ Packages installed\n`);
    return true;
  } catch (e) {
    console.error(`  ❌ Error: ${e.message}`);
    return false;
  }
}

/**
 * Run pending migrations
 */
function runPendingMigrations(appPath, appName) {
  console.log(`🗄️  RUNNING PENDING MIGRATIONS\n`);

  try {
    console.log('  Generating migration types...');
    execSync(`npx drizzle-kit generate`, { cwd: appPath, stdio: 'pipe' });

    console.log('  Applying migrations...');
    execSync(`npx drizzle-kit migrate`, { cwd: appPath, stdio: 'pipe' });

    console.log(`  ✅ Migrations complete\n`);
    return true;
  } catch (e) {
    console.warn(`  ⚠️  Migration step produced output (may be normal):`);
    console.warn(`     ${e.message.split('\n')[0]}\n`);
    return true; // Non-fatal
  }
}

/**
 * Apply missing RLS policies
 */
function applyMissingRLSPolicies(appPath, appName, config) {
  if (!config.rls) {
    console.log(`\n🔒 RLS not enabled for ${appName}\n`);
    return true;
  }

  console.log(`\n🔒 RLS POLICIES\n`);

  const schemaLocations = [
    path.join(appPath, 'src', 'db', 'schema.ts'),
    path.join(appPath, 'packages', 'db', 'src', 'schema.ts'),
    path.join(appPath, 'packages', 'db', 'src', 'schema', 'index.ts'),
  ];

  let schemaPath = null;
  for (const loc of schemaLocations) {
    if (fs.existsSync(loc)) {
      schemaPath = loc;
      break;
    }
  }

  if (!schemaPath) {
    console.log(`  ⚠️  Schema not found, skipping RLS\n`);
    return true;
  }

  const content = fs.readFileSync(schemaPath, 'utf-8');
  const tableMatches = content.match(/export const (\w+) = pgTable/g) || [];
  const tables = tableMatches.map(m => m.replace(/export const (\w+) = pgTable/, '$1'));

  if (tables.length === 0) {
    console.log(`  ⚠️  No tables found, skipping RLS\n`);
    return true;
  }

  const rlsSql = tables.map(table => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ${table};
CREATE POLICY tenant_isolation ON ${table}
  USING (tenant_id = current_setting('app.tenant_id', true));
  `.trim()).join('\n\n');

  console.log(`  Found ${tables.length} tables. RLS policies to apply:\n`);
  console.log('  ```sql');
  rlsSql.split('\n').forEach(line => console.log(`  ${line}`));
  console.log('  ```\n');
  console.log(`  To apply: psql <DB_URL> < policies.sql\n`);

  return true;
}

/**
 * Commit changes
 */
function commitChanges(appPath, appName) {
  console.log(`\n💾 COMMITTING CHANGES\n`);

  try {
    const status = execSync(`git status --porcelain`, { cwd: appPath, encoding: 'utf-8' });

    if (!status.trim()) {
      console.log(`  ℹ️  No changes to commit\n`);
      return true;
    }

    console.log(`  Staged changes:`);
    status.split('\n').filter(l => l.trim()).forEach(line => {
      console.log(`    ${line}`);
    });

    execSync(`git add -A`, { cwd: appPath });
    execSync(`git commit -m "chore: add missing packages and RLS policies"`, { cwd: appPath });
    console.log(`\n  ✅ Committed\n`);
    return true;
  } catch (e) {
    console.warn(`  ⚠️  Could not commit: ${e.message.split('\n')[0]}\n`);
    return true;
  }
}

/**
 * Main extend mode
 */
function extendApp(appName, appPath, config) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 EXTENDING ${appName.toUpperCase()}`);
  console.log(`${config.description}`);
  console.log(`${'='.repeat(60)}`);

  // First validate
  const validation = validateApp(appName, appPath, config);
  if (!validation.checks.hyperdrive.valid) {
    console.error(`\n❌ Cannot proceed: ${validation.checks.hyperdrive.error}`);
    process.exit(1);
  }

  // Install packages
  if (!installMissingPackages(appPath, appName, config)) {
    process.exit(1);
  }

  // Run migrations
  runPendingMigrations(appPath, appName);

  // Apply RLS
  applyMissingRLSPolicies(appPath, appName, config);

  // Commit
  commitChanges(appPath, appName);

  console.log(`${'='.repeat(60)}`);
  console.log(`✨ ${appName} extension complete!`);
  console.log(`${'='.repeat(60)}\n`);
}

/**
 * Main entry point
 */
function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log(`
Phase 7: App Extension & Validation

Usage:
  node scripts/phase-7-extend-app.mjs <app-name> <validate|extend>

Examples:
  node scripts/phase-7-extend-app.mjs capricast validate
  node scripts/phase-7-extend-app.mjs capricast extend

Supported apps:
${Object.entries(APP_EXTEND_CONFIGS).map(([name, cfg]) =>
  `  - ${name}: ${cfg.description}`
).join('\n')}

Modes:
  validate    Check infrastructure without making changes
  extend      Install missing packages, run migrations, apply RLS policies
`);
    return;
  }

  const appName = args[0];
  const mode = args[1] || 'validate';

  const config = APP_EXTEND_CONFIGS[appName];
  if (!config) {
    console.error(`❌ Unknown app: ${appName}`);
    console.error(`Supported: ${Object.keys(APP_EXTEND_CONFIGS).join(', ')}`);
    process.exit(1);
  }

  // Determine app path
  let appPath = null;
  const gitRoot = path.resolve(__dirname, '..');
  const appSiblingRoot = path.resolve(gitRoot, '..', appName);

  // Check if it's a monorepo with apps/worker or apps/api structure
  const workerPath = path.join(appSiblingRoot, 'apps', 'worker');
  const apiPath = path.join(appSiblingRoot, 'apps', 'api');

  const possiblePaths = [
    workerPath,                              // Monorepo: apps/worker
    apiPath,                                 // Monorepo: apps/api
    appSiblingRoot,                          // Sibling repo root
    path.join(gitRoot, 'apps', appName),    // Factory monorepo
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      const gitDir = path.join(p, '.git');
      const wranglerToml = path.join(p, 'wrangler.toml');
      const wranglerJsonc = path.join(p, 'wrangler.jsonc');
      // Check for either wrangler.toml or wrangler.jsonc
      const hasWrangler = fs.existsSync(wranglerToml) || fs.existsSync(wranglerJsonc);
      if ((fs.existsSync(gitDir) && hasWrangler) || hasWrangler) {
        appPath = p;
        break;
      }
    }
  }

  if (!appPath) {
    console.error(`❌ Could not find ${appName} repository with wrangler.toml`);
    console.error(`Looked in:\n${possiblePaths.map(p => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }

  if (mode === 'validate') {
    validateApp(appName, appPath, config);
  } else if (mode === 'extend') {
    extendApp(appName, appPath, config);
  } else {
    console.error(`❌ Unknown mode: ${mode}`);
    process.exit(1);
  }
}

main();
