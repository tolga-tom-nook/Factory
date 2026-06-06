#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = join(ROOT, 'docs', 'service-registry.yml');
const VALID_STATES = new Set(['planned', 'provisioned', 'live', 'broken', 'retired']);
const TIMEOUT_MS = Number(process.env.HEALTH_PROBE_TIMEOUT_MS || 8000);
const REQUIRE_EXPLICIT_STATE = process.argv.includes('--require-state');
const CHECK_NON_LIVE = process.argv.includes('--check-broken');

function inferState(entry) {
  if (entry.health_state) return entry.health_state;
  const deployment = String(entry.deployment_status || '').toLowerCase();
  const custom = String(entry.custom_domain_status || '').toLowerCase();
  if (deployment.startsWith('live_health_verified') || custom === 'attached') return 'live';
  if (deployment.includes('retired') || deployment.includes('detached')) return 'retired';
  if (deployment.includes('provisioned')) return 'provisioned';
  if (entry.url && entry.health_endpoint) return 'live';
  return 'planned';
}

function healthUrl(entry) {
  if (!entry.url || !entry.health_endpoint) return null;
  return String(entry.url).replace(/\/$/, '') + '/' + String(entry.health_endpoint).replace(/^\//, '');
}

async function probe(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal, headers: { accept: 'application/json,text/plain,*/*' } });
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, sample: text.slice(0, 180).replace(/\s+/g, ' ') };
  } catch (error) {
    return { ok: false, status: 'error', sample: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function entriesOf(section, registry) {
  const rows = Array.isArray(registry[section]) ? registry[section] : [];
  return rows.map((entry) => ({ section, ...entry }));
}

const registry = yaml.load(readFileSync(REGISTRY, 'utf8')) || {};
const entries = [...entriesOf('workers', registry), ...entriesOf('pages', registry)];
const failures = [];
const warnings = [];
const results = [];

for (const entry of entries) {
  const state = inferState(entry);
  const url = healthUrl(entry);
  if (!VALID_STATES.has(state)) failures.push(`\u001b[31m${entry.id}: invalid health_state ${state}\u001b[0m`);
  if (REQUIRE_EXPLICIT_STATE && !entry.health_state) failures.push(`\u001b[31m${entry.id}: missing explicit health_state\u001b[0m`);
  if (state === 'live') {
    if (!url) {
      failures.push(`\u001b[31m${entry.id}: live but missing url or health_endpoint\u001b[0m`);
      continue;
    }
    const result = await probe(url);
    results.push({ id: entry.id, state, url, ...result });
    if (!result.ok) failures.push(`\u001b[31m${entry.id}: ${url} returned ${result.status} \u2014 ${result.sample}\u001b[0m`);
  } else {
    if (!entry.notes && !entry.deployment_status) warnings.push(`\u001b[33m${entry.id}: ${state} without notes/deployment_status\u001b[0m`);
    if (CHECK_NON_LIVE && url) {
      const result = await probe(url);
      results.push({ id: entry.id, state, url, ...result });
    }
  }
}

for (const result of results) {
  const mark = result.ok ? '\u2713' : '\u2717';
  console.log(`\u001b[${result.ok ? '32' : '31'}m${mark}\u001b[0m ${result.id} [${result.state}] ${result.status} ${result.url}`);
}
for (const warning of warnings) console.warn(warning);
if (failures.length) {
  console.error('\nService registry health verification failed:');
  for (const failure of failures) console.error('- ' + failure);
  process.exit(1);
}
console.log(`Service registry health verification passed for ${results.length} probed live endpoint(s).`);
