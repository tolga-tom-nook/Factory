#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseJsonc } from 'jsonc-parser';
import yaml from 'js-yaml';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PATH = join(ROOT_DIR, 'docs', 'service-registry.yml');
const WORKFLOWS_DIR = join(ROOT_DIR, '.github', 'workflows');

const WORKFLOW_RULES = [
  {
    path: '.github/workflows/deploy-admin-studio.yml',
    section: 'workers',
    verifier: 'verify-deployment.mjs',
    matchMode: 'base-url',
    targets: [
      { id: 'admin-studio-staging', key: 'default' },
      { id: 'admin-studio-production', key: 'default' },
    ],
  },
  {
    path: '.github/workflows/deploy-admin-studio-ui.yml',
    section: 'pages',
    verifier: 'verify-http-endpoint.mjs',
    targets: [
      { id: 'admin-studio-ui', key: 'production' },
      { id: 'admin-studio-ui', key: 'staging' },
    ],
  },
  {
    path: '.github/workflows/deploy-daily-brief.yml',
    section: 'workers',
    verifier: 'verify-http-endpoint.mjs',
    targets: [{ id: 'daily-brief', key: 'default' }],
  },
  {
    path: '.github/workflows/deploy-lead-gen.yml',
    section: 'workers',
    verifier: 'verify-http-endpoint.mjs',
    targets: [{ id: 'lead-gen', key: 'default' }],
  },
  {
    path: '.github/workflows/deploy-schedule-worker.yml',
    section: 'workers',
    verifier: 'verify-http-endpoint.mjs',
    targets: [{ id: 'schedule-worker', key: 'default' }],
  },
  {
    path: '.github/workflows/deploy-factory-cross-repo.yml',
    section: 'workers',
    verifier: 'curl -s -o /dev/null',
    matchMode: 'base-url',
    targets: [
      { id: 'factory-cross-repo', key: 'staging' },
      { id: 'factory-cross-repo', key: 'production' },
    ],
  },
  {
    path: '.github/workflows/deploy-status-prober.yml',
    section: 'workers',
    verifier: 'verify-http-endpoint.mjs',
    targets: [{ id: 'status-prober', key: 'default' }],
  },
  {
    path: '.github/workflows/deploy-supervisor.yml',
    section: 'workers',
    verifier: 'curl -s -o /dev/null',
    matchMode: 'base-url',
    targets: [
      { id: 'factory-supervisor', key: 'staging' },
      { id: 'factory-supervisor', key: 'production' },
    ],
  },
  {
    path: '.github/workflows/deploy-agent-gateway.yml',
    section: 'workers',
    verifier: 'curl -s -o /dev/null',
    matchMode: 'base-url',
    targets: [
      { id: 'factory-agent-gateway', key: 'staging' },
      { id: 'factory-agent-gateway', key: 'production' },
    ],
  },
  {
    path: '.github/workflows/deploy-synthetic-monitor.yml',
    section: 'workers',
    verifier: 'verify-http-endpoint.mjs',
    targets: [{ id: 'synthetic-monitor', key: 'default' }],
  },
  {
    path: '.github/workflows/deploy-video-cron.yml',
    section: 'workers',
    verifier: 'verify-http-endpoint.mjs',
    targets: [{ id: 'video-cron', key: 'default' }],
  },
  {
    path: '.github/workflows/deploy-webhook-fanout.yml',
    section: 'workers',
    verifier: 'verify-http-endpoint.mjs',
    targets: [{ id: 'webhook-fanout', key: 'default' }],
  },
  {
    path: '.github/workflows/deploy-factory-core-api.yml',
    section: 'workers',
    verifier: 'verify-http-endpoint.mjs',
    targets: [{ id: 'factory-core-api', key: 'default' }],
  },
  {
    path: '.github/workflows/deploy-qa-tools-worker.yml',
    section: 'workers',
    verifier: 'verify-http-endpoint.mjs',
    targets: [{ id: 'qa-tools-worker', key: 'default' }],
  },
];

