#!/usr/bin/env node
/**
 * generate-platform-data.mjs
 *
 * Aggregates per-app feature registries, cohesion scores, gap counts,
 * and roadmap milestones into a single platform.json consumed by
 * apps/latwoodtech-web/src/platform/ for the live SVG dashboard.
 *
 * Runs hourly in generate-founder-stats.yml. Committed back to main via
 * the same auto-merge PR mechanism used for founder-stats.json.
 *
 * Node.js 20+ (ubuntu-latest in CI). No external npm deps required.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_FILE = join(ROOT, 'apps', 'latwoodtech-web', 'src', 'data', 'platform.json');

// ─── SVG Layout (baked positions, tuned in this script) ─────────────────────

const SVG_LAYOUT = {
  hub: { cx: 400, cy: 300 },
  products: {
    selfprime:     { cx: 400, cy: 140, r: 38 },
    capricast:     { cx: 539, cy: 220, r: 38 },
    'admin-studio':{ cx: 539, cy: 380, r: 38 },
    coh:           { cx: 400, cy: 460, r: 38 },
    'xico-city':   { cx: 261, cy: 380, r: 38 },
    'agent-gateway':{ cx: 261, cy: 220, r: 38 },
  },
  infra: {
    'schedule-worker':   { cx: 522, cy: 88,  r: 22 },
    'factory-supervisor':{ cx: 645, cy: 300, r: 22 },
    'daily-brief':       { cx: 522, cy: 512, r: 22 },
    'status-prober':     { cx: 278, cy: 512, r: 22 },
    'factory-core-api':  { cx: 155, cy: 300, r: 22 },
    'synthetic-monitor': { cx: 278, cy: 88,  r: 22 },
  },
};

// ─── Standalone repo data (fallback when GitHub API fetch fails) ─────────────

const STANDALONE_FALLBACK = {
  selfprime: {
    app: 'selfprime', name: 'Self Prime', domain: 'selfprime.net',
    stage: 'revenue', cohesion: 53,
    description: 'Practitioner intelligence platform — Energy Blueprint synthesis',
    packages: ['auth', 'neon', 'stripe', 'llm', 'analytics', 'bodygraph', 'telephony'],
    roadmap: [
      { id: 'sp-launch', label: 'Public Launch', status: 'active', quarter: 'Q3-2026',
        description: 'Remove invite gate, open to public practitioners' },
      { id: 'sp-rls', label: 'RLS enforced', status: 'queued', quarter: 'Q4-2026' },
      { id: 'sp-ios', label: 'iOS PWA', status: 'design', quarter: 'Q2-2027' },
    ],
    features: [
      { id: 'energy-blueprint', label: 'Energy Blueprint synthesis', status: 'live', tier: 'core' },
      { id: 'narration', label: 'AI voice narration', status: 'live', tier: 'core' },
      { id: 'practitioner-network', label: 'Practitioner referral network', status: 'in-progress', tier: 'growth' },
      { id: 'group-readings', label: 'Group reading sessions', status: 'roadmap', tier: 'growth' },
    ],
  },
  capricast: {
    app: 'capricast', name: 'Capricast', domain: 'capricast.com',
    stage: 'production', cohesion: 42,
    description: 'Interactive creator video platform — monetization and live streaming at the edge',
    packages: ['auth', 'neon', 'stripe', 'analytics', 'video'],
    roadmap: [
      { id: 'cc-monetize', label: 'Creator Monetization Live', status: 'active', quarter: 'Q3-2026' },
      { id: 'cc-live-stream', label: 'Live Streaming GA', status: 'queued', quarter: 'Q4-2026' },
      { id: 'cc-group-chat', label: '16-way Video Chat', status: 'queued', quarter: 'Q1-2027' },
    ],
    features: [
      { id: 'video-playback', label: 'CF Stream video playback', status: 'live', tier: 'core' },
      { id: 'stripe-payments', label: 'Stripe payments', status: 'live', tier: 'core' },
      { id: 'conference', label: 'Conference scheduling', status: 'live', tier: 'core' },
      { id: 'live-stream', label: 'Live streaming', status: 'in-progress', tier: 'core' },
      { id: 'group-video', label: '16-way video chat', status: 'roadmap', tier: 'growth' },
    ],
  },
  coh: {
    app: 'coh', name: 'Cypher of Healing', domain: 'cypherofhealing.com',
    stage: 'production', cohesion: 49,
    description: 'Barber-led restoration ecosystem — five streams, one system',
    packages: ['auth', 'neon', 'stripe', 'telephony', 'email'],
    roadmap: [
      { id: 'coh-5streams', label: 'All 5 Streams Live', status: 'active', quarter: 'Q3-2026' },
      { id: 'coh-test-coverage', label: 'Test coverage 60%+', status: 'active', quarter: 'Q3-2026' },
      { id: 'coh-dual-domain', label: 'cipherofhealing.com alias live', status: 'queued', quarter: 'Q3-2026' },
      { id: 'coh-mobile', label: 'Mobile PWA', status: 'design', quarter: 'Q2-2027' },
    ],
    features: [
      { id: 'the-chair', label: 'The Chair (bookings)', status: 'live', tier: 'core' },
      { id: 'the-vault', label: 'The Vault (products)', status: 'live', tier: 'core' },
      { id: 'the-academy', label: 'The Academy (courses)', status: 'live', tier: 'core' },
      { id: 'the-stage', label: 'The Stage (events)', status: 'in-progress', tier: 'core' },
      { id: 'inner-circle', label: 'Inner Circle (membership)', status: 'in-progress', tier: 'growth' },
    ],
  },
  'xico-city': {
    app: 'xico-city', name: 'Xico City', domain: 'xicocity.com',
    stage: 'beta', cohesion: 51,
    description: 'DJMEXXICO creative economy OS — artist platform for 11 role types',
    packages: ['auth', 'neon', 'analytics', 'monitoring'],
    roadmap: [
      { id: 'xc-media-processor', label: 'Media Processor Live', status: 'active', quarter: 'Q3-2026' },
      { id: 'xc-artist-profiles', label: 'Artist Profile GA', status: 'queued', quarter: 'Q4-2026' },
      { id: 'xc-booking', label: 'Artist Booking', status: 'design', quarter: 'Q1-2027' },
    ],
    features: [
      { id: 'artist-roles', label: '11 artist role types', status: 'live', tier: 'core' },
      { id: 'auth-system', label: 'JWT + BetterAuth', status: 'live', tier: 'infra' },
      { id: 'gcp-processor', label: 'GCP Cloud Run media processor', status: 'live', tier: 'infra' },
      { id: 'booking', label: 'Artist booking system', status: 'roadmap', tier: 'core' },
    ],
  },
};

// ─── Parsers ─────────────────────────────────────────────────────────────────

function parseStageFromState(text) {
  const m = text.match(/\*\*Current stage:\*\*\s*(\d+)\s*[—-]\s*(.+)/);
  if (!m) return { stage: 2, stageName: 'Revenue + Customer' };
  return { stage: parseInt(m[1], 10), stageName: m[2].trim() };
}

function parseCohesionFromState(text) {
  const scores = {};
  const tableSection = text.match(/\| Repo \|[\s\S]+?(?=\n\n|\n##)/);
  if (!tableSection) return scores;
  const rows = tableSection[0].split('\n').slice(2); // skip header + separator
  for (const row of rows) {
    const cols = row.split('|').map((c) => c.trim()).filter(Boolean);
    if (cols.length < 2) continue;
    const repo = cols[0];
    const cohesion = parseInt(cols[1].replace(/\*\*/g, ''), 10);
    if (isNaN(cohesion)) continue;
    // Map repo names to app IDs
    const repoMap = {
      HumanDesign: 'selfprime',
      capricast: 'capricast',
      'factory-admin-studio': 'admin-studio',
      'cypher-healing': 'coh',
      'xico-city': 'xico-city',
    };
    const appId = repoMap[repo];
    if (appId) scores[appId] = cohesion;
  }
  return scores;
}

