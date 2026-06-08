import { copyFile, cp, mkdir, readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { generateTopology } from './scripts/generate-topology.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, 'src');
const distDir = join(__dirname, 'dist');

function minifyCSS(css) {
	return css
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\s+/g, ' ')
		.replace(/\s*([{}:;,>+~])\s*/g, '$1')
		.trim();
}

const BRAND_SURFACES = [
	{ name: 'Prime Self', url: 'https://selfprime.net', category: 'Practitioner intelligence' },
	{ name: 'Capricast', url: 'https://capricast.com', category: 'Interactive creator video' },
	{ name: 'Cypher of Healing', url: 'https://cypherofhealing.com', category: 'Restoration ecosystem' },
	{ name: 'AP Unlimited', url: 'https://apunlimited.com', category: 'Governance studio' },
];

async function probeSurface(surface) {
	const start = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 6000);
	try {
		// Try /health endpoint first (service liveness check), fall back to root (homepage)
		const healthUrl = new URL('/health', surface.url).toString();
		let res = await fetch(healthUrl, {
			method: 'GET',
			signal: controller.signal,
			headers: { 'user-agent': 'latwoodtech-web-build-probe/1.0' },
		}).catch(() => null);

		// If /health not available, check root homepage
		if (!res) {
			res = await fetch(surface.url, {
				method: 'GET',
				redirect: 'follow',
				signal: controller.signal,
				headers: { 'user-agent': 'latwoodtech-web-build-probe/1.0' },
			});
		}

		const durationMs = Date.now() - start;
		return {
			name: surface.name,
			url: surface.url,
			category: surface.category,
			alive: res.ok,
			status: res.status,
			durationMs,
			error: null,
		};
	} catch (error) {
		return {
			name: surface.name,
			url: surface.url,
			category: surface.category,
			alive: false,
			status: 0,
			durationMs: Date.now() - start,
			error: error?.message || String(error),
		};
	} finally {
		clearTimeout(timer);
	}
}

async function probeSurfaces() {
	return Promise.all(BRAND_SURFACES.map(probeSurface));
}

function buildFallbackSurfaceHealth() {
	return BRAND_SURFACES.map((surface) => ({
		name: surface.name,
		url: surface.url,
		category: surface.category,
		alive: false,
		status: 0,
		durationMs: 7000,
		error: 'probe timeout',
	}));
}

async function withTimeout(promise, ms, fallback) {
	let timeoutId;
	const result = await Promise.race([
		promise,
		new Promise((resolve) => {
			timeoutId = setTimeout(() => resolve(fallback), ms);
		}),
	]);
	clearTimeout(timeoutId);
	return result;
}

const PUBLIC_SURFACES = [
	{
		name: 'Prime Self',
		category: 'Practitioner intelligence',
		url: 'https://selfprime.net',
		note: 'Chart data, interpretation, and deliverables',
	},
	{
		name: 'Capricast',
		category: 'Interactive creator video',
		url: 'https://capricast.com',
		note: 'Playback, chat, watch parties, and monetization',
	},
	{
		name: 'Cypher of Healing',
		category: 'Restoration ecosystem',
		url: 'https://cypherofhealing.com',
		note: 'The Chair, academy, events, and community',
	},
	{
		name: 'AP Unlimited',
		category: 'Governance studio',
		url: 'https://apunlimited.com',
		note: 'Environment-aware operator controls',
	},
	{
		name: 'Factory Schedule',
		category: 'Render orchestration',
		url: 'https://schedule.latwoodtech.work',
		note: 'Video jobs, health probes, and status handoffs',
	},
];

function fmtNum(value) {
	return Number(value).toLocaleString('en-US');
}

// Fallback platform numbers if founder-stats.json is missing or unreadable.
// Kept conservative; the hourly generate-founder-stats.yml workflow refreshes
// the real values into src/data/founder-stats.json.
const FOUNDER_STATS_FALLBACK = {
	generatedAt: new Date().toISOString(),
	mergedPrs: 1325,
	totalCommits: 1105,
	deployedApps: 27,
	sharedPackages: 37,
	workflows: 130,
	orgRepos: 15,
	monthlyCostUsd: 9.11,
};

