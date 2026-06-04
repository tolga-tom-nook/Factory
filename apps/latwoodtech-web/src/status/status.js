/* Live brand-surface status. Fetches the status-prober Worker, falls back to
 * the build-time pulse.json snapshot. No inline script — CSP script-src 'self'. */

const LIVE_ENDPOINT = 'https://status.latwoodtech.work/current';
const FALLBACK_ENDPOINT = '/data/pulse.json';
const LIVE_TIMEOUT_MS = 8000;

const grid = document.querySelector('[data-status-grid]');
const meta = document.querySelector('[data-status-meta]');

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}
function safeHref(url) {
  return typeof url === 'string' && url.startsWith('https://') ? esc(url) : '#';
}

function formatRelative(iso) {
  if (!iso) return 'unknown time';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const delta = Math.max(0, Date.now() - then);
  const seconds = Math.round(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function renderResults(results, generatedAt, source) {
  if (!Array.isArray(results) || results.length === 0) {
    grid.innerHTML = '<p>No surfaces reported.</p>';
    meta.textContent = 'No data available.';
    meta.dataset.tone = 'error';
    return;
  }
  grid.innerHTML = results
    .map((entry) => {
      const alive = entry.alive === true ? 'true' : entry.alive === false ? 'false' : 'unknown';
      const pillText = alive === 'true' ? 'UP' : alive === 'false' ? 'DOWN' : 'UNKNOWN';
      const status = entry.status != null ? `HTTP ${entry.status}` : entry.error ? 'no response' : '—';
      const duration = typeof entry.durationMs === 'number' ? `${entry.durationMs}ms` : '';
      const name = entry.name ?? 'Unknown';
      const url = entry.url ?? '';
      return `
        <article class="status-card">
          <p class="status-name">${esc(name)}</p>
          <p class="status-url"><a href="${safeHref(url)}" target="_blank" rel="noopener">${esc(url)}</a></p>
          <div class="status-row">
            <span class="status-pill" data-alive="${alive}">${pillText}</span>
            <span>${status}${duration ? ' · ' + duration : ''}</span>
          </div>
        </article>`;
    })
    .join('');
  const probedLabel = formatRelative(generatedAt);
  const sourceLabel = source === 'live' ? 'live probe' : 'build-time snapshot';
  meta.textContent = `Probed ${probedLabel} (${sourceLabel}).`;
  meta.dataset.tone = source === 'live' ? '' : 'stale';
}

function fetchLive() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIVE_TIMEOUT_MS);
  return fetch(LIVE_ENDPOINT, {
    headers: { Accept: 'application/json' },
    signal: controller.signal,
    cache: 'no-store',
  })
    .then((response) => {
      if (!response.ok) throw new Error('live endpoint returned ' + response.status);
      return response.json();
    })
    .finally(() => clearTimeout(timer));
}

function fetchFallback() {
  return fetch(FALLBACK_ENDPOINT, { headers: { Accept: 'application/json' } }).then((response) => {
    if (!response.ok) throw new Error('fallback returned ' + response.status);
    return response.json();
  });
}

function normalizeFallback(payload) {
  const pulse = payload && payload.pulse ? payload.pulse : {};
  const generatedAt = (payload && payload.generatedAt) || (pulse && pulse.generatedAt) || null;
  const fromSurfaceHealth = Array.isArray(pulse.surfaceHealth) ? pulse.surfaceHealth : null;
  const fromSurfaces = Array.isArray(pulse.surfaces)
    ? pulse.surfaces.map((surface) => ({
        name: surface.name,
        url: surface.url,
        alive: null,
        status: null,
        durationMs: null,
      }))
    : [];
  const results = fromSurfaceHealth ?? fromSurfaces;
  return { generatedAt, results };
}

fetchLive()
  .then((envelope) => {
    if (!envelope || !Array.isArray(envelope.results)) {
      throw new Error('live envelope malformed');
    }
    renderResults(envelope.results, envelope.generatedAt, 'live');
  })
  .catch((liveError) => {
    console.warn('status-prober live fetch failed; falling back to pulse.json', liveError);
    fetchFallback()
      .then((payload) => {
        const normalized = normalizeFallback(payload);
        renderResults(normalized.results, normalized.generatedAt, 'fallback');
      })
      .catch((fallbackError) => {
        console.error('fallback fetch failed', fallbackError);
        grid.innerHTML = '<p>Status data temporarily unavailable.</p>';
        meta.textContent = 'Unable to load status data.';
        meta.dataset.tone = 'error';
      });
  });
