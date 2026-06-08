#!/usr/bin/env node
/**
 * planning-session.mjs — Phase 4 (PROPOSE→EXECUTE, brief path) of the Platform Brain.
 *
 * The weekly "synergistic planning session". Loads the whole entity graph + KPI
 * trends + objectives + parked strategic opportunities and synthesizes a strategic
 * brief for human review — the gated path of the hybrid-autonomy boundary.
 *
 * Deterministic by design (no LLM/secret dependency) so it always runs. An optional
 * LLM enrichment pass can be layered later via scripts/council.mjs.
 *
 * Reads:
 *   docs/registry/entity-graph.json        (nodes + kpis)
 *   docs/objectives.yml                     (north-star + weights + stage criteria)
 *   docs/planning/opportunities-parked.json (strategic candidates parked by opportunity-scan)
 * Writes:
 *   docs/planning/brief-<YYYY-MM-DD>.md
 *
 * Runs weekly (Mondays) — aligns with the existing review cadence. Node 20+.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

const execFileP = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GRAPH = join(ROOT, 'docs', 'registry', 'entity-graph.json');
const OBJECTIVES = join(ROOT, 'docs', 'objectives.yml');
const PARKED = join(ROOT, 'docs', 'planning', 'opportunities-parked.json');
const REPO = 'Latimer-Woods-Tech/Factory';

const readJson = async (p, d = null) => (existsSync(p) ? JSON.parse(await readFile(p, 'utf8')) : d);
const fmtDelta = (d) => (d == null ? '—' : d > 0 ? `▲ +${d}` : d < 0 ? `▼ ${d}` : 'flat');

/** Evaluate north-star measures against current graph state. */
function evalNorthStar(graph, objectives) {
  const apps = graph.nodes?.apps ?? [];
  const products = apps.filter((a) => a.kind === 'product');
  const cohesions = products.map((a) => a.cohesion).filter((c) => c != null);
  const minCohesion = cohesions.length ? Math.min(...cohesions) : null;
  const liveApps = apps.filter((a) => a.lifecycleStage === 'live' || a.maturity != null);
  const registryMissing = liveApps.filter((a) => a.registryStatus === 'missing').length;
  const gaps = graph.kpis?.current?.gaps ?? { p0: 0, p1: 0 };
  const threshold = objectives.cohesion?.shadowThreshold ?? 70;

  return [
    {
      goal: 'All product cohesion ≥ 70',
      ok: minCohesion != null && minCohesion >= threshold,
      detail: `lowest product cohesion = ${minCohesion ?? 'n/a'} (threshold ${threshold})`,
    },
    {
      goal: 'Every live app has a feature-registry.yml',
      ok: registryMissing === 0,
      detail: `${registryMissing} live app(s) missing a registry`,
    },
    {
      goal: 'Zero open P0/P1 gaps',
      ok: (gaps.p0 ?? 0) === 0 && (gaps.p1 ?? 0) === 0,
      detail: `P0=${gaps.p0 ?? 0}, P1=${gaps.p1 ?? 0}`,
    },
  ];
}

async function openOpportunityCount() {
  try {
    const { stdout } = await execFileP('gh', [
      'issue', 'list', '--repo', REPO, '--label', 'opportunity', '--state', 'open',
      '--json', 'number', '--limit', '300',
    ]);
    return JSON.parse(stdout).length;
  } catch {
    return null;
  }
}

function recommendations(graph, objectives) {
  const recs = [];
  const apps = graph.nodes?.apps ?? [];
  const sw = objectives.strategicWeight ?? {};
  const floor = objectives.cohesion?.floor ?? 50;

  // High strategic weight + low cohesion = top priority.
  const priority = apps
    .filter((a) => a.kind === 'product' && a.cohesion != null)
    .map((a) => ({ id: a.id, cohesion: a.cohesion, weight: sw[a.id] ?? sw._default ?? 1 }))
    .filter((a) => a.cohesion < floor)
    .sort((a, b) => b.weight - a.weight || a.cohesion - b.cohesion);
  for (const p of priority) {
    recs.push(`Prioritize **${p.id}** cohesion (${p.cohesion} < ${floor}, strategic weight ${p.weight}) — high leverage.`);
  }

  // Cohesion regressions from KPI movers.
  for (const m of graph.kpis?.movers?.cohesion ?? []) {
    if (m.delta != null && m.delta <= -2) {
      recs.push(`Investigate **${m.app}** cohesion regression (${m.prior}→${m.current}, ${fmtDelta(m.delta)}).`);
    }
  }

  // Stage-exit readiness.
  const stage = objectives.stage;
  if (stage) {
    const mrrLine = graph.kpis?.current?.mrrUsd;
    const revenueReady = mrrLine != null && mrrLine > 0;
    recs.push(
      revenueReady
        ? `Stage ${stage.current} (${stage.name}): revenue signal present — review remaining exit criteria for advancement.`
        : `Stage ${stage.current} (${stage.name}): no paying customers yet — exit criteria not met; stay in stage, push revenue apps.`,
    );
  }
  if (!recs.length) recs.push('No blocking signals — continue the current roadmap; let the opportunity loop handle hygiene.');
  return recs;
}

