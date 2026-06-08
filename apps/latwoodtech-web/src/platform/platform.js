/**
 * Platform dashboard SVG engine — dual-mode constellation + roadmap.
 * Structure mode: declared topology with health rings and cohesion scores.
 * Flow mode: live traffic particles from analytics.latwoodtech.work.
 */

// ─── constants ───────────────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';
const STATUS_URL = 'https://status.latwoodtech.work/current';
const ANALYTICS_URL = 'https://analytics.latwoodtech.work/';
const PLATFORM_JSON = '/data/platform.json';

const MATURITY_COLOUR = {
  revenue: '#d4a017',
  production: '#22c55e',
  beta: '#3b82f6',
  foundation: '#64748b',
  'on-hold': '#f59e0b',
  design: '#94a3b8',
};

const HEALTH_COLOUR = {
  live: '#22c55e',
  degraded: '#eab308',
  down: '#ef4444',
  unknown: '#475569',
};

const MILESTONE_STATUS_COLOUR = {
  done: '#22c55e',
  active: '#3b82f6',
  queued: '#475569',
  'on-hold': '#f59e0b',
  design: '#94a3b8',
};

// Q2-2026 → Q4-2028: 11 quarters
const QUARTERS = [
  'Q2-2026', 'Q3-2026', 'Q4-2026',
  'Q1-2027', 'Q2-2027', 'Q3-2027', 'Q4-2027',
  'Q1-2028', 'Q2-2028', 'Q3-2028', 'Q4-2028',
];

// Timeline SVG layout
const TL = {
  width: 1200,
  height: 310,
  leftPad: 110,
  rightPad: 20,
  topPad: 50,
  rowH: 28,
  dotR: 6,
};

// ─── state ───────────────────────────────────────────────────────────────────

let platformData = null;
let healthMap = {};           // id → 'live'|'degraded'|'down'|'unknown'
let analyticsMap = {};        // scriptName → { requests, errors, errorRate }
let currentMode = 'structure';
let animFrameId = null;
let particles = [];

// ─── boot ────────────────────────────────────────────────────────────────────

async function boot() {
  const [pd, health, analytics] = await Promise.all([
    loadJSON(PLATFORM_JSON),
    loadHealth(),
    loadAnalytics(),
  ]);

  platformData = pd;
  healthMap = health;
  analyticsMap = analytics;

  renderMeta();
  renderStats();
  renderConstellation();
  renderTimeline();
  renderAppCards();
  wireToggle();
}

// ─── loaders ─────────────────────────────────────────────────────────────────

async function loadJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return res.json();
}

async function loadHealth() {
  try {
    const res = await fetchWithTimeout(STATUS_URL, 6000);
    if (!res.ok) return {};
    const data = await res.json();
    const map = {};
    for (const r of data.results ?? []) {
      map[r.id] = r.status;
    }
    return map;
  } catch {
    return {};
  }
}

async function loadAnalytics() {
  try {
    const res = await fetchWithTimeout(ANALYTICS_URL, 8000);
    if (!res.ok) return {};
    const data = await res.json();
    const map = {};
    for (const w of data.workers ?? []) {
      map[w.scriptName] = w;
    }
    return map;
  } catch {
    return {};
  }
}

function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(id));
}

// ─── meta + stats ─────────────────────────────────────────────────────────────

function renderMeta() {
  const el = document.querySelector('[data-platform-meta]');
  if (!el || !platformData) return;
  const ts = new Date(platformData.generatedAt);
  el.textContent = `Data refreshed ${formatRelative(ts)} · ${platformData.apps?.length ?? 0} apps · ${platformData.packages?.length ?? 0} packages`;
}

function renderStats() {
  const p = platformData?.platform ?? {};
  setStat('stage', p.stageName ? `S${p.stage}: ${p.stageName}` : `Stage ${p.stage ?? '—'}`);
  const liveProd = (platformData?.apps ?? []).filter(a => a.maturity === 'revenue' || a.maturity === 'production').length;
  setStat('products', String(liveProd));
  setStat('threshold', `${p.cohesionThreshold ?? 70}`);
  const gaps = p.gaps ?? {};
  setStat('gaps', `${(gaps.p0 ?? 0) + (gaps.p1 ?? 0)}`);
}