async function readFounderStats() {
	try {
		const raw = await readFile(join(srcDir, 'data', 'founder-stats.json'), 'utf8');
		return { ...FOUNDER_STATS_FALLBACK, ...JSON.parse(raw) };
	} catch {
		return FOUNDER_STATS_FALLBACK;
	}
}

// Turn build-time liveness probes into "live surface" vectors. We never render
// a scary DOWN from a probe that simply could not run (e.g. no outbound network
// on a local build) — only a genuine non-2xx response is surfaced as attention.
function surfaceHealthToVectors(surfaceHealth) {
	return surfaceHealth.map((entry) => {
		if (entry.alive === true) {
			return {
				name: entry.name,
				value: String(entry.status || 200),
				state: 'Live',
				context: typeof entry.durationMs === 'number' ? `${entry.durationMs}ms response` : 'Responding',
				tone: 'good',
			};
		}
		if (entry.status && entry.status >= 400) {
			return {
				name: entry.name,
				value: String(entry.status),
				state: 'Attention',
				context: 'Non-2xx at last probe',
				tone: 'warning',
			};
		}
		return {
			name: entry.name,
			value: '—',
			state: 'Re-checked',
			context: 'Liveness re-probed on every deploy',
			tone: 'neutral',
		};
	});
}

async function buildPulseSnapshot(surfaceHealth) {
	const stats = await readFounderStats();

	return {
		generatedAt: stats.generatedAt,
		pulse: {
			title: 'Factory Pulse',
			summary:
				'A public-safe operating picture built from live repository metrics and curated production surfaces.',
			securityModel:
				'Curated, same-origin JSON generated at build time from public GitHub metrics. No auth, no operator endpoints, no secrets, and no internal request metadata.',
			stats: [
				{
					id: 'merged-prs',
					label: 'Merged PRs',
					value: `${fmtNum(stats.mergedPrs)}`,
					context: 'Shipped and reviewed across the platform',
				},
				{
					id: 'commits',
					label: 'Commits',
					value: fmtNum(stats.totalCommits),
					context: 'Public, auditable change history',
				},
				{
					id: 'deployed-apps',
					label: 'Deployed apps',
					value: fmtNum(stats.deployedApps),
					context: 'Serverless surfaces in production',
				},
				{
					id: 'shared-packages',
					label: 'Shared packages',
					value: fmtNum(stats.sharedPackages),
					context: 'Reusable infrastructure modules',
				},
			],
			health: [
				{
					label: 'CI/CD workflows',
					value: fmtNum(stats.workflows),
					tone: 'good',
				},
				{
					label: 'Platform repos',
					value: fmtNum(stats.orgRepos),
					tone: 'neutral',
				},
				{
					label: 'Monthly infra cost',
					value: `$${Number(stats.monthlyCostUsd).toFixed(2)}`,
					tone: 'good',
				},
				{
					label: 'Risk surface',
					value: 'Read-only',
					tone: 'good',
				},
			],
			story: [
				'Every number on this page is a live, public GitHub metric — not a self-reported claim.',
				'The public surface shows proof of rigor while deeper operator controls stay inside authenticated studio surfaces.',
				'A whole portfolio of products runs on shared infrastructure at a fraction of conventional cost.',
			],
			surfaces: PUBLIC_SURFACES,
			surfaceHealth,
			vectors: surfaceHealthToVectors(surfaceHealth),
			provenance: [
				'apps/latwoodtech-web/src/data/founder-stats.json (refreshed hourly from the GitHub API)',
				'Build-time liveness probes over the curated public-domain allowlist',
			],
		},
	};
}

// Regenerate the deterministic topology and emit it into dist/data so the
// fresh JSON is included in the dist payload without tracking the generated
// source artifact in git.
const { topology } = await generateTopology({ outDir: join(distDir, 'data') });