async function main() {
  const graph = await readJson(GRAPH);
  if (!graph) throw new Error('entity-graph.json not found — run build-entity-graph.mjs first');
  const objectives = yaml.load(await readFile(OBJECTIVES, 'utf8'));
  const parkedDoc = await readJson(PARKED, { parked: [] });
  const parked = parkedDoc.parked ?? [];
  const openOpps = await openOpportunityCount();
  const date = new Date().toISOString().slice(0, 10);

  const ns = evalNorthStar(graph, objectives);
  const kpis = graph.kpis ?? {};
  const t = kpis.trends ?? {};
  const products = (graph.nodes?.apps ?? []).filter((a) => a.kind === 'product');

  const md = [];
  md.push(`# Platform Planning Brief — ${date}`);
  md.push('');
  md.push('> Auto-generated by the Platform Brain weekly planning session (scripts/planning-session.mjs).');
  md.push('> Deterministic synthesis over the entity graph + KPI trends + objectives. Human review required for the strategic decisions below.');
  md.push('');

  md.push('## North-star progress');
  md.push('');
  md.push('| Goal | Status | Detail |');
  md.push('| --- | --- | --- |');
  for (const g of ns) md.push(`| ${g.goal} | ${g.ok ? '✅' : '❌'} | ${g.detail} |`);
  md.push('');

  md.push('## KPI trends (week-over-week)');
  md.push('');
  if (Object.keys(t).length) {
    md.push('| Metric | Current | WoW |');
    md.push('| --- | --- | --- |');
    const rows = [
      ['Avg product cohesion', t.cohesion?.current, t.cohesion?.delta],
      ['Daily cost (USD)', t.cost?.current, t.cost?.delta],
      ['MRR (USD)', t.mrr?.current, t.mrr?.delta],
      ['Completion %', t.completion?.current, t.completion?.delta],
      ['Registry coverage %', t.registryCoverage?.current, t.registryCoverage?.delta],
      ['Open gaps', t.openGaps?.current, t.openGaps?.delta],
    ];
    for (const [label, cur, delta] of rows) md.push(`| ${label} | ${cur ?? '—'} | ${fmtDelta(delta)} |`);
  } else {
    md.push('_No KPI block yet (trend-analyzer not run / Phase 2 pending)._');
  }
  md.push('');

  md.push('## Per-product snapshot');
  md.push('');
  md.push('| Product | Maturity | Cohesion | Registry |');
  md.push('| --- | --- | --- | --- |');
  for (const a of products.sort((x, y) => (y.cohesion ?? 0) - (x.cohesion ?? 0))) {
    md.push(`| ${a.name} | ${a.maturity ?? '—'} | ${a.cohesion ?? '—'} | ${a.registryStatus} |`);
  }
  md.push('');

  md.push('## Strategic decisions awaiting human review (parked)');
  md.push('');
  if (parked.length) {
    for (const p of parked) md.push(`- **${p.title}** — ${p.detail ?? ''} _(gate: ${p.decision})_`);
  } else {
    md.push('_None parked this cycle._');
  }
  md.push('');

  md.push('## Machine-handled (auto-filed) this cycle');
  md.push('');
  md.push(
    openOpps == null
      ? '_Could not query open opportunity issues._'
      : `${openOpps} open \`opportunity\` issue(s) are being handled by the supervisor loop (filed + deduplicated by opportunity-scan).`,
  );
  md.push('');

  md.push('## Recommendations');
  md.push('');
  for (const r of recommendations(graph, objectives)) md.push(`- ${r}`);
  md.push('');
  md.push('---');
  md.push(`_Graph generated ${graph.generatedAt ?? 'n/a'}; ${graph.stats?.appCount ?? '?'} apps, ${graph.stats?.gapCount ?? '?'} gaps, ${kpis.seriesPoints ?? 0} KPI series points._`);

  await mkdir(join(ROOT, 'docs', 'planning'), { recursive: true });
  const out = join(ROOT, 'docs', 'planning', `brief-${date}.md`);
  await writeFile(out, md.join('\n') + '\n', 'utf8');
  console.log(`planning-session: wrote docs/planning/brief-${date}.md (${ns.filter((g) => g.ok).length}/${ns.length} north-star goals met, ${parked.length} parked, ${openOpps ?? '?'} open opportunities)`);
}

main().catch((err) => {
  console.error('planning-session failed:', err);
  process.exit(1);
});