function parseGapCounts(text) {
  const counts = { p0: 0, p1: 0, p2: 0, p3: 0 };
  let currentTier = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('## P0')) currentTier = 'p0';
    else if (line.startsWith('## P1')) currentTier = 'p1';
    else if (line.startsWith('## P2')) currentTier = 'p2';
    else if (line.startsWith('## P3')) currentTier = 'p3';
    else if (currentTier && line.includes('| open') && line.startsWith('|')) {
      counts[currentTier]++;
    }
  }
  return counts;
}

/** Minimal YAML parser for the known feature-registry.yml structure. */
function parseFeatureRegistry(text) {
  const result = { roadmap: [], features: [], packages: [] };
  let currentList = null;
  let currentItem = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line || line.trimStart().startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;
    const content = line.trimStart();

    if (indent === 0) {
      const colonIdx = content.indexOf(':');
      if (colonIdx === -1) continue;
      const key = content.slice(0, colonIdx).trim();
      const value = content.slice(colonIdx + 1).trim();
      if (value) {
        const num = Number(value);
        result[key] = isNaN(num) || value === '' ? value : num;
      } else {
        currentList = key;
        if (!result[key]) result[key] = [];
        currentItem = null;
      }
    } else if (indent === 2 && content.startsWith('- ')) {
      const rest = content.slice(2).trim();
      if (currentList === 'packages') {
        result.packages.push(rest);
        continue;
      }
      currentItem = {};
      result[currentList].push(currentItem);
      if (rest.includes(':')) {
        const colonIdx = rest.indexOf(':');
        const key = rest.slice(0, colonIdx).trim();
        const val = rest.slice(colonIdx + 1).trim();
        if (val) currentItem[key] = val;
      }
    } else if (indent === 4 && currentItem) {
      const colonIdx = content.indexOf(':');
      if (colonIdx !== -1) {
        const key = content.slice(0, colonIdx).trim();
        const val = content.slice(colonIdx + 1).trim();
        if (val) currentItem[key] = val;
      }
    }
  }
  return result;
}

