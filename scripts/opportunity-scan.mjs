#!/usr/bin/env node
/**
 * opportunity-scan.mjs — Phase 3 (PROPOSE) of the Platform Brain.
 *
 * Scans the entity graph for opportunities, scores each against docs/objectives.yml
 * (balanced composite), passes it through scripts/gate.mjs, then either auto-files a
 * DEDUPLICATED GitHub issue (low-risk) or parks it for the weekly brief (strategic).
 *
 * This is the answer to "should my repos write self-improvement tickets every hour?"
 * — yes, scored and gated, with exactly one open issue per finding (fingerprint dedup).
 *
 * Scanners:
 *   missing-registry       app lacks feature-registry.yml (live/product)      -> auto-file
 *   low-cohesion           product cohesion below objectives.cohesion.floor   -> auto-file
 *   open-gap-no-ticket     open P0/P1 gap with no tracking issue              -> auto-file
 *   regressed-kpi          app cohesion dropped (from kpis.movers)            -> auto-file
 *   cross-app-feature-gap  feature in >=2 products, missing in another        -> brief (strategic)
 *
 * Usage:
 *   node scripts/opportunity-scan.mjs              # dry-run (default): print decisions
 *   node scripts/opportunity-scan.mjs --apply      # actually file/park
 *   node scripts/opportunity-scan.mjs --min-score 20
 *
 * Requires gh CLI authenticated (GH_TOKEN). Node 20+ (exempt from CF constraints).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import { evaluate } from './gate.mjs';

const execFileP = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GRAPH_FILE = join(ROOT, 'docs', 'registry', 'entity-graph.json');
const OBJECTIVES_FILE = join(ROOT, 'docs', 'objectives.yml');
const PARKED_FILE = join(ROOT, 'docs', 'planning', 'opportunities-parked.json');
const REPO = 'Latimer-Woods-Tech/Factory';

const APPLY = process.argv.includes('--apply');
const MIN_SCORE = (() => {
  const i = process.argv.indexOf('--min-score');
  return i !== -1 ? Number(process.argv[i + 1]) || 0 : 0;
})();

// ── Scoring: balanced composite (axis profiles per opportunity type) ──
const AXIS = {
  'missing-registry':      { revenueImpact: 0.1, cohesionImpact: 0.6, strategicBreadth: 0.3, riskReduction: 0.2 },
  'low-cohesion':          { revenueImpact: 0.2, cohesionImpact: 0.9, strategicBreadth: 0.2, riskReduction: 0.5 },
  'open-gap-no-ticket':    { revenueImpact: 0.2, cohesionImpact: 0.5, strategicBreadth: 0.2, riskReduction: 0.8 },
  'regressed-kpi':         { revenueImpact: 0.3, cohesionImpact: 0.6, strategicBreadth: 0.2, riskReduction: 0.7 },
  'cross-app-feature-gap': { revenueImpact: 0.4, cohesionImpact: 0.2, strategicBreadth: 0.9, riskReduction: 0.2 },
};
const TIER_MULT = { p0: 1.0, p1: 0.8, p2: 0.5, p3: 0.3 };

function scoreOf(candidate, objectives) {
  const w = objectives.weights ?? {};
  const axis = AXIS[candidate.type] ?? { revenueImpact: 0.3, cohesionImpact: 0.3, strategicBreadth: 0.3, riskReduction: 0.3 };
  const base =
    (w.revenueImpact ?? 0) * axis.revenueImpact +
    (w.cohesionImpact ?? 0) * axis.cohesionImpact +
    (w.strategicBreadth ?? 0) * axis.strategicBreadth +
    (w.riskReduction ?? 0) * axis.riskReduction;
  const sw = objectives.strategicWeight ?? {};
  const mult = sw[candidate.app] ?? sw._default ?? 1;
  const tierMult = candidate.tier ? TIER_MULT[candidate.tier] ?? 1 : 1;
  return Math.round(base * mult * tierMult * 100);
}

const fingerprint = (c) => `${c.type}:${c.target}`;
const marker = (c) => `<!-- opp:${fingerprint(c)} -->`;

// ── Scanners ──
function scanMissingRegistry(graph) {
  // Only products need a feature-registry.yml. Internal/infra workers are surfaced
  // as shadow nodes in the graph for visibility but don't each warrant a ticket.
  return (graph.nodes?.apps ?? [])
    .filter((a) => a.registryStatus === 'missing' && a.kind === 'product')
    .map((a) => ({
      type: 'missing-registry',
      target: a.id,
      app: a.id,
      repo: a.repo,
      title: `feat(registry): add feature-registry.yml for ${a.name}`,
      detail: `${a.name} (${a.kind}, lifecycle=${a.lifecycleStage ?? 'n/a'}) has no feature-registry.yml, so it is invisible to the platform dashboard and the planning loop. Add one per docs/standards/feature-registry.schema.yml.`,
    }));
}

function scanLowCohesion(graph, objectives) {
  const floor = objectives.cohesion?.floor ?? 50;
  return (graph.nodes?.apps ?? [])
    .filter((a) => a.kind === 'product' && a.cohesion != null && a.cohesion < floor)
    .map((a) => ({
      type: 'low-cohesion',
      target: a.id,
      app: a.id,
      repo: a.repo,
      title: `chore(cohesion): raise ${a.name} cohesion (${a.cohesion} < floor ${floor})`,
      detail: `${a.name} cohesion is ${a.cohesion}, below the objectives floor of ${floor}. Lowest-scoring conformance dimensions are the place to start (see docs/conformance/${a.id}.json).`,
    }));
}

function scanOpenGaps(graph) {
  return (graph.nodes?.gaps ?? [])
    .filter((g) => g.tier === 'p0' || g.tier === 'p1')
    .map((g) => ({
      type: 'open-gap-no-ticket',
      target: g.id,
      app: '_platform',
      tier: g.tier,
      title: `chore(gap): track ${g.id} — ${g.title}`.slice(0, 120),
      detail: `GAP_REGISTER ${g.tier.toUpperCase()} gap ${g.id} ("${g.title}") is open with status ${g.status}. Ensure it has a tracking issue and an owner.`,
    }));
}

function scanRegressedKpi(graph) {
  const movers = graph.kpis?.movers?.cohesion ?? [];
  return movers
    .filter((m) => m.delta != null && m.delta <= -2)
    .map((m) => ({
      type: 'regressed-kpi',
      target: m.app,
      app: m.app,
      title: `fix(cohesion): investigate ${m.app} cohesion regression (${m.prior}→${m.current})`,
      detail: `${m.app} cohesion dropped ${m.delta} over ${m.dayGap ?? '?'}d (${m.prior}→${m.current}). Identify which conformance dimension regressed.`,
    }));
}

function scanCrossAppFeatureGap(graph) {
  const products = (graph.nodes?.apps ?? []).filter((a) => a.kind === 'product');
  const productIds = new Set(products.map((a) => a.id));
  const featuresByApp = {};
  for (const f of graph.nodes?.features ?? []) {
    if (!productIds.has(f.appId)) continue;
    const norm = (f.label || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    (featuresByApp[f.appId] ??= new Map()).set(norm, f.label);
  }
  // label -> set of apps that have it
  const labelApps = {};
  for (const [appId, m] of Object.entries(featuresByApp)) {
    for (const [norm, label] of m) {
      (labelApps[norm] ??= { label, apps: new Set() }).apps.add(appId);
    }
  }
  const out = [];
  for (const [norm, { label, apps }] of Object.entries(labelApps)) {
    if (apps.size < 2) continue; // only features shared by >=2 products are "platform patterns"
    for (const p of products) {
      if (!featuresByApp[p.id]?.has(norm)) {
        out.push({
          type: 'cross-app-feature-gap',
          target: `${p.id}:${norm.replace(/\s+/g, '-')}`,
          app: p.id,
          title: `feat(${p.id}): consider "${label}" (present in ${[...apps].join(', ')})`,
          detail: `"${label}" is live in ${apps.size} products (${[...apps].join(', ')}) but absent from ${p.name}. Possible cross-pollination opportunity — strategic, so routed to the weekly brief.`,
        });
      }
    }
  }
  return out;
}

// ── Dedup against existing open issues ──
async function existingFingerprints() {
  try {
    const { stdout } = await execFileP('gh', [
      'issue', 'list', '--repo', REPO, '--label', 'opportunity', '--state', 'open',
      '--json', 'number,title,body', '--limit', '300',
    ]);
    const issues = JSON.parse(stdout);
    const set = new Set();
    for (const it of issues) {
      const m = (it.body || '').match(/<!-- opp:([^>]+?) -->/g) || [];
      for (const tag of m) set.add(tag.replace('<!-- opp:', '').replace(' -->', '').trim());
    }
    return set;
  } catch (err) {
    console.warn(`WARN: could not list issues for dedup (${err.message}); assuming none open`);
    return new Set();
  }
}

async function fileIssue(c, score, reasons) {
  const labels = ['opportunity', `opportunity:${c.type}`];
  if (c.type === 'missing-registry') labels.push('registry:missing');
  const body = [
    c.detail,
    '',
    `**Opportunity score:** ${score} (balanced composite, app weight applied)`,
    `**Gate decision:** auto-file — ${reasons.join('; ')}`,
    `**Source:** Platform Brain opportunity-scan (Phase 3). Fingerprint dedups re-runs.`,
    '',
    marker(c),
  ].join('\n');
  await execFileP('gh', [
    'issue', 'create', '--repo', REPO,
    '--title', c.title,
    '--body', body,
    ...labels.flatMap((l) => ['--label', l]),
  ]);
}

async function ensureLabels() {
  // Best-effort: create labels we rely on (idempotent; ignore "already exists").
  const labels = [
    ['opportunity', 'BFD4F2'],
    ['opportunity:missing-registry', 'C5DEF5'],
    ['opportunity:low-cohesion', 'C5DEF5'],
    ['opportunity:open-gap-no-ticket', 'C5DEF5'],
    ['opportunity:regressed-kpi', 'C5DEF5'],
    ['registry:missing', 'FEF2C0'],
  ];
  for (const [name, color] of labels) {
    try {
      await execFileP('gh', ['label', 'create', name, '--repo', REPO, '--color', color, '--force']);
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  if (!existsSync(GRAPH_FILE)) throw new Error('entity-graph.json missing — run build-entity-graph.mjs first');
  const graph = JSON.parse(await readFile(GRAPH_FILE, 'utf8'));
  const objectives = yaml.load(await readFile(OBJECTIVES_FILE, 'utf8'));

  const candidates = [
    ...scanMissingRegistry(graph),
    ...scanLowCohesion(graph, objectives),
    ...scanOpenGaps(graph),
    ...scanRegressedKpi(graph),
    ...scanCrossAppFeatureGap(graph),
  ].map((c) => ({ ...c, score: scoreOf(c, objectives) }))
    .filter((c) => c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);

  const existing = APPLY ? await existingFingerprints() : new Set();
  if (APPLY) await ensureLabels();

  const parked = [];
  let filed = 0, dupSkipped = 0, rejected = 0;
  const rows = [];

  for (const c of candidates) {
    const { decision, reasons } = await evaluate(c);
    let action;
    if (decision === 'reject') {
      action = 'reject';
      rejected++;
    } else if (decision === 'brief') {
      action = 'park→brief';
      parked.push({ ...c, decision, reasons });
    } else if (decision === 'auto-file') {
      if (existing.has(fingerprint(c))) {
        action = 'dup-skip';
        dupSkipped++;
      } else if (APPLY) {
        await fileIssue(c, c.score, reasons);
        existing.add(fingerprint(c));
        action = 'FILED';
        filed++;
      } else {
        action = 'would-file';
      }
    }
    rows.push({ score: c.score, type: c.type, target: c.target, decision, action });
  }

  // Persist parked (strategic) opportunities for the Phase 4 weekly brief.
  if (APPLY && parked.length) {
    await mkdir(dirname(PARKED_FILE), { recursive: true });
    await writeFile(
      PARKED_FILE,
      JSON.stringify({ generatedAt: new Date().toISOString(), parked }, null, 2) + '\n',
      'utf8',
    );
  }

  console.log(`\nOpportunity scan — ${candidates.length} candidates (min-score ${MIN_SCORE}, ${APPLY ? 'APPLY' : 'DRY-RUN'})\n`);
  console.log('score  type                   target                         decision    action');
  console.log('-----  ---------------------  -----------------------------  ----------  ----------');
  for (const r of rows) {
    console.log(
      `${String(r.score).padStart(5)}  ${r.type.padEnd(21)}  ${String(r.target).slice(0, 29).padEnd(29)}  ${r.decision.padEnd(10)}  ${r.action}`,
    );
  }
  console.log(
    `\nSummary: ${filed} filed, ${dupSkipped} dup-skipped, ${parked.length} parked→brief, ${rejected} rejected` +
      `${APPLY ? '' : ' (dry-run — re-run with --apply to act)'}`,
  );
}

main().catch((err) => {
  console.error('opportunity-scan failed:', err);
  process.exit(1);
});