function setStat(key, val) {
  const el = document.querySelector(`[data-stat="${key}"]`);
  if (el) el.textContent = val;
}

// ─── constellation SVG ───────────────────────────────────────────────────────

function renderConstellation() {
  const svg = document.querySelector('.platform-constellation');
  if (!svg || !platformData) return;
  svg.innerHTML = '';

  const defs = svgEl('defs');

  // Hub glow filter
  const filter = svgEl('filter', { id: 'hub-glow', x: '-50%', y: '-50%', width: '200%', height: '200%' });
  const blur = svgEl('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: '8', result: 'blur' });
  const composite = svgEl('feComposite', { in: 'SourceGraphic', in2: 'blur', operator: 'over' });
  filter.appendChild(blur);
  filter.appendChild(composite);
  defs.appendChild(filter);

  // Particle clip
  const clip = svgEl('clipPath', { id: 'svg-clip' });
  const clipRect = svgEl('rect', { x: '0', y: '0', width: '800', height: '600' });
  clip.appendChild(clipRect);
  defs.appendChild(clip);

  svg.appendChild(defs);

  // Background grid
  const gridG = svgEl('g', { class: 'grid', opacity: '0.04' });
  for (let x = 0; x <= 800; x += 40) {
    gridG.appendChild(svgEl('line', { x1: x, y1: 0, x2: x, y2: 600, stroke: '#94a3b8', 'stroke-width': 1 }));
  }
  for (let y = 0; y <= 600; y += 40) {
    gridG.appendChild(svgEl('line', { x1: 0, y1: y, x2: 800, y2: y, stroke: '#94a3b8', 'stroke-width': 1 }));
  }
  svg.appendChild(gridG);

  // Draw spokes (product apps → hub)
  const hub = { cx: 400, cy: 300 };
  const edgesG = svgEl('g', { class: 'edges' });
  for (const app of platformData.apps ?? []) {
    const { cx, cy } = app.svgPos;
    const analyticsKey = appIdToScriptName(app.id);
    const metric = analyticsMap[analyticsKey];
    const weight = metric ? Math.min(4, 1 + Math.log10(1 + metric.requests) * 0.8) : 1;

    edgesG.appendChild(svgEl('path', {
      d: `M${cx},${cy} L${hub.cx},${hub.cy}`,
      stroke: '#334155',
      'stroke-width': weight,
      fill: 'none',
      class: 'edge-structure',
      opacity: '0.6',
    }));

    // Flow-mode path (same coords, different class, invisible by default)
    const flowPath = svgEl('path', {
      d: `M${cx},${cy} L${hub.cx},${hub.cy}`,
      stroke: MATURITY_COLOUR[app.maturity] ?? '#475569',
      'stroke-width': Math.max(1.5, weight),
      fill: 'none',
      class: 'edge-flow',
      opacity: '0.3',
      'data-app': app.id,
      id: `edge-${app.id}`,
    });
    edgesG.appendChild(flowPath);
  }
  // Infra worker spokes to hub (faint)
  for (const w of platformData.infraWorkers ?? []) {
    const { cx, cy } = w.svgPos;
    edgesG.appendChild(svgEl('path', {
      d: `M${cx},${cy} L${hub.cx},${hub.cy}`,
      stroke: '#1e293b',
      'stroke-width': 1,
      fill: 'none',
      'stroke-dasharray': '4 4',
      opacity: '0.4',
    }));
  }
  svg.appendChild(edgesG);

  // Particles layer (flow mode)
  const particlesG = svgEl('g', { class: 'particles-layer', 'clip-path': 'url(#svg-clip)' });
  particlesG.setAttribute('id', 'particles-layer');
  svg.appendChild(particlesG);

  // Infra worker nodes
  const infraG = svgEl('g', { class: 'infra-nodes' });
  for (const w of platformData.infraWorkers ?? []) {
    const { cx, cy, r } = w.svgPos;
    const hColor = HEALTH_COLOUR[healthMap[w.id] ?? 'unknown'];

    const g = svgEl('g', { class: 'infra-node', 'data-id': w.id });
    g.appendChild(svgEl('circle', { cx, cy, r, fill: '#0f172a', stroke: hColor, 'stroke-width': 1.5 }));

    // Label
    const label = svgEl('text', {
      x: cx, y: cy + 1,
      'text-anchor': 'middle',
      'dominant-baseline': 'middle',
      fill: '#64748b',
      'font-size': 7,
      'font-family': 'Space Grotesk, sans-serif',
      'font-weight': '500',
    });
    label.textContent = w.name.split(' ')[0];
    g.appendChild(label);

    infraG.appendChild(g);
  }
  svg.appendChild(infraG);

  // Product app nodes
  const appsG = svgEl('g', { class: 'app-nodes' });
  for (const app of platformData.apps ?? []) {
    const { cx, cy, r } = app.svgPos;
    const color = MATURITY_COLOUR[app.maturity] ?? '#64748b';
    const health = healthMap[app.id] ?? 'unknown';
    const hColor = HEALTH_COLOUR[health];
    const isDashed = app.maturity === 'design' || app.maturity === 'on-hold';

    const g = svgEl('g', {
      class: 'app-node',
      'data-id': app.id,
      role: 'img',
      'aria-label': `${app.name} — ${app.maturity}, cohesion ${app.cohesion}`,
    });

    // Health pulse ring (outer halo)
    const halo = svgEl('circle', {
      cx, cy, r: r + 8,
      fill: 'none',
      stroke: hColor,
      'stroke-width': 1.5,
      opacity: health === 'live' ? 0.7 : 0.4,
      class: health === 'live' ? 'health-ring health-ring-live' : 'health-ring',
    });
    g.appendChild(halo);

    // Node body
    const body = svgEl('circle', {
      cx, cy, r,
      fill: '#0f172a',
      stroke: color,
      'stroke-width': isDashed ? 2 : 2.5,
      'stroke-dasharray': isDashed ? '6 3' : 'none',
    });
    g.appendChild(body);

    // Inner fill tint
    const tint = svgEl('circle', {
      cx, cy, r: r - 2,
      fill: color,
      opacity: '0.08',
    });
    g.appendChild(tint);

    // App name (top half)
    const nameEl = svgEl('text', {
      x: cx, y: cy - 8,
      'text-anchor': 'middle',
      fill: '#e2e8f0',
      'font-size': 8,
      'font-family': 'Space Grotesk, sans-serif',
      'font-weight': '700',
      'letter-spacing': '0.02em',
    });
    nameEl.textContent = app.name.split(' ')[0];
    g.appendChild(nameEl);

    if (app.name.split(' ').length > 1) {
      const nameLine2 = svgEl('text', {
        x: cx, y: cy + 1,
        'text-anchor': 'middle',
        fill: '#e2e8f0',
        'font-size': 8,
        'font-family': 'Space Grotesk, sans-serif',
        'font-weight': '700',
      });
      nameLine2.textContent = app.name.split(' ').slice(1).join(' ');
      g.appendChild(nameLine2);
    }

    // Cohesion score (bottom)
    const cohesionColor = app.cohesion >= 70 ? '#22c55e' : app.cohesion >= 55 ? '#eab308' : '#ef4444';
    const cohEl = svgEl('text', {
      x: cx, y: cy + 15,
      'text-anchor': 'middle',
      fill: cohesionColor,
      'font-size': 9,
      'font-family': 'Space Grotesk, sans-serif',
      'font-weight': '600',
    });
    cohEl.textContent = `${app.cohesion}`;
    g.appendChild(cohEl);

    // Flow mode: traffic badge (hidden until flow mode)
    const trafficBadge = svgEl('g', { class: 'traffic-badge', opacity: 0 });
    const badge = svgEl('rect', {
      x: cx - 22, y: cy + r + 2,
      width: 44, height: 14,
      rx: 4, fill: '#0f172a', stroke: '#334155', 'stroke-width': 1,
    });
    trafficBadge.appendChild(badge);
    const badgeText = svgEl('text', {
      x: cx, y: cy + r + 12,
      'text-anchor': 'middle',
      fill: '#94a3b8',
      'font-size': 7,
      'font-family': 'Space Grotesk, sans-serif',
      class: 'traffic-label',
      'data-app': app.id,
    });
    badgeText.textContent = analyticsMap[appIdToScriptName(app.id)]?.requests
      ? formatReqCount(analyticsMap[appIdToScriptName(app.id)].requests)
      : '—';
    trafficBadge.appendChild(badgeText);
    g.appendChild(trafficBadge);

    appsG.appendChild(g);
  }
  svg.appendChild(appsG);

  // Hub node (Factory Core)
  const hubG = svgEl('g', { class: 'hub-node' });
  hubG.appendChild(svgEl('circle', {
    cx: 400, cy: 300, r: 28,
    fill: '#0f172a',
    stroke: '#4f7bff',
    'stroke-width': 2,
    filter: 'url(#hub-glow)',
  }));
  hubG.appendChild(svgEl('circle', {
    cx: 400, cy: 300, r: 26,
    fill: '#4f7bff',
    opacity: '0.08',
  }));
  const hubLabel = svgEl('text', {
    x: 400, y: 296,
    'text-anchor': 'middle',
    fill: '#93c5fd',
    'font-size': 8,
    'font-family': 'Syncopate, sans-serif',
    'font-weight': '700',
    'letter-spacing': '0.05em',
  });
  hubLabel.textContent = 'FACTORY';
  hubG.appendChild(hubLabel);
  const hubLabel2 = svgEl('text', {
    x: 400, y: 308,
    'text-anchor': 'middle',
    fill: '#64748b',
    'font-size': 7,
    'font-family': 'Space Grotesk, sans-serif',
  });
  hubLabel2.textContent = 'core';
  hubG.appendChild(hubLabel2);
  svg.appendChild(hubG);
}

// ─── flow mode particles ──────────────────────────────────────────────────────

function startFlowAnimation() {
  if (animFrameId) return;
  particles = [];
  initParticles();
  animateParticles();
}

function stopFlowAnimation() {
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  const layer = document.getElementById('particles-layer');
  if (layer) layer.innerHTML = '';
}

function initParticles() {
  const hub = { x: 400, y: 300 };
  const apps = platformData?.apps ?? [];

  for (const app of apps) {
    const { cx, cy } = app.svgPos;
    const scriptName = appIdToScriptName(app.id);
    const metric = analyticsMap[scriptName];
    const rps = metric ? metric.requests / 3600 : 0.5; // requests per second estimate
    const errorRate = metric ? metric.errorRate : 0;
    const count = Math.max(1, Math.min(8, Math.ceil(rps * 2)));

    for (let i = 0; i < count; i++) {
      const toHub = Math.random() > 0.3; // 70% traffic flows to hub
      particles.push({
        id: `${app.id}-${i}`,
        x1: toHub ? cx : hub.x,
        y1: toHub ? cy : hub.y,
        x2: toHub ? hub.x : cx,
        y2: toHub ? hub.y : cy,
        t: Math.random(), // position along path 0..1
        speed: 0.002 + Math.random() * 0.003,
        colour: Math.random() < errorRate ? '#ef4444' : (MATURITY_COLOUR[app.maturity] ?? '#94a3b8'),
        r: metric ? Math.min(3.5, 1.5 + Math.log10(1 + (metric.cpuTimeP99Ms ?? 0)) * 0.4) : 2,
        opacity: 0.6 + Math.random() * 0.4,
      });
    }
  }
}

function animateParticles() {
  const layer = document.getElementById('particles-layer');
  if (!layer) return;

  // Advance positions
  for (const p of particles) {
    p.t += p.speed;
    if (p.t > 1) p.t = 0;
  }

  // Rebuild DOM (small particle count so this is fine)
  layer.innerHTML = '';
  for (const p of particles) {
    const x = p.x1 + (p.x2 - p.x1) * easeInOut(p.t);
    const y = p.y1 + (p.y2 - p.y1) * easeInOut(p.t);
    const circle = svgEl('circle', {
      cx: x, cy: y, r: p.r,
      fill: p.colour,
      opacity: p.opacity * Math.sin(p.t * Math.PI), // fade in + out
    });
    layer.appendChild(circle);
  }

  animFrameId = requestAnimationFrame(animateParticles);
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

// ─── mode toggle ─────────────────────────────────────────────────────────────

function wireToggle() {
  const btns = document.querySelectorAll('[data-mode]');
  for (const btn of btns) {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === currentMode) return;
      currentMode = mode;

      btns.forEach(b => b.classList.toggle('platform-mode-btn-active', b.dataset.mode === mode));
      document.body.classList.toggle('mode-flow', mode === 'flow');
      document.body.classList.toggle('mode-structure', mode === 'structure');

      const flowNotice = document.querySelector('[data-flow-notice]');
      const flowLegend = document.querySelector('.platform-legend-group-flow');

      if (mode === 'flow') {
        if (Object.keys(analyticsMap).length === 0 && flowNotice) {
          flowNotice.removeAttribute('hidden');
        }
        if (flowLegend) flowLegend.removeAttribute('hidden');
        startFlowAnimation();
        updateTrafficBadges(true);
      } else {
        if (flowNotice) flowNotice.setAttribute('hidden', '');
        if (flowLegend) flowLegend.setAttribute('hidden', '');
        stopFlowAnimation();
        updateTrafficBadges(false);
      }
    });
  }

  // Start in structure mode
  document.body.classList.add('mode-structure');
}

