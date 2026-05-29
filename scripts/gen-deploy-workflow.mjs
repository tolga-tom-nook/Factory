#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const recipeId = getFlagValue('--recipe');
const planPath = getFlagValue('--plan');
const outputPath = getFlagValue('--output') ? resolve(process.cwd(), getFlagValue('--output')) : process.cwd();
const appNameFlag = getFlagValue('--app-name');

if (recipeId && planPath) {
  console.error('Usage: node scripts/gen-deploy-workflow.mjs [--recipe <id> | --plan <path>] [--app-name <name>] [--output <dir>]');
  process.exit(1);
}

const appName = appNameFlag ?? await inferAppName(outputPath);
const compiledPlanPath = planPath
  ? resolve(process.cwd(), planPath)
  : recipeId
    ? join(ROOT_DIR, 'capabilities', 'compiled', `${recipeId}.plan.json`)
    : null;

const plan = compiledPlanPath ? await loadPlan(compiledPlanPath, recipeId) : null;
const healthPath = determineHealthPath(plan?.expectedSurfaces ?? []);
const healthUrl = appName
  ? `https://${appName}.latwoodtech.work${healthPath}`
  : `https://REPLACE_WITH_APP_DOMAIN${healthPath}`;

const workflowsDir = join(outputPath, '.github', 'workflows');
await mkdir(workflowsDir, { recursive: true });
await writeFile(join(workflowsDir, 'ci.yml'), renderCiWorkflow(), 'utf8');
await writeFile(join(workflowsDir, 'deploy.yml'), renderDeployWorkflow(healthUrl), 'utf8');

console.log(`Generated deploy workflows in: ${workflowsDir}`);
console.log(`- CI workflow: ${join(workflowsDir, 'ci.yml')}`);
console.log(`- Deploy workflow: ${join(workflowsDir, 'deploy.yml')}`);
console.log(`Health probe URL template: ${healthUrl}`);

function renderCiWorkflow() {
  return `name: CI

on:
  push:
    branches: [main, 'feature/**']
  pull_request:
    branches: [main]

jobs:
  ci:
    uses: Latimer-Woods-Tech/factory/.github/workflows/_app-ci.yml@main
    secrets: inherit
`;
}

function renderDeployWorkflow(healthUrl) {
  return `name: Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      environment:
        description: Target environment
        required: true
        default: production
        type: choice
        options: [production, staging]

jobs:
  deploy:
    uses: Latimer-Woods-Tech/factory/.github/workflows/_app-deploy.yml@main
    with:
      environment: production
      health_url: ${healthUrl}
    secrets: inherit
`;
}

function determineHealthPath(surfaces) {
  if (surfaces.includes('/health')) return '/health';
  if (surfaces.includes('/manifest')) return '/manifest';
  const healthCandidate = surfaces.find((surface) => surface.startsWith('/health'));
  if (healthCandidate) return healthCandidate;
  return surfaces.find((surface) => surface.startsWith('/')) ?? '/health';
}

async function loadPlan(path, recipeIdArg) {
  await ensureCompiledPlan(path, recipeIdArg);
  const planRaw = await readFile(path, 'utf8');
  return JSON.parse(planRaw);
}

async function inferAppName(outputDir) {
  try {
    await stat(outputDir);
    return basename(outputDir);
  } catch {
    return basename(outputDir);
  }
}

async function ensureCompiledPlan(path, recipeIdArg) {
  try {
    await stat(path);
    return;
  } catch {
    if (!recipeIdArg) {
      console.error(`Compiled plan not found: ${path}`);
      process.exit(1);
    }
  }

  console.log(`Compiled plan not found at ${path}. Generating from recipe ${recipeIdArg}...`);
  try {
    execFileSync('node', ['scripts/compile-capability-recipe.mjs', '--recipe', recipeIdArg, '--output', path], {
      stdio: 'inherit',
      cwd: ROOT_DIR,
    });
  } catch (error) {
    console.error('Failed to compile capability recipe:', error.message);
    process.exit(1);
  }
}

function getFlagValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}
