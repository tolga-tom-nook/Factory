#!/usr/bin/env node
/**
 * gate.mjs — Phase 3 (GATE) of the Platform Brain.
 *
 * The single decision function the proposer (opportunity-scan.mjs) and, later, the
 * planner (Phase 4) consult before acting. Implements the locked hybrid-autonomy
 * boundary: low-risk findings auto-file tickets the supervisor executes; strategic
 * moves route into the weekly human-reviewed brief. FRIDGE always wins.
 *
 *   evaluate(candidate, ctx) -> { decision: 'auto-file' | 'brief' | 'reject', reasons: [] }
 *
 * Usable as a library (import { evaluate }) or CLI:
 *   node scripts/gate.mjs '{"type":"missing-registry","target":"lead-gen","app":"lead-gen"}'
 *
 * Node 20+ (exempt from CF constraints).
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── The hybrid autonomy boundary (mirrors docs plan "Decisions (locked)") ──
export const AUTO_FILE_TYPES = new Set([
  'missing-registry',
  'stale-registry',
  'stale-doc',
  'broken-link',
  'regressed-kpi',
  'open-gap-no-ticket',
  'cross-app-duplication',
  'low-cohesion',
  'dep-bump',
  'cve',
]);

export const BRIEF_TYPES = new Set([
  'roadmap-reorder',
  'new-app',
  'kill-app',
  'stage-transition',
  'big-spend',
  'cross-app-feature-gap', // strategic: proposes new product scope → human decides
  'pricing-change',
]);

let _denylistCache = null;
async function loadDenylist() {
  if (_denylistCache) return _denylistCache;
  const fpath = join(ROOT, 'docs', 'service-registry.yml');
  if (!existsSync(fpath)) return (_denylistCache = []);
  try {
    const doc = yaml.load(await readFile(fpath, 'utf8'));
    _denylistCache = (doc?.automation_denylist ?? []).map((d) => ({
      id: d.id,
      repo: d.repo,
      scope: d.scope,
    }));
  } catch {
    _denylistCache = [];
  }
  return _denylistCache;
}

/**
 * @param {object} candidate { type, target, app?, repo?, title?, severity?, irreversible? }
 * @param {object} ctx       { denylist? } (injectable for tests)
 */
export async function evaluate(candidate, ctx = {}) {
  const reasons = [];
  const denylist = ctx.denylist ?? (await loadDenylist());

  // 1. FRIDGE rule 1 — automation denylist (e.g. wordis-bond frontend / TCPA hold).
  const hit = denylist.find(
    (d) =>
      (candidate.repo && d.repo && candidate.repo.toLowerCase() === d.repo.toLowerCase()) ||
      (candidate.target && d.id && String(candidate.target).toLowerCase().includes(String(d.id).toLowerCase())) ||
      (candidate.app && d.id && String(d.id).toLowerCase().includes(String(candidate.app).toLowerCase())),
  );
  if (hit) {
    reasons.push(`FRIDGE rule 1: ${hit.id} (${hit.scope}) is on the automation denylist — never auto-file`);
    return { decision: 'reject', reasons };
  }

  // 2. Irreversible actions always require a human (FRIDGE rule 8).
  if (candidate.irreversible) {
    reasons.push('Irreversible action — routes to weekly brief for human approval (FRIDGE rule 8)');
    return { decision: 'brief', reasons };
  }

  // 3. Explicit strategic types → brief.
  if (BRIEF_TYPES.has(candidate.type)) {
    reasons.push(`Type "${candidate.type}" is strategic — routes to weekly brief for human ✅`);
    return { decision: 'brief', reasons };
  }

  // 4. Low-risk types → auto-file (supervisor executes).
  if (AUTO_FILE_TYPES.has(candidate.type)) {
    reasons.push(`Type "${candidate.type}" is low-risk and templated — auto-file for supervisor execution`);
    return { decision: 'auto-file', reasons };
  }

  // 5. Unknown → conservative default: brief.
  reasons.push(`Unrecognized type "${candidate.type}" — defaulting to brief (gate is fail-safe)`);
  return { decision: 'brief', reasons };
}

// ── CLI ──
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('gate.mjs')) {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: node scripts/gate.mjs \'{"type":"missing-registry","target":"lead-gen"}\'');
    process.exit(2);
  }
  evaluate(JSON.parse(arg))
    .then((res) => console.log(JSON.stringify(res, null, 2)))
    .catch((err) => {
      console.error('gate failed:', err);
      process.exit(1);
    });
}
