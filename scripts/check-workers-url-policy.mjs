#!/usr/bin/env node
/**
 * check-workers-url-policy.mjs
 *
 * Two-part enforcement:
 *
 * 1. CANONICAL FORMAT CHECK (FRH-03)
 *    docs/templates must use the full `*.adrper79.workers.dev` form — never
 *    the short `*.workers.dev` form (which would target a different account).
 *
 * 2. USER-FACING FILES CHECK (CLAUDE.md Hard Constraints)
 *    HTML and frontend JS/TS files may NOT contain any `*.workers.dev` URL.
 *    Every user-facing endpoint must use a branded custom domain from
 *    docs/service-registry.yml. Use the `custom_domain` field, never
 *    `workers_dev_url`.
 *
 * 3. DECOMMISSIONED OPERATOR URL CHECK
 *    Known retired or implementation-only operator URLs must not appear outside
 *    explicit infrastructure reconciliation code.
 *
 * Exit 1 on any violation.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ACCOUNT_SUBDOMAIN = 'adrper79';
const URL_REGEX = /https?:\/\/[^\s'"`)>,]+/g;
const DECOMMISSIONED_URLS = [
  {
    text: 'https://staging.admin-studio-ui.pages.dev',
    replacement: 'https://staging.admin.latimerwoods.dev',
  },
  {
    text: 'https://staging.qa-tools-ui.pages.dev',
    replacement: 'https://staging.qa.latimerwoods.dev',
  },
  {
    text: 'https://factory-core-api.latwoodtech.work',
    replacement: 'https://core.latwoodtech.work',
  },
  {
    text: 'https://qa-tools.adrper79.workers.dev',
    replacement: 'https://api.qa.latimerwoods.dev',
  },
];
const DECOMMISSIONED_URL_ALLOWED_FILES = new Set([
  '.github/workflows/cf-domain-reconcile.yml',
  'scripts/check-workers-url-policy.mjs',
]);
const DECOMMISSIONED_SCAN_EXTS = new Set([
  '',
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsonc',
  '.jsx',
  '.md',
  '.mjs',
  '.ts',
  '.tsx',
  '.toml',
  '.yml',
  '.yaml',
]);

// ---------------------------------------------------------------------------
// Part 1 — Canonical format check (FRH-03)
// These files must not use short `*.workers.dev` form.
// ---------------------------------------------------------------------------
const CANONICAL_FORMAT_FILES = [
  'docs/APP_README_TEMPLATE.md',
  'docs/runbooks/environment-isolation-and-verification.md',
  'packages/deploy/scripts/scaffold.mjs',
];

const violations = [];

for (const relativePath of CANONICAL_FORMAT_FILES) {
  const absolutePath = path.resolve(relativePath);
  let content;
  try {
    content = readFileSync(absolutePath, 'utf8');
  } catch {
    // File may not exist in all branches — skip silently.
    continue;
  }
  const lines = content.split(/\r?\n/);

  lines.forEach((line, index) => {
    const matches = line.match(URL_REGEX);
    if (!matches) return;

    for (const rawUrl of matches) {
      let parsed;
      try {
        parsed = new URL(rawUrl);
      } catch {
        continue;
      }

      const host = parsed.hostname.toLowerCase();
      if (!host.endsWith('.workers.dev')) continue;
      // Canonical form is OK.
      if (host.endsWith(`.${ACCOUNT_SUBDOMAIN}.workers.dev`)) continue;

      violations.push({
        check: 'canonical-format',
        file: relativePath,
        line: index + 1,
        url: rawUrl,
        hint: `Use ${host.split('.')[0]}.${ACCOUNT_SUBDOMAIN}.workers.dev or a branded custom domain`,
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Part 2 — User-facing files must NOT contain any *.workers.dev URL.
// Scans HTML files under apps/ and _external_reviews/.
// ---------------------------------------------------------------------------

/** Extensions considered user-facing (rendered by browsers / API clients). */
const USER_FACING_EXTS = new Set(['.html', '.htm']);

/** Directory subtrees to scan. */
const SCAN_ROOTS = ['apps', '_external_reviews'];

/** Directory names to skip entirely during traversal (never descend into these). */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.wrangler',
  '.cache',
  'coverage',
  '.nyc_output',
]);

/** File path substrings: files whose relative path contains one of these are
 *  allowed to reference workers.dev (CI config, wrangler config, test fixtures). */
const ALLOWED_PATH_SUBSTRINGS = [
  'scripts/',
  '.github/',
  'docs/',
  'wrangler',
  'vitest',
  '__tests__',
];