// ─── GitHub API fetch ─────────────────────────────────────────────────────────

async function fetchRepoRegistry(org, repo, token) {
  if (!token) return null;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${org}/${repo}/contents/feature-registry.yml`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github.raw+json',
          'user-agent': 'factory-generate-platform-data/1.0',
        },
      },
    );
    if (!res.ok) return null;
    const text = await res.text();
    return parseFeatureRegistry(text);
  } catch {
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const ghToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';

  // 1. Parse STATE.md
  const stateText = await readFile(join(ROOT, 'docs', 'STATE.md'), 'utf8').catch(() => '');
  const { stage, stageName } = parseStageFromState(stateText);
  const cohesionScores = parseCohesionFromState(stateText);

  // 2. Parse GAP_REGISTER.md
  const gapText = await readFile(join(ROOT, 'docs', 'GAP_REGISTER.md'), 'utf8').catch(() => '');
  const gaps = parseGapCounts(gapText);

  // 3. Read monorepo feature registries
  const monoApps = ['admin-studio', 'agent-gateway'];
  const monoRegistries = {};
  for (const appName of monoApps) {
    const fpath = join(ROOT, 'apps', appName, 'feature-registry.yml');
    if (existsSync(fpath)) {
      const text = await readFile(fpath, 'utf8');
      const parsed = parseFeatureRegistry(text);
      if (parsed.app) monoRegistries[parsed.app] = parsed;
    }
  }

  // 4. Fetch standalone repo registries (with fallback)
  const standaloneRepos = [
    { appId: 'selfprime',   org: 'Latimer-Woods-Tech', repo: 'HumanDesign' },
    { appId: 'capricast',   org: 'Latimer-Woods-Tech', repo: 'capricast' },
    { appId: 'coh',         org: 'Latimer-Woods-Tech', repo: 'coh' },
    { appId: 'xico-city',   org: 'Latimer-Woods-Tech', repo: 'xico-city' },
  ];
  const standaloneRegistries = {};
  await Promise.all(
    standaloneRepos.map(async ({ appId, org, repo }) => {
      const fetched = await fetchRepoRegistry(org, repo, ghToken);
      standaloneRegistries[appId] = fetched ?? STANDALONE_FALLBACK[appId];
    }),
  );

  // 5. Build apps array
  const PRODUCT_IDS = ['selfprime', 'capricast', 'admin-studio', 'coh', 'xico-city', 'agent-gateway'];
  const apps = PRODUCT_IDS.map((appId) => {
    const reg = monoRegistries[appId] ?? standaloneRegistries[appId] ?? {};
    const cohesion = cohesionScores[appId] ?? reg.cohesion ?? 0;
    return {
      id: appId,
      name: reg.name ?? appId,
      domain: reg.domain ?? null,
      maturity: reg.stage ?? 'foundation',
      cohesion,
      healthState: 'live',
      packages: reg.packages ?? [],
      svgPos: SVG_LAYOUT.products[appId] ?? { cx: 400, cy: 300, r: 38 },
      category: 'product',
      roadmap: reg.roadmap ?? [],
      features: reg.features ?? [],
    };
  });

  // 6. Aggregate roadmap milestones from all apps
  const milestones = [
    ...apps.flatMap((app) =>
      (app.roadmap ?? []).map((m) => ({ ...m, appId: app.id })),
    ),
    // Platform-level milestones
    { id: 'wordis-bond-gate', label: 'Wordis Bond: TCPA Gate Cleared', appId: null, status: 'on-hold', quarter: 'Q1-2027' },
    { id: 'ijustus-foundation', label: 'iJustus: Foundation Shipped', appId: null, status: 'design', quarter: 'Q1-2027' },
    { id: 'design-system', label: 'Design System (@lwt/ui-tokens GA)', appId: null, status: 'queued', quarter: 'Q3-2027' },
    { id: 'rls-all-apps', label: 'RLS enforced across all apps', appId: null, status: 'queued', quarter: 'Q4-2027' },
    { id: 'neighbor-aid', label: 'Neighbor Aid: Foundation', appId: null, status: 'design', quarter: 'Q3-2027' },
    { id: 'platform-ga', label: 'Platform GA: All cohesion ≥ 70', appId: null, status: 'design', quarter: 'Q2-2028' },
  ];

  // 7. Build and write platform.json
  const output = {
    generatedAt: new Date().toISOString(),
    platform: { stage, stageName, cohesionThreshold: 70, gaps },
    apps,
    infraWorkers: Object.entries(SVG_LAYOUT.infra).map(([id, pos]) => ({
      id,
      name: id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      healthState: 'live',
      svgPos: pos,
    })),
    packages: [
      { id: 'errors',     name: 'errors',     tier: 'infra' },
      { id: 'monitoring', name: 'monitoring',  tier: 'infra' },
      { id: 'logger',     name: 'logger',      tier: 'infra' },
      { id: 'auth',       name: 'auth',        tier: 'infra' },
      { id: 'neon',       name: 'neon',        tier: 'infra' },
      { id: 'llm',        name: 'llm',         tier: 'capability' },
      { id: 'stripe',     name: 'stripe',      tier: 'capability' },
      { id: 'analytics',  name: 'analytics',   tier: 'capability' },
      { id: 'video',      name: 'video',       tier: 'capability' },
      { id: 'telephony',  name: 'telephony',   tier: 'capability' },
      { id: 'bodygraph',  name: 'bodygraph',   tier: 'capability' },
      { id: 'email',      name: 'email',       tier: 'capability' },
    ],
    timeline: {
      startQuarter: 'Q2-2026',
      endQuarter: 'Q4-2028',
      platformStages: [
        { id: 's0', label: 'Stage 0: Foundation',        status: 'done',    startQuarter: 'Q2-2026', endQuarter: 'Q2-2026' },
        { id: 's1', label: 'Stage 1: Visibility',         status: 'done',    startQuarter: 'Q2-2026', endQuarter: 'Q2-2026' },
        { id: 's2', label: 'Stage 2: Revenue + Customer', status: 'active',  startQuarter: 'Q2-2026', endQuarter: 'Q3-2026' },
        { id: 's3', label: 'Stage 3: Adoption Tools',     status: 'queued',  startQuarter: 'Q4-2026', endQuarter: 'Q4-2026' },
        { id: 's4', label: 'Stage 4: Enforcement',        status: 'queued',  startQuarter: 'Q1-2027', endQuarter: 'Q1-2027' },
        { id: 's5', label: 'Stage 5: Sellability',        status: 'queued',  startQuarter: 'Q2-2027', endQuarter: 'Q2-2027' },
        { id: 's6', label: 'Stage 6: UI/UX Foundations',  status: 'queued',  startQuarter: 'Q3-2027', endQuarter: 'Q3-2027' },
        { id: 's7', label: 'Platform GA (cohesion ≥ 70)', status: 'design',  startQuarter: 'Q2-2028', endQuarter: 'Q2-2028' },
      ],
      milestones,
    },
  };

  await writeFile(OUT_FILE, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`platform.json written — stage ${stage}, ${apps.length} apps, ${milestones.length} milestones`);
}

main().catch((err) => {
  console.error('generate-platform-data failed:', err);
  process.exit(1);
});