// Keep contract validation intentionally narrow. This only covers local workers
// whose current registry entries already declare required secrets/vars/bindings
// and whose deploy path is simple enough that name-based drift checks stay
// high-signal.
const CONTRACT_RULES = [
  {
    id: 'admin-studio-staging',
    workflowPath: '.github/workflows/deploy-admin-studio.yml',
    wranglerPath: 'apps/admin-studio/wrangler.jsonc',
    envName: 'staging',
  },
  {
    id: 'admin-studio-production',
    workflowPath: '.github/workflows/deploy-admin-studio.yml',
    wranglerPath: 'apps/admin-studio/wrangler.jsonc',
    envName: 'production',
  },
  {
    id: 'schedule-worker',
    workflowPath: '.github/workflows/deploy-schedule-worker.yml',
    wranglerPath: 'apps/schedule-worker/wrangler.jsonc',
    envName: 'production',
  },
  {
    id: 'video-cron',
    workflowPath: '.github/workflows/deploy-video-cron.yml',
    wranglerPath: 'apps/video-cron/wrangler.jsonc',
    envName: 'production',
  },
  {
    id: 'synthetic-monitor',
    workflowPath: '.github/workflows/deploy-synthetic-monitor.yml',
    wranglerPath: 'apps/synthetic-monitor/wrangler.jsonc',
    envName: 'production',
  },
  {
    id: 'lead-gen',
    workflowPath: '.github/workflows/deploy-lead-gen.yml',
    wranglerPath: 'apps/lead-gen/wrangler.jsonc',
    envName: 'production',
  },
  {
    id: 'webhook-fanout',
    workflowPath: '.github/workflows/deploy-webhook-fanout.yml',
    wranglerPath: 'apps/webhook-fanout/wrangler.jsonc',
    envName: 'production',
  },
  {
    id: 'daily-brief',
    workflowPath: '.github/workflows/deploy-daily-brief.yml',
    wranglerPath: 'apps/daily-brief/wrangler.jsonc',
    envName: 'production',
  },
  {
    id: 'factory-supervisor',
    workflowPath: '.github/workflows/deploy-supervisor.yml',
    wranglerPath: 'apps/supervisor/wrangler.jsonc',
    envName: 'production',
  },
];

const EXPLICIT_EXEMPTIONS = new Map([
  // Pages site for latwoodtech.com — service-registry entry + WORKFLOW_RULES coverage
  // tracked in the latwoodtech-web onboarding work; exempted here until that lands.
  ['.github/workflows/deploy-latwoodtech-web.yml', 'latwoodtech.com Pages site — pending service-registry registration'],
  // Added 2026-05-24 alongside the github-hardening pass. These two deploy
  // workflows were introduced (#994 and predecessor) without registering their
  // services in docs/service-registry.yml or wiring WORKFLOW_RULES coverage
  // above. Exempting unblocks the validate-service-registry CI step; the
  // follow-up is to add full coverage (verifier + targets + registry entry)
  // for both Workers in a dedicated PR.
  ['.github/workflows/deploy-inbound-oracle.yml', 'inbound-oracle Worker — pending service-registry registration'],
  ['.github/workflows/deploy-linkedin-publisher.yml', 'linkedin-publisher Worker — pending service-registry registration'],
  // Cron-only Worker (workers_dev:false, no public route) — fires */15 to replay
  // failed derivations. No HTTP verifier step by design, so it cannot use a
  // URL-based WORKFLOW_RULES entry; the registry entry documents the cron contract.
  ['.github/workflows/deploy-factory-events-replay.yml', 'factory-events-replay — cron-only Worker, no public route to verify'],
  // Internal engineering dashboard deployed via _app-deploy-pages.yml reusable workflow.
  // No custom domain attached in Phase 1 (health_url is empty in the deploy workflow).
  // Full verification coverage will be added when the domain is provisioned.
  ['.github/workflows/deploy-qa-tools-ui.yml', 'qa-tools-ui — internal Pages app, no health_url in Phase 1 deploy; pending domain attachment'],
  // Developer Index Pages site at dev.latimerwoods.dev. Self-verifies via curl
  // marker check in the deploy workflow itself rather than the standard
  // verify-http-endpoint.mjs path, so WORKFLOW_RULES coverage would be
  // redundant. Registry entry: latimerwoods-dev (pages section).
  ['.github/workflows/deploy-latimerwoods-dev.yml', 'latimerwoods-dev — Pages site self-verifies inline; no per-target verifier needed'],
]);

const registry = await loadRegistry(REGISTRY_PATH);
const localDeployWorkflows = await listLocalDeployWorkflows(WORKFLOWS_DIR);

const errors = [];
const coverageErrors = validateWorkflowCoverage(localDeployWorkflows);
errors.push(...coverageErrors);