function shouldSkipFile(relPath) {
  const normalised = relPath.replace(/\\/g, '/');
  return ALLOWED_PATH_SUBSTRINGS.some((p) => normalised.includes(p));
}

function walkDir(dir, callback) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // Dir may not exist in all environments.
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue; // fast prune before stat

    const full = path.join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkDir(full, callback);
    } else {
      callback(full);
    }
  }
}

for (const root of SCAN_ROOTS) {
  walkDir(path.resolve(root), (absolutePath) => {
    const ext = path.extname(absolutePath).toLowerCase();
    if (!USER_FACING_EXTS.has(ext)) return;

    const relativePath = path.relative(process.cwd(), absolutePath);
    if (shouldSkipFile(relativePath)) return;

    let content;
    try {
      content = readFileSync(absolutePath, 'utf8');
    } catch {
      return;
    }

    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      const matches = line.match(URL_REGEX);
      if (!matches) return;

      for (const rawUrl of matches) {
        let parsed;
        try {
          parsed = new URL(rawUrl);
        } catch {
          continue;
        }

        const host = parsed.hostname.toLowerCase();
        if (!host.endsWith('.workers.dev')) continue;

        violations.push({
          check: 'user-facing-no-workers-dev',
          file: relativePath,
          line: index + 1,
          url: rawUrl,
          hint: 'Replace with branded custom_domain from docs/service-registry.yml',
        });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Part 3 — Known decommissioned / implementation-only operator URLs.
// ---------------------------------------------------------------------------
const DECOMMISSIONED_SCAN_ROOTS = [
  'README.md',
  'docs',
  'apps',
  'scripts',
  '.github/workflows',
];

function scanFileForDecommissionedUrls(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  if (DECOMMISSIONED_URL_ALLOWED_FILES.has(normalized)) return;
  if (normalized.includes('/coverage/') || normalized.includes('/dist/')) return;
  if (!DECOMMISSIONED_SCAN_EXTS.has(path.extname(normalized).toLowerCase())) return;

  let content;
  try {
    content = readFileSync(path.resolve(relativePath), 'utf8');
  } catch {
    return;
  }
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const entry of DECOMMISSIONED_URLS) {
      if (!line.includes(entry.text)) continue;
      violations.push({
        check: 'decommissioned-operator-url',
        file: normalized,
        line: index + 1,
        url: entry.text,
        hint: `Use ${entry.replacement}`,
      });
    }
  });
}

for (const root of DECOMMISSIONED_SCAN_ROOTS) {
  const absoluteRoot = path.resolve(root);
  let stat;
  try {
    stat = statSync(absoluteRoot);
  } catch {
    continue;
  }
  if (stat.isDirectory()) {
    walkDir(absoluteRoot, (absolutePath) => {
      const relativePath = path.relative(process.cwd(), absolutePath);
      scanFileForDecommissionedUrls(relativePath);
    });
  } else {
    scanFileForDecommissionedUrls(root);
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (violations.length === 0) {
  console.log('✓ workers.dev URL policy check passed.');
  process.exit(0);
}

const canonical = violations.filter((v) => v.check === 'canonical-format');
const userFacing = violations.filter((v) => v.check === 'user-facing-no-workers-dev');
const decommissioned = violations.filter((v) => v.check === 'decommissioned-operator-url');

if (canonical.length > 0) {
  console.error('\n[canonical-format] Non-canonical workers.dev URLs in docs/templates:');
  console.error(`  Expected host suffix: .${ACCOUNT_SUBDOMAIN}.workers.dev`);
  for (const v of canonical) {
    console.error(`  ${v.file}:${v.line}  ${v.url}`);
    console.error(`    → ${v.hint}`);
  }
}

if (userFacing.length > 0) {
  console.error('\n[user-facing-no-workers-dev] Bare workers.dev URLs in user-facing files:');
  for (const v of userFacing) {
    console.error(`  ${v.file}:${v.line}  ${v.url}`);
    console.error(`    → ${v.hint}`);
  }
}

if (decommissioned.length > 0) {
  console.error('\n[decommissioned-operator-url] Retired or implementation-only operator URLs found:');
  for (const v of decommissioned) {
    console.error(`  ${v.file}:${v.line}  ${v.url}`);
    console.error(`    → ${v.hint}`);
  }
}

console.error(`\n${violations.length} violation(s) found. Fix before merging.`);
process.exit(1);