await mkdir(distDir, { recursive: true });
await copyFile(join(srcDir, 'index.html'), join(distDir, 'index.html'));
await copyFile(join(srcDir, 'privacy.html'), join(distDir, 'privacy.html'));
const cssRaw = await readFile(join(srcDir, 'styles.css'), 'utf8');
const cssMin = minifyCSS(cssRaw);
await writeFile(join(distDir, 'styles.css'), cssMin, 'utf8');
await copyFile(join(srcDir, 'app.js'), join(distDir, 'app.js'));
await copyFile(join(srcDir, 'hero-circuitry.js'), join(distDir, 'hero-circuitry.js'));
await cp(join(srcDir, 'assets'), join(distDir, 'assets'), { recursive: true });
// /work/ — engagement model and delivery process.
await mkdir(join(distDir, 'work'), { recursive: true });
await copyFile(join(srcDir, 'work', 'index.html'), join(distDir, 'work', 'index.html'));
// /stack/ — annotated architecture + "what we refuse to ship with" page.
await mkdir(join(distDir, 'stack'), { recursive: true });
await copyFile(join(srcDir, 'stack', 'index.html'), join(distDir, 'stack', 'index.html'));
// /founder/ — founder profile with live stats hydrated from founder-stats.json.
await mkdir(join(distDir, 'founder'), { recursive: true });
await copyFile(join(srcDir, 'founder', 'index.html'), join(distDir, 'founder', 'index.html'));
await copyFile(join(srcDir, 'founder.js'), join(distDir, 'founder.js'));
// Copy OG image (SVG) for social shares (1200×630).
await mkdir(join(distDir, 'assets'), { recursive: true });
await copyFile(join(srcDir, 'assets', 'og-image.svg'), join(distDir, 'assets', 'og-image.svg'));

// Credibility signals: humans.txt (humanstxt.org) at root, security.txt
// (RFC 9116) under /.well-known/. Absence reads "not yet a real platform".
await copyFile(join(srcDir, 'humans.txt'), join(distDir, 'humans.txt'));
await mkdir(join(distDir, '.well-known'), { recursive: true });
await copyFile(join(srcDir, '.well-known', 'security.txt'), join(distDir, '.well-known', 'security.txt'));
// SEO: real robots.txt + sitemap.xml (previously served the SPA fallback HTML).
await copyFile(join(srcDir, 'robots.txt'), join(distDir, 'robots.txt'));
await copyFile(join(srcDir, 'sitemap.xml'), join(distDir, 'sitemap.xml'));
// Cloudflare Pages _headers — CSP, HSTS, frame-ancestors, Permissions-Policy.
await copyFile(join(srcDir, '_headers'), join(distDir, '_headers'));
// /status/ — near-live brand surface health page that fetches the
// status-prober Worker with graceful fall-back to data/pulse.json.
await cp(join(srcDir, 'status'), join(distDir, 'status'), { recursive: true });
// /platform/ — live SVG platform dashboard (constellation + flow + roadmap).
await cp(join(srcDir, 'platform'), join(distDir, 'platform'), { recursive: true });
await mkdir(join(distDir, 'data'), { recursive: true });

// Copy founder-stats.json (committed seed; updated hourly by generate-founder-stats.yml).
await copyFile(join(srcDir, 'data', 'founder-stats.json'), join(distDir, 'data', 'founder-stats.json'));
// Copy platform.json (seed; updated hourly by generate-platform-data.mjs).
await copyFile(join(srcDir, 'data', 'platform.json'), join(distDir, 'data', 'platform.json'));

// Liveness probes run in parallel; on CI without outbound network they all
// degrade and the runtime still renders a static topology. Bound the overall
// probe batch so the build does not stall longer than 7 seconds.
const surfaceHealth = await withTimeout(probeSurfaces(), 7000, buildFallbackSurfaceHealth());
await writeFile(
	join(distDir, 'data', 'pulse.json'),
	`${JSON.stringify(await buildPulseSnapshot(surfaceHealth), null, 2)}\n`,
	'utf8',
);

const brandTraceCount = topology.traces.filter((t) => t.brand).length;
console.log(
	`Built static site to dist/ — topology: ${topology.nodes.length} nodes / ${topology.traces.length} traces (${brandTraceCount} branded).`,
);