for (const rule of WORKFLOW_RULES) {
  const workflowPath = join(ROOT_DIR, rule.path);
  const workflowText = await readFile(workflowPath, 'utf8');
  const presentUrls = extractUrls(workflowText);

  if (!workflowText.includes(rule.verifier)) {
    errors.push(`${rule.path}: expected verification marker "${rule.verifier}" was not found`);
  }

  for (const target of rule.targets) {
    const entry = getRegistryEntry(registry, rule.section, target.id);
    const expectedUrl = getExpectedVerificationUrl(entry, target.key, rule.section);
    const workflowUrl = toWorkflowMatchUrl(expectedUrl, entry, rule.matchMode);
    if (!presentUrls.has(workflowUrl)) {
      errors.push(formatMissingUrlError(rule.path, target.id, target.key, workflowUrl, presentUrls));
    }
  }
}

for (const contractRule of CONTRACT_RULES) {
  const entry = getRegistryEntry(registry, 'workers', contractRule.id);
  const workflowText = await readFile(join(ROOT_DIR, contractRule.workflowPath), 'utf8');
  const wranglerText = await readFile(join(ROOT_DIR, contractRule.wranglerPath), 'utf8');
  const wranglerConfig = parseWranglerConfig(wranglerText, contractRule.wranglerPath);
  const contract = collectWranglerContract(wranglerConfig, contractRule.envName);

  validateRequiredNames({
    errors,
    filePath: contractRule.workflowPath,
    workerId: contractRule.id,
    category: 'required_secrets',
    names: entry.required_secrets,
    predicate: (name) => workflowContainsName(workflowText, name),
  });

  validateRequiredNames({
    errors,
    filePath: contractRule.wranglerPath,
    workerId: contractRule.id,
    category: 'required_bindings',
    names: entry.required_bindings,
    predicate: (name) => contract.bindings.has(name),
  });

  validateRequiredNames({
    errors,
    filePath: `${contractRule.wranglerPath} | ${contractRule.workflowPath}`,
    workerId: contractRule.id,
    category: 'required_vars',
    names: entry.required_vars,
    predicate: (name) => contract.vars.has(name) || workflowContainsName(workflowText, name),
  });
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[validate-service-registry] ${error}`);
  }
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  checkedWorkflows: WORKFLOW_RULES.length,
  checkedContracts: CONTRACT_RULES.length,
  exemptedWorkflows: EXPLICIT_EXEMPTIONS.size,
  checkedAt: new Date().toISOString(),
}, null, 2));

async function loadRegistry(filePath) {
  const raw = await readFile(filePath, 'utf8');
  const parsed = yaml.load(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('service registry is empty or invalid');
  }
  return parsed;
}

async function listLocalDeployWorkflows(workflowsDir) {
  const entries = await readdir(workflowsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^deploy-.*\.yml$/u.test(entry.name))
    .map((entry) => `.github/workflows/${entry.name}`)
    .sort();
}

function validateWorkflowCoverage(localDeployWorkflows) {
  const covered = new Set(WORKFLOW_RULES.map((rule) => rule.path));
  const exempted = new Set(EXPLICIT_EXEMPTIONS.keys());
  const issues = [];

  for (const workflow of localDeployWorkflows) {
    if (!covered.has(workflow) && !exempted.has(workflow)) {
      issues.push(`${workflow}: local deploy workflow is not covered by validate-service-registry.mjs`);
    }
  }

  for (const workflow of exempted) {
    if (!localDeployWorkflows.includes(workflow)) {
      issues.push(`${workflow}: exemption exists but the workflow file does not exist`);
    }
  }

  return issues;
}

function parseWranglerConfig(text, filePath) {
  const errors = [];
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || !parsed || typeof parsed !== 'object') {
    throw new Error(`Unable to parse ${filePath} as JSONC`);
  }
  return parsed;
}

function getRegistryEntry(registry, section, id) {
  const entries = registry[section];
  if (!Array.isArray(entries)) {
    throw new Error(`Registry section "${section}" is missing or invalid`);
  }

  const entry = entries.find((candidate) => candidate?.id === id);
  if (!entry) {
    throw new Error(`Missing ${section} registry entry for id "${id}"`);
  }
  return entry;
}

function collectWranglerContract(config, envName) {
  const selectedEnv = config.env && typeof config.env === 'object' ? config.env[envName] : undefined;
  const sources = [config, selectedEnv].filter(Boolean);
  const vars = new Set();
  const bindings = new Set();

  for (const source of sources) {
    if (source.vars && typeof source.vars === 'object') {
      for (const key of Object.keys(source.vars)) {
        vars.add(key);
      }
    }
    collectBindingNames(source, bindings);
  }

  return { vars, bindings };
}

function collectBindingNames(value, bindings) {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectBindingNames(item, bindings);
    }
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === 'binding' && typeof child === 'string') {
      bindings.add(child);
    }
    if (key === 'name' && typeof child === 'string' && typeof value.class_name === 'string') {
      bindings.add(child);
    }
    collectBindingNames(child, bindings);
  }
}

function validateRequiredNames({ errors, filePath, workerId, category, names, predicate }) {
  if (!Array.isArray(names) || names.length === 0) {
    return;
  }

  for (const name of names) {
    if (!predicate(String(name))) {
      errors.push(`${filePath}: ${workerId} is missing ${category} entry ${name}`);
    }
  }
}

function getExpectedVerificationUrl(entry, key, section) {
  const explicitTargets = entry.verification_targets;
  if (explicitTargets && typeof explicitTargets === 'object' && explicitTargets[key]) {
    return normalizeUrl(String(explicitTargets[key]));
  }

  if (section === 'workers') {
    if (key !== 'default') {
      throw new Error(`Worker ${entry.id} requires an explicit verification_targets.${key} value`);
    }
    return deriveWorkerVerificationUrl(entry);
  }

  if (section === 'pages') {
    return derivePageVerificationUrl(entry, key);
  }

  throw new Error(`Unsupported registry section "${section}"`);
}

function deriveWorkerVerificationUrl(entry) {
  const baseUrl = entry.workers_dev_url ?? entry.url;
  const healthEndpoint = entry.health_endpoint;
  if (!baseUrl || !healthEndpoint) {
    throw new Error(`Worker ${entry.id} must define either verification_targets.default or both a base URL and health_endpoint`);
  }

  return normalizeUrl(new URL(String(healthEndpoint), String(baseUrl)).toString());
}

function derivePageVerificationUrl(entry, key) {
  if (key === 'production') {
    if (!entry.custom_domain) {
      throw new Error(`Page ${entry.id} is missing custom_domain required for production verification`);
    }
    return normalizeUrl(`https://${String(entry.custom_domain)}`);
  }

  if (key === 'staging') {
    if (!entry.staging_url) {
      throw new Error(`Page ${entry.id} is missing staging_url required for staging verification`);
    }
    return normalizeUrl(String(entry.staging_url));
  }

  throw new Error(`Page ${entry.id} does not support verification target key "${key}"`);
}

