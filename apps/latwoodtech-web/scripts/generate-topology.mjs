/**
 * Deterministic PCB-style circuitry topology generator for the latwoodtech.com hero.
 *
 * Output: src/data/circuit-topology.json
 *
 * - Seed = current month (YYYYMM) so the layout evolves over time but is
 *   reproducible inside a single deploy cycle.
 * - 4 explicit origin nodes per brand: selfprime, capricast, cypher-healing,
 *   ap-unlimited. Each brand drives 6-10 traces, mixed with neutral/gold
 *   traces for visual richness.
 * - Paths are Manhattan-style (90 deg turns) so they read as PCB copper.
 * - Trace overlap is minimized by reserving small Y-channels per trace and
 *   by ensuring each trace exits its origin on a unique band.
 */

import { mkdir, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, isAbsolute, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const VIEW_W = 800;
const VIEW_H = 480;
const PAD_X = 28;
const PAD_Y = 28;

const BRANDS = [
  { key: 'selfprime', originX: PAD_X, originY: Math.round(VIEW_H * 0.18) },
  { key: 'capricast', originX: VIEW_W - PAD_X, originY: Math.round(VIEW_H * 0.32) },
  { key: 'cypher-healing', originX: PAD_X, originY: Math.round(VIEW_H * 0.78) },
  { key: 'ap-unlimited', originX: VIEW_W - PAD_X, originY: Math.round(VIEW_H * 0.66) },
];

const TARGET_NODE_COUNT = 72;
const TARGET_TRACE_COUNT = 100;
const BRAND_TRACE_PER_ORIGIN = 7; // ~28 brand traces; balance with neutral

// Mulberry32 — small, fast, deterministic PRNG.
function rng(seed) {
  let t = seed >>> 0;
  return function next() {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rand, list) {
  return list[Math.floor(rand() * list.length)];
}

function snap(value, grid) {
  return Math.round(value / grid) * grid;
}

function getSeed() {
  const d = new Date();
  return Number(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
}

/**
 * Build a Manhattan-route SVG path from (x1,y1) to (x2,y2) with 2-3 90 deg
 * turns. The "via" intermediate Y/X is chosen from the rand so two traces
 * leaving the same origin rarely share a corridor.
 */
function manhattanPath(x1, y1, x2, y2, viaPrimary, viaSecondary) {
  // Three-segment route: horizontal -> vertical -> horizontal
  // OR vertical -> horizontal -> vertical, picked by primary distance.
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  if (dx >= dy) {
    // H-V-H route via viaPrimary X column
    const vx = viaPrimary;
    return `M${x1},${y1} L${vx},${y1} L${vx},${y2} L${x2},${y2}`;
  }
  // V-H-V route via viaSecondary Y row
  const vy = viaSecondary;
  return `M${x1},${y1} L${x1},${vy} L${x2},${vy} L${x2},${y2}`;
}

function build() {
  const seed = getSeed();
  const rand = rng(seed);

  const nodes = [];
  const traces = [];
  const usedColumns = new Set();
  const usedRows = new Set();

  // 1) Place origin nodes (one per brand).
  BRANDS.forEach((brand, i) => {
    nodes.push({
      id: `n-origin-${brand.key}`,
      x: brand.originX,
      y: brand.originY,
      role: 'origin',
      brand: brand.key,
    });
  });

  // 2) Place an interior grid of junction nodes.
  const cols = 9;
  const rows = 7;
  const colStep = Math.floor((VIEW_W - PAD_X * 2) / (cols + 1));
  const rowStep = Math.floor((VIEW_H - PAD_Y * 2) / (rows + 1));
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      // Slight jitter for organic feel (snapped to 4px grid).
      const jx = snap((rand() - 0.5) * 18, 4);
      const jy = snap((rand() - 0.5) * 18, 4);
      const x = PAD_X + c * colStep + jx;
      const y = PAD_Y + r * rowStep + jy;
      nodes.push({
        id: `n-${r}-${c}`,
        x,
        y,
        role: 'junction',
      });
    }
  }

  // Top off with sparse edge-pad nodes until we reach TARGET_NODE_COUNT.
  let extra = 0;
  while (nodes.length < TARGET_NODE_COUNT) {
    extra++;
    const edge = pick(rand, ['top', 'bottom', 'left', 'right']);
    let x;
    let y;
    if (edge === 'top') {
      x = snap(PAD_X + rand() * (VIEW_W - PAD_X * 2), 8);
      y = snap(PAD_Y + rand() * 30, 4);
    } else if (edge === 'bottom') {
      x = snap(PAD_X + rand() * (VIEW_W - PAD_X * 2), 8);
      y = snap(VIEW_H - PAD_Y - rand() * 30, 4);
    } else if (edge === 'left') {
      x = snap(PAD_X + rand() * 30, 4);
      y = snap(PAD_Y + rand() * (VIEW_H - PAD_Y * 2), 8);
    } else {
      x = snap(VIEW_W - PAD_X - rand() * 30, 4);
      y = snap(PAD_Y + rand() * (VIEW_H - PAD_Y * 2), 8);
    }
    nodes.push({
      id: `n-pad-${extra}`,
      x,
      y,
      role: 'pad',
    });
  }

  // 3) Generate brand traces: each brand origin emits BRAND_TRACE_PER_ORIGIN
  // traces to varied interior/edge endpoints, with unique via columns.
  let traceId = 0;
  for (const brand of BRANDS) {
    const exitsRight = brand.originX < VIEW_W / 2;
    for (let i = 0; i < BRAND_TRACE_PER_ORIGIN; i++) {
      // Choose a target node that is "across" the board from origin.
      const candidates = nodes.filter((n) => {
        if (n.role === 'origin') return false;
        // Endpoint should be at least 200px away.
        const dx = n.x - brand.originX;
        const dy = n.y - brand.originY;
        const dist = Math.hypot(dx, dy);
        if (dist < 180) return false;
        // Prefer endpoints on the far side.
        if (exitsRight && n.x < brand.originX + 120) return false;
        if (!exitsRight && n.x > brand.originX - 120) return false;
        return true;
      });
      if (candidates.length === 0) continue;
      const target = candidates[Math.floor(rand() * candidates.length)];

      // Choose a unique via column to reduce overlap. Search a few times.
      let viaX = 0;
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidateX = snap(
          Math.min(brand.originX, target.x) +
            rand() * Math.abs(target.x - brand.originX),
          8,
        );
        if (!usedColumns.has(candidateX)) {
          viaX = candidateX;
          usedColumns.add(candidateX);
          break;
        }
        viaX = candidateX;
      }
      let viaY = snap(
        Math.min(brand.originY, target.y) +
          rand() * Math.abs(target.y - brand.originY),
        8,
      );
      while (usedRows.has(viaY)) viaY += 4;
      usedRows.add(viaY);

      traces.push({
        id: `t${traceId++}`,
        from: `n-origin-${brand.key}`,
        to: target.id,
        path: manhattanPath(
          brand.originX,
          brand.originY,
          target.x,
          target.y,
          viaX,
          viaY,
        ),
        brand: brand.key,
      });
    }
  }

  // 4) Fill in neutral (no brand) traces to reach TARGET_TRACE_COUNT — these
  // bridge interior junctions to create the PCB density.
  const interior = nodes.filter((n) => n.role !== 'origin');
  while (traces.length < TARGET_TRACE_COUNT) {
    const a = interior[Math.floor(rand() * interior.length)];
    let b = interior[Math.floor(rand() * interior.length)];
    let guard = 0;
    while (b.id === a.id && guard++ < 5) {
      b = interior[Math.floor(rand() * interior.length)];
    }
    if (b.id === a.id) continue;
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (dist < 90 || dist > 360) continue;

    const viaX = snap(
      Math.min(a.x, b.x) + rand() * Math.abs(b.x - a.x),
      8,
    );
    const viaY = snap(
      Math.min(a.y, b.y) + rand() * Math.abs(b.y - a.y),
      8,
    );
    traces.push({
      id: `t${traceId++}`,
      from: a.id,
      to: b.id,
      path: manhattanPath(a.x, a.y, b.x, b.y, viaX, viaY),
      // No brand tag — runtime renders as neutral gold.
    });
  }

  return {
    viewBox: [0, 0, VIEW_W, VIEW_H],
    generatedSeed: seed,
    nodes,
    traces,
  };
}

export async function generateTopology({ outDir } = {}) {
  const topology = build();
  const outputDir = outDir
    ? isAbsolute(outDir)
      ? outDir
      : join(__dirname, outDir)
    : join(__dirname, '..', 'src', 'data');
  await mkdir(outputDir, { recursive: true });
  const outPath = join(outputDir, 'circuit-topology.json');
  await writeFile(outPath, `${JSON.stringify(topology, null, 2)}\n`, 'utf8');
  return { outPath, topology };
}

// Stand-alone execution.
const invokedPath = process.argv[1] ? fileURLToPath(import.meta.url) : '';
if (invokedPath && invokedPath === process.argv[1]) {
  const { outPath, topology } = await generateTopology();
  const brandTraces = topology.traces.filter((t) => t.brand).length;
  console.log(
    `Topology: ${topology.nodes.length} nodes, ${topology.traces.length} traces (${brandTraces} branded) -> ${outPath}`,
  );
}
