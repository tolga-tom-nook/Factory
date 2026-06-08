#!/usr/bin/env node
/**
 * trend-analyzer.mjs — Phase 2 (SYNTHESIZE) of the Platform Brain.
 *
 * Turns the Factory's daily snapshots into a real time-series and derives KPI
 * trends (week-over-week / month-over-month), then writes a `kpis` block into
 * docs/registry/entity-graph.json and (if present) apps/.../platform.json.
 *
 * Sources of dated history (already retained on disk):
 *   docs/scorecard/<date>.json   — per-app cohesion (dimensions[conformance].score) + composite
 *   docs/cost/<date>.json        — daily provider cost (sum of lines[].amount_usd)
 *   docs/revenue/<date>.json     — MRR (lines[provider=stripe_mrr].value)
 *   docs/completion-tracker-history.jsonl — overall_weighted completion
 *
 * Also maintains its own unified forward series so metrics WITHOUT dated history
 * (registry coverage, open-gap counts) accrue trends over time:
 *   docs/registry/kpi-series.jsonl  — one append-only row per run (dedup by date)
 *
 * Runs hourly after build-entity-graph.mjs. Node 20+ (exempt from CF constraints).
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GRAPH_FILE = join(ROOT, 'docs', 'registry', 'entity-graph.json');
const SERIES_FILE = join(ROOT, 'docs', 'registry', 'kpi-series.jsonl');
const PLATFORM_FILE = join(ROOT, 'apps', 'latwoodtech-web', 'src', 'data', 'platform.json');

const DATE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;

async function readJson(p) {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Load all dated <date>.json files in a docs subdir, sorted ascending by date. */
async function loadDatedDir(subdir) {
  const dir = join(ROOT, 'docs', subdir);
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => DATE_RE.test(f));
  const out = [];
  for (const f of files.sort()) {
    const doc = await readJson(join(dir, f));
    if (doc) out.push({ date: f.match(DATE_RE)[1], doc });
  }
  return out;
}

const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

/**
 * Given a series [{date, value}] ascending, return trend vs the point closest to
 * `targetDays` before the latest (tolerant window). null-safe.
 */
function trendFor(series, targetDays = 7) {
  const clean = series.filter((p) => p.value != null && !Number.isNaN(p.value));
  if (clean.length === 0) return null;
  const latest = clean[clean.length - 1];
  if (clean.length === 1) {
    return { current: round(latest.value), prior: null, priorDate: null, dayGap: null, delta: null, direction: 'flat' };
  }
  // Pick the prior point whose age is closest to targetDays (prefer older-or-equal).
  let prior = clean[0];
  let bestScore = Infinity;
  for (const p of clean.slice(0, -1)) {
    const age = daysBetween(p.date, latest.date);
    const score = Math.abs(age - targetDays);
    if (score < bestScore) {
      bestScore = score;
      prior = p;
    }
  }
  const delta = latest.value - prior.value;
  return {
    current: round(latest.value),
    prior: round(prior.value),
    priorDate: prior.date,
    dayGap: daysBetween(prior.date, latest.date),
    delta: round(delta),
    direction: delta > 0.0001 ? 'up' : delta < -0.0001 ? 'down' : 'flat',
  };
}

const round = (n) => (n == null ? null : Math.round(n * 100) / 100);

function sumCost(doc) {
  return (doc.lines ?? []).reduce((s, l) => s + (l.skipped ? 0 : Number(l.amount_usd) || 0), 0);
}
function mrrOf(doc) {
  const line = (doc.lines ?? []).find((l) => l.provider === 'stripe_mrr');
  return line ? Number(line.value) || 0 : null;
}
/** scorecard app → cohesion (conformance dimension score). */
function cohesionOf(app) {
  const dim = (app.dimensions ?? []).find((d) => d.key === 'conformance');
  return dim && dim.score != null ? Number(dim.score) : null;
}