function extractUrls(text) {
  const matches = text.match(/https:\/\/[^\s"'`\\]+/gu) ?? [];
  return new Set(matches.map((value) => normalizeUrl(value)));
}

function workflowContainsName(text, name) {
  const escapedName = escapeRegExp(name);
  const exactLine = new RegExp(`^\\s*${escapedName}\\s*$`, 'mu');
  const keyValue = new RegExp(`\\b${escapedName}\\b\\s*:`, 'u');
  const putSecret = new RegExp(`(?:wrangler\\s+secret\\s+put|secret\\s+put|put_secret|fetch_to_env)\\s+${escapedName}\\b`, 'u');
  const cliVar = new RegExp(`--var\\s+${escapedName}:`, 'u');

  return exactLine.test(text)
    || keyValue.test(text)
    || putSecret.test(text)
    || cliVar.test(text)
    || text.includes(name);
}

function normalizeUrl(url) {
  const parsed = new URL(url);
  if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
    parsed.port = '';
  }
  if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }
  parsed.hash = '';
  return parsed.toString();
}

function formatMissingUrlError(workflowPath, id, key, expectedUrl, presentUrls) {
  const observed = [...presentUrls].sort();
  const observedMessage = observed.length > 0
    ? `observed URLs: ${observed.join(', ')}`
    : 'observed URLs: none';
  return `${workflowPath}: expected verification URL for ${id} (${key}) is ${expectedUrl}; ${observedMessage}`;
}

function toWorkflowMatchUrl(expectedUrl, entry, matchMode = 'exact') {
  if (matchMode === 'exact') {
    return expectedUrl;
  }

  if (matchMode === 'base-url') {
    const endpoint = entry.health_endpoint;
    if (!endpoint) {
      throw new Error(`Worker ${entry.id} cannot use base-url matching without a health_endpoint`);
    }

    const parsed = new URL(expectedUrl);
    const normalizedEndpoint = endpoint === '/' ? '/' : endpoint.replace(/\/$/u, '');
    if (parsed.pathname !== normalizedEndpoint) {
      throw new Error(`Worker ${entry.id} expected verification target ${expectedUrl} does not end with health endpoint ${endpoint}`);
    }

    parsed.pathname = '/';
    return normalizeUrl(parsed.toString());
  }

  throw new Error(`Unsupported match mode "${matchMode}"`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
