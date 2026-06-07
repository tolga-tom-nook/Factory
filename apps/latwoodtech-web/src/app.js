function renderStats(stats) {
  return stats
    .map(
      (stat) => `
        <article class="pulse-kpi">
          <span class="pulse-kpi-label">${stat.label}</span>
          <strong class="pulse-kpi-value">${stat.value}</strong>
          <span class="pulse-kpi-context">${stat.context}</span>
        </article>`,
    )
    .join('');
}

function renderStory(items) {
  return items.map((item) => `<li>${item}</li>`).join('');
}

function renderHealth(items) {
  return items
    .map(
      (item) => `<span class="pulse-chip" data-tone="${item.tone}">${item.label}: ${item.value}</span>`,
    )
    .join('');
}

function renderSurfaces(items) {
  return items
    .map(
      (item) => `
        <article class="surface-card">
          <p class="surface-category">${item.category}</p>
          <strong>${item.name}</strong>
          <span>${item.note}</span>
          <a href="${item.url}" target="_blank" rel="noreferrer">${new URL(item.url).hostname}</a>
        </article>`,
    )
    .join('');
}

function renderVectors(items) {
  return items
    .map(
      (item) => `
        <article class="vector-card" data-tone="${item.tone}">
          <span class="vector-name">${item.name}</span>
          <strong class="vector-value">${item.value}</strong>
          <span class="vector-state">${item.state}</span>
          <p class="vector-context">${item.context}</p>
        </article>`,
    )
    .join('');
}

  const CONTACT_ENDPOINT = 'https://webhooks.latwoodtech.work/contact';

async function hydratePulse() {
  const root = document.querySelector('[data-pulse-root]');
  if (!root) return;

  const status = root.querySelector('.pulse-status');
  const updated = root.querySelector('[data-pulse-updated]');
  const stats = root.querySelector('[data-pulse-stats]');
  const story = root.querySelector('[data-pulse-story]');
  const health = root.querySelector('[data-pulse-health]');
  const security = root.querySelector('[data-pulse-security]');
  const surfaces = root.querySelector('[data-pulse-surfaces]');
  const vectors = root.querySelector('[data-pulse-vectors]');

  try {
    const response = await fetch('./data/pulse.json', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Pulse feed returned ${response.status}`);
    const payload = await response.json();
    const pulse = payload.pulse;

    if (status) status.textContent = pulse.summary;
    if (updated) {
      updated.textContent = `Updated ${new Date(payload.generatedAt).toLocaleString()}`;
    }
    if (stats) stats.innerHTML = renderStats(pulse.stats);
    if (story) story.innerHTML = renderStory(pulse.story);
    if (health) health.innerHTML = renderHealth(pulse.health);
    if (security) security.textContent = pulse.securityModel;
    if (surfaces) surfaces.innerHTML = renderSurfaces(pulse.surfaces);
    if (vectors) vectors.innerHTML = renderVectors(pulse.vectors ?? []);
    if (Array.isArray(pulse.surfaces)) {
      for (const el of document.querySelectorAll('[data-hero-stat="surfaces"]')) {
        el.textContent = String(pulse.surfaces.length);
      }
    }
  } catch (error) {
    if (status) status.textContent = 'Public operating picture temporarily unavailable.';
    if (updated) updated.textContent = 'Feed unavailable';
    if (security) {
      security.textContent =
        'The homepage stays operational even if the feed fails. The pulse layer is read-only and non-critical.';
    }
    if (vectors) {
      vectors.innerHTML = `
        <article class="vector-card" data-tone="warning">
          <span class="vector-name">Signal unavailable</span>
          <strong class="vector-value">--</strong>
          <span class="vector-state">Feed offline</span>
          <p class="vector-context">The pulse surface remains read-only and non-critical.</p>
        </article>`;
    }
    console.error(error);
  }
}

hydratePulse();

async function hydrateHeroStats() {
  try {
    const res = await fetch('./data/founder-stats.json', { headers: { Accept: 'application/json' } });
    if (!res.ok) return;
    const stats = await res.json();
    for (const el of document.querySelectorAll('[data-hero-stat="apps"]')) {
      el.textContent = stats.deployedApps;
    }
    const monthlyCost = Number(stats.monthlyCostUsd);
    const deployedApps = Number(stats.deployedApps);
    const perApp = monthlyCost > 0 && deployedApps > 0 ? (monthlyCost / deployedApps).toFixed(2) : '0.34';

    for (const el of document.querySelectorAll('[data-hero-stat="per-app"]')) {
      el.textContent = perApp;
    }
  } catch {
    /* fallback values already seeded in HTML */
  }
}

hydrateHeroStats();

function setContactStatus(element, message, tone = 'neutral') {
  if (!element) return;
  element.textContent = message;
  element.setAttribute('data-tone', tone);
}

function initContactForm() {
  const form = document.querySelector('[data-contact-form]');
  if (!(form instanceof HTMLFormElement)) return;

  const status = form.querySelector('[data-contact-status]');
  const submit = form.querySelector('button[type="submit"]');

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!(submit instanceof HTMLButtonElement)) return;

    submit.disabled = true;
    setContactStatus(status, 'Sending...', 'neutral');

    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());

    try {
      const response = await fetch(CONTACT_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? `Contact request failed (${response.status})`);
      }

      form.reset();
      setContactStatus(status, 'Message sent. It has been routed for follow-up.', 'good');
    } catch (error) {
      setContactStatus(
        status,
        error instanceof Error ? error.message : 'Unable to send right now. Use the direct call or email action.',
        'warning',
      );
    } finally {
      submit.disabled = false;
    }
  });
}

initContactForm();