async function main() {
  const graph = await readJson(GRAPH_FILE);
  if (!graph) throw new Error('entity-graph.json not found — run build-entity-graph.mjs first');
  const aliasIndex = graph.aliasIndex ?? {};
  const resolve = (id) => aliasIndex[String(id).toLowerCase()] ?? String(id);

  // ── Load dated history ──
  const scorecards = await loadDatedDir('scorecard');
  const costs = await loadDatedDir('cost');
  const revenues = await loadDatedDir('revenue');
  const completionLines = existsSync(join(ROOT, 'docs', 'completion-tracker-history.jsonl'))
    ? (await readFile(join(ROOT, 'docs', 'completion-tracker-history.jsonl'), 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    : [];

  // ── Per-app cohesion series (from scorecard history) ──
  const perAppSeries = {}; // canonical -> [{date, value}]
  for (const { date, doc } of scorecards) {
    for (const app of doc.apps ?? []) {
      const canon = resolve(app.repo_key);
      const value = cohesionOf(app);
      if (value == null) continue;
      (perAppSeries[canon] ??= []).push({ date, value });
    }
  }

  // ── Aggregate series ──
  const cohesionAgg = scorecards.map(({ date, doc }) => {
    const vals = (doc.apps ?? []).map(cohesionOf).filter((v) => v != null);
    return { date, value: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null };
  });
  const costSeries = costs.map(({ date, doc }) => ({ date, value: sumCost(doc) }));
  const mrrSeries = revenues.map(({ date, doc }) => ({ date, value: mrrOf(doc) }));
  const completionSeries = completionLines.map((r) => ({
    date: (r.ts ?? '').slice(0, 10),
    value: Number(r.overall_weighted),
  }));

  // ── Current snapshot values from the graph ──
  const products = (graph.nodes?.apps ?? []).filter((a) => a.kind === 'product');
  const gapTier = { p0: 0, p1: 0, p2: 0, p3: 0 };
  for (const g of graph.nodes?.gaps ?? []) if (gapTier[g.tier] != null) gapTier[g.tier]++;
  const openGaps = gapTier.p0 + gapTier.p1 + gapTier.p2 + gapTier.p3;
  const liveApps = (graph.nodes?.apps ?? []).filter(
    (a) => a.lifecycleStage === 'live' || a.maturity != null,
  );
  const registryCovered = liveApps.filter((a) => a.registryStatus === 'present').length;
  const registryCoverage = liveApps.length ? round((registryCovered / liveApps.length) * 100) : null;

  const today = new Date().toISOString().slice(0, 10);

  // ── Maintain unified forward series (kpi-series.jsonl) ──
  let series = [];
  if (existsSync(SERIES_FILE)) {
    series = (await readFile(SERIES_FILE, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
  const todayRow = {
    date: today,
    overallCohesion: round(cohesionAgg.at(-1)?.value ?? null),
    registryCoverage,
    registryCovered,
    registryTotal: liveApps.length,
    openGaps,
    gaps: gapTier,
    cost30dUsd: round(costSeries.at(-1)?.value ?? null),
    mrrUsd: mrrSeries.at(-1)?.value ?? null,
    completionWeighted: round(completionSeries.at(-1)?.value ?? null),
  };
  series = series.filter((r) => r.date !== today); // dedup today
  series.push(todayRow);
  series.sort((a, b) => a.date.localeCompare(b.date));
  await writeFile(SERIES_FILE, series.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  // Series-derived trends (registry coverage + gaps accrue here going forward).
  const coverageSeries = series.map((r) => ({ date: r.date, value: r.registryCoverage }));
  const openGapSeries = series.map((r) => ({ date: r.date, value: r.openGaps }));

  // ── Movers: per-app cohesion week-over-week ──
  const movers = Object.entries(perAppSeries)
    .map(([app, s]) => {
      const t = trendFor(s, 7);
      return t && t.delta != null ? { app, ...t } : null;
    })
    .filter(Boolean)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const kpis = {
    generatedAt: new Date().toISOString(),
    current: {
      overallCohesion: todayRow.overallCohesion,
      registryCoverage,
      openGaps,
      gaps: gapTier,
      cost30dUsd: todayRow.cost30dUsd,
      mrrUsd: todayRow.mrrUsd,
      completionWeighted: todayRow.completionWeighted,
    },
    trends: {
      cohesion: trendFor(cohesionAgg, 7),
      cost: trendFor(costSeries, 7),
      mrr: trendFor(mrrSeries, 7),
      completion: trendFor(completionSeries, 7),
      registryCoverage: trendFor(coverageSeries, 7),
      openGaps: trendFor(openGapSeries, 7),
    },
    movers: { cohesion: movers },
    seriesPoints: series.length,
  };

  // ── Write back into the entity graph ──
  graph.kpis = kpis;
  await writeFile(GRAPH_FILE, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');

  // ── Patch platform.json for the dashboard stats strip (if it exists) ──
  if (existsSync(PLATFORM_FILE)) {
    const platform = await readJson(PLATFORM_FILE);
    if (platform) {
      platform.kpis = kpis;
      await writeFile(PLATFORM_FILE, `${JSON.stringify(platform, null, 2)}\n`, 'utf8');
    }
  }

  const c = kpis.trends.cohesion;
  console.log(
    `trend-analyzer: ${series.length} series points; ` +
      `cohesion ${c ? `${c.current} (${c.direction} ${c.delta ?? 'n/a'} vs ${c.dayGap ?? '?'}d ago)` : 'n/a'}; ` +
      `${movers.length} cohesion movers; registry coverage ${registryCoverage}%; open gaps ${openGaps}`,
  );
}

main().catch((err) => {
  console.error('trend-analyzer failed:', err);
  process.exit(1);
});