function updateTrafficBadges(show) {
  const badges = document.querySelectorAll('.traffic-badge');
  badges.forEach(b => {
    b.setAttribute('opacity', show ? 1 : 0);
  });
}

// ─── roadmap timeline SVG ────────────────────────────────────────────────────

function renderTimeline() {
  const svg = document.querySelector('.platform-timeline');
  if (!svg || !platformData?.timeline) return;
  svg.innerHTML = '';

  const { milestones, platformStages } = platformData.timeline;
  const apps = platformData.apps ?? [];

  // Quarter to x-coordinate mapper
  function qToX(q) {
    const idx = QUARTERS.indexOf(q);
    if (idx === -1) return TL.leftPad;
    const usableWidth = TL.width - TL.leftPad - TL.rightPad;
    return TL.leftPad + (idx / (QUARTERS.length - 1)) * usableWidth;
  }

  const currentQ = 'Q2-2026';
  const currentX = qToX(currentQ);

  // ── background lanes ──
  const lanesG = svgEl('g', { class: 'timeline-lanes' });

  // Stage 0 row
  const stageRowH = TL.rowH;
  lanesG.appendChild(svgEl('rect', {
    x: TL.leftPad, y: TL.topPad,
    width: TL.width - TL.leftPad - TL.rightPad, height: stageRowH,
    fill: '#0f172a', rx: 2,
  }));

  // Product swim lanes
  const productRows = [...apps.map(a => a.id), '__platform__'];
  for (let i = 0; i < productRows.length; i++) {
    const y = TL.topPad + stageRowH + i * TL.rowH;
    lanesG.appendChild(svgEl('rect', {
      x: TL.leftPad, y,
      width: TL.width - TL.leftPad - TL.rightPad, height: TL.rowH,
      fill: i % 2 === 0 ? '#0a0f1a' : '#060b14',
      rx: 0,
    }));
  }
  svg.appendChild(lanesG);

  // ── quarter headers ──
  const headersG = svgEl('g', { class: 'timeline-headers' });
  for (const q of QUARTERS) {
    const x = qToX(q);
    const label = svgEl('text', {
      x, y: TL.topPad - 8,
      'text-anchor': 'middle',
      fill: '#475569',
      'font-size': 9,
      'font-family': 'Space Grotesk, sans-serif',
      'font-weight': '500',
    });
    label.textContent = q;
    headersG.appendChild(label);

    // Tick line
    headersG.appendChild(svgEl('line', {
      x1: x, y1: TL.topPad,
      x2: x, y2: TL.topPad + stageRowH + productRows.length * TL.rowH,
      stroke: '#1e293b',
      'stroke-width': 1,
    }));
  }
  svg.appendChild(headersG);

  // ── row labels ──
  const labelsG = svgEl('g', { class: 'timeline-labels' });

  // Stage label
  const stageLabel = svgEl('text', {
    x: TL.leftPad - 8, y: TL.topPad + stageRowH / 2 + 3,
    'text-anchor': 'end',
    fill: '#64748b',
    'font-size': 8.5,
    'font-family': 'Space Grotesk, sans-serif',
    'font-weight': '600',
    'letter-spacing': '0.04em',
  });
  stageLabel.textContent = 'PLATFORM';
  labelsG.appendChild(stageLabel);

  // App labels
  for (let i = 0; i < apps.length; i++) {
    const y = TL.topPad + stageRowH + i * TL.rowH + TL.rowH / 2 + 3;
    const label = svgEl('text', {
      x: TL.leftPad - 8, y,
      'text-anchor': 'end',
      fill: '#94a3b8',
      'font-size': 8.5,
      'font-family': 'Space Grotesk, sans-serif',
      'font-weight': '500',
    });
    label.textContent = apps[i].name;
    labelsG.appendChild(label);
  }

  // Infra label
  const infraLabel = svgEl('text', {
    x: TL.leftPad - 8, y: TL.topPad + stageRowH + apps.length * TL.rowH + TL.rowH / 2 + 3,
    'text-anchor': 'end',
    fill: '#64748b',
    'font-size': 8.5,
    'font-family': 'Space Grotesk, sans-serif',
    'font-weight': '500',
  });
  infraLabel.textContent = 'Platform';
  labelsG.appendChild(infraLabel);

  svg.appendChild(labelsG);

  // ── platform stage bands ──
  const stagesG = svgEl('g', { class: 'stage-bands' });
  const STAGE_COLOURS = {
    done: '#22c55e',
    active: '#3b82f6',
    queued: '#334155',
    design: '#1e293b',
  };
  for (const stage of platformStages ?? []) {
    const x1 = qToX(stage.startQuarter);
    const x2 = qToX(stage.endQuarter) + 20;
    const color = STAGE_COLOURS[stage.status] ?? '#1e293b';

    stagesG.appendChild(svgEl('rect', {
      x: x1, y: TL.topPad + 2,
      width: Math.max(24, x2 - x1), height: stageRowH - 4,
      fill: color,
      rx: 3,
      opacity: stage.status === 'active' ? 0.5 : 0.2,
    }));

    const stageText = svgEl('text', {
      x: x1 + 4, y: TL.topPad + stageRowH / 2 + 3,
      fill: '#e2e8f0',
      'font-size': 7,
      'font-family': 'Space Grotesk, sans-serif',
      'font-weight': '600',
    });
    stageText.textContent = stage.label.replace('Stage ', 'S');
    stagesG.appendChild(stageText);
  }
  svg.appendChild(stagesG);

  // ── milestone dots ──
  const milestonesG = svgEl('g', { class: 'milestones' });

  // Group milestones by row
  const appIds = apps.map(a => a.id);
  for (const m of milestones ?? []) {
    const x = qToX(m.quarter);
    const appIdx = appIds.indexOf(m.appId);
    let rowY;
    if (appIdx === -1) {
      // Platform-level milestone → infra row
      rowY = TL.topPad + stageRowH + apps.length * TL.rowH + TL.rowH / 2;
    } else {
      rowY = TL.topPad + stageRowH + appIdx * TL.rowH + TL.rowH / 2;
    }

    const color = MILESTONE_STATUS_COLOUR[m.status] ?? '#475569';
    const g = svgEl('g', { class: 'milestone', 'data-id': m.id });

    // Dot
    if (m.status === 'done') {
      g.appendChild(svgEl('circle', { cx: x, cy: rowY, r: TL.dotR, fill: color }));
    } else if (m.status === 'active') {
      g.appendChild(svgEl('circle', { cx: x, cy: rowY, r: TL.dotR, fill: color, opacity: 0.9, class: 'milestone-pulse' }));
      g.appendChild(svgEl('circle', { cx: x, cy: rowY, r: TL.dotR + 4, fill: 'none', stroke: color, 'stroke-width': 1, opacity: 0.5, class: 'milestone-ring' }));
    } else if (m.status === 'on-hold') {
      g.appendChild(svgEl('circle', { cx: x, cy: rowY, r: TL.dotR, fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-dasharray': '3 2' }));
    } else {
      g.appendChild(svgEl('circle', { cx: x, cy: rowY, r: TL.dotR, fill: 'none', stroke: color, 'stroke-width': 1.5 }));
    }

    // Tooltip
    const title = svgEl('title');
    title.textContent = `${m.label} · ${m.quarter} · ${m.status}`;
    g.appendChild(title);

    milestonesG.appendChild(g);
  }
  svg.appendChild(milestonesG);

  // ── "you are here" line ──
  const nowG = svgEl('g', { class: 'now-line' });
  nowG.appendChild(svgEl('line', {
    x1: currentX, y1: TL.topPad - 5,
    x2: currentX, y2: TL.topPad + stageRowH + productRows.length * TL.rowH,
    stroke: '#4f7bff',
    'stroke-width': 2,
    opacity: 0.8,
  }));
  const nowLabel = svgEl('text', {
    x: currentX + 4, y: TL.topPad - 8,
    fill: '#4f7bff',
    'font-size': 8.5,
    'font-family': 'Space Grotesk, sans-serif',
    'font-weight': '700',
  });
  nowLabel.textContent = 'NOW';
  nowG.appendChild(nowLabel);
  svg.appendChild(nowG);
}

// ─── app cards ───────────────────────────────────────────────────────────────

function renderAppCards() {
  const grid = document.querySelector('[data-apps-grid]');
  if (!grid || !platformData) return;
  grid.innerHTML = '';

  for (const app of platformData.apps ?? []) {
    const color = MATURITY_COLOUR[app.maturity] ?? '#64748b';
    const health = healthMap[app.id] ?? 'unknown';
    const hColor = HEALTH_COLOUR[health];
    const cohesionColor = app.cohesion >= 70 ? '#22c55e' : app.cohesion >= 55 ? '#eab308' : '#ef4444';

    const card = document.createElement('article');
    card.className = 'platform-app-card';
    card.innerHTML = `
      <header class="app-card-header">
        <div class="app-card-dot" style="background:${color}"></div>
        <h3 class="app-card-name">${app.name}</h3>
        <span class="app-card-health" style="color:${hColor}" title="Health: ${health}">●</span>
      </header>
      <p class="app-card-domain">${app.domain}</p>
      <div class="app-card-badges">
        <span class="app-badge app-badge-maturity" style="--badge-color:${color}">${app.maturity}</span>
        <span class="app-badge app-badge-cohesion" style="color:${cohesionColor}">cohesion ${app.cohesion}</span>
      </div>
      ${app.description ? `<p class="app-card-desc">${app.description}</p>` : ''}
      <div class="app-card-roadmap">
        ${(app.roadmap ?? []).slice(0, 3).map(r => `
          <div class="roadmap-item roadmap-item-${r.status}">
            <span class="roadmap-item-dot"></span>
            <span class="roadmap-item-label">${r.label}</span>
            <span class="roadmap-item-q">${r.quarter}</span>
          </div>
        `).join('')}
      </div>
      <div class="app-card-packages">
        ${(app.packages ?? []).map(p => `<code class="package-chip">${p}</code>`).join('')}
      </div>
    `;
    grid.appendChild(card);
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

function appIdToScriptName(id) {
  // Map platform data id → CF worker script name (as seen in analytics)
  const map = {
    selfprime: 'prime-self',
    capricast: 'capricast-api',
    'admin-studio': 'admin-studio-production',
    coh: 'coh-api',
    'xico-city': 'xico-city',
    'agent-gateway': 'factory-agent-gateway',
  };
  return map[id] ?? id;
}

function formatRelative(date) {
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.round(diffMs / 60000);
  if (diffMins < 2) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffH = Math.round(diffMins / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return `${Math.round(diffH / 24)}d ago`;
}

function formatReqCount(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M req`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k req`;
  return `${n} req`;
}

// ─── init ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  boot().catch(err => {
    console.error('[platform] boot failed:', err);
    const meta = document.querySelector('[data-platform-meta]');
    if (meta) meta.textContent = 'Platform data unavailable — check back shortly.';
  });
});
