/* Founder page hydration — live stats, last-shipped feed, CI badge.
 * All fetches degrade gracefully; the page reads correctly from the
 * seeded founder-stats.json even if the GitHub API is unavailable. */

const GH_REPO = 'Latimer-Woods-Tech/Factory';
const GH_API  = 'https://api.github.com';

function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
  if (mins  <  2) return 'just now';
  if (mins  < 60) return `${mins} minutes ago`;
  if (hours <  2) return '1 hour ago';
  if (hours < 24) return `${hours} hours ago`;
  if (days  <  2) return 'yesterday';
  return `${days} days ago`;
}

function fmt(n) {
  return Number(n).toLocaleString();
}

function animateNumber(el, value) {
  const target = Number(value);
  if (!Number.isFinite(target)) return;

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = fmt(target);
    return;
  }

  const duration = 950;
  const started = performance.now();
  const tick = (now) => {
    const progress = Math.min((now - started) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 4);
    el.textContent = fmt(Math.round(target * eased));
    if (progress < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ── 1. Founder stats ──────────────────────────────────────────── */
async function hydrateStats() {
  let stats;
  try {
    const res = await fetch('../data/founder-stats.json', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`stats ${res.status}`);
    stats = await res.json();
  } catch {
    return; // seeded HTML fallback values already show "--"
  }

  const map = {
    prs:       stats.mergedPrs,
    commits:   stats.totalCommits,
    apps:      stats.deployedApps,
    workflows: stats.workflows,
    packages:  stats.sharedPackages,
    repos:     stats.orgRepos,
  };

  for (const [key, value] of Object.entries(map)) {
    for (const el of document.querySelectorAll(`[data-stat="${key}"]`)) {
      animateNumber(el, value);
    }
    for (const el of document.querySelectorAll(`[data-stat-inline="${key}"]`)) {
      el.textContent = fmt(value);
    }
  }

  /* Efficiency strip */
  const strip = document.querySelector('[data-efficiency-strip]');
  if (strip && stats.deployedApps && stats.monthlyCostUsd) {
    const perApp = (stats.monthlyCostUsd / stats.deployedApps).toFixed(2);
    const created = new Date(stats.repoCreatedAt);
    const weeksOld = Math.round((Date.now() - created.getTime()) / 604_800_000);

    strip.innerHTML = `
      <span class="efficiency-chip">
        <strong>$${perApp}</strong>/app/month
      </span>
      <span class="efficiency-chip">
        $${stats.monthlyCostUsd.toFixed(2)} total infra cost
      </span>
      <span class="efficiency-chip efficiency-chip-gold">
        Built in <strong>${weeksOld} weeks</strong>
      </span>
    `;

    /* Update the "built in N wks" inline metric in the role-metrics row */
    const builtMetric = document.querySelector('[data-built-metric] strong');
    if (builtMetric) builtMetric.textContent = `${weeksOld} wks`;
  }

  /* Update generated-at timestamp if present */
  if (stats.generatedAt) {
    const ts = document.querySelector('[data-stats-updated]');
    if (ts) ts.textContent = `Stats as of ${relativeTime(stats.generatedAt)}`;
  }
}

/* ── 2. Last Shipped feed ──────────────────────────────────────── */
async function hydrateActivity() {
  const feed = document.querySelector('[data-activity-feed]');
  if (!feed) return;

  try {
    const res = await fetch(
      `${GH_API}/repos/${GH_REPO}/pulls?state=closed&per_page=10&sort=updated&direction=desc`,
      { headers: { Accept: 'application/vnd.github+json' } },
    );
    if (!res.ok) throw new Error(`activity ${res.status}`);
    const pulls = await res.json();
    const merged = pulls.filter((p) => p.merged_at).slice(0, 4);

    if (!merged.length) {
      feed.innerHTML = '<p class="activity-empty">No recent activity found.</p>';
      return;
    }

    feed.innerHTML = merged
      .map(
        (pr) => `
        <a href="${pr.html_url}" class="activity-item" target="_blank" rel="noreferrer">
          <span class="activity-badge">#${pr.number}</span>
          <span class="activity-title">${pr.title}</span>
          <span class="activity-time">${relativeTime(pr.merged_at)}</span>
        </a>`,
      )
      .join('');
  } catch {
    feed.innerHTML = '<p class="activity-empty">Activity feed temporarily unavailable.</p>';
  }
}

/* ── 3. CI badge ───────────────────────────────────────────────── */
async function hydrateCiBadge() {
  const dot   = document.querySelector('[data-ci-dot]');
  const label = document.querySelector('[data-ci-label]');
  if (!dot || !label) return;

  try {
    const res = await fetch(
      `${GH_API}/repos/${GH_REPO}/actions/runs?per_page=1`,
      { headers: { Accept: 'application/vnd.github+json' } },
    );
    if (!res.ok) throw new Error(`ci ${res.status}`);
    const data = await res.json();
    const run  = data.workflow_runs?.[0];

    if (!run) return;

    const conclusion = run.conclusion;
    const status     = run.status;

    if (status === 'in_progress' || status === 'queued') {
      dot.setAttribute('data-tone', 'running');
      label.textContent = 'CI running';
    } else if (conclusion === 'success') {
      dot.setAttribute('data-tone', 'good');
      label.textContent = 'CI green';
    } else if (conclusion === 'failure') {
      dot.setAttribute('data-tone', 'fail');
      label.textContent = 'CI attention';
    } else {
      dot.setAttribute('data-tone', 'neutral');
      label.textContent = `CI: ${conclusion ?? status}`;
    }
  } catch {
    const label2 = document.querySelector('[data-ci-label]');
    if (label2) label2.textContent = 'CI unavailable';
  }
}

/* ── 4. Print button ───────────────────────────────────────────── */
function wirePrintButton() {
  const btn = document.querySelector('[data-print-btn]');
  if (btn) btn.addEventListener('click', () => window.print());
}

/* Run all three in parallel — each degrades independently */
wirePrintButton();
Promise.all([hydrateStats(), hydrateActivity(), hydrateCiBadge()]);
