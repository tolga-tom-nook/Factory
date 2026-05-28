/**
 * Custom synthetic monitor targets: manifest probes, page availability, and SLO journeys.
 *
 * These complement GENERATED_TARGETS (liveness probes from service-registry.yml).
 * Edit this file directly when adding new page checks or business-journey probes.
 *
 * Per CLAUDE.md hard constraint: no hardcoded .workers.dev URLs in user-facing code.
 * Use branded domains from docs/service-registry.yml or compute via app-registry.ts.
 */

export const CUSTOM_TARGETS = [
  // ─── Manifest probes ───────────────────────────────────────────────────────
  // Manifest probes are internal monitoring only. Use branded custom domains when
  // the service has one; workers.dev fallbacks are limited to services without an
  // attached branded endpoint.
  { id: 'schedule-worker.manifest', url: 'https://schedule.latwoodtech.work/manifest', contains: 'manifestVersion' },
  { id: 'video-cron.manifest', url: 'https://video-cron.adrper79.workers.dev/manifest', contains: 'manifestVersion' },
  { id: 'admin-studio.manifest', url: 'https://api.admin.latimerwoods.dev/manifest', contains: 'manifestVersion' },

  // ─── Prime Self page availability ──────────────────────────────────────────
  { id: 'selfprime.home', url: 'https://selfprime.net/', contains: 'Prime Self' },
  { id: 'selfprime.pricing', url: 'https://selfprime.net/pricing.html', contains: 'Pricing' },
  { id: 'selfprime.practitioners', url: 'https://selfprime.net/practitioners.html', contains: 'Practitioner' },

  // ─── SLO journey probes ────────────────────────────────────────────────────
  { id: 'slo.journey.render-ingest', url: 'https://schedule.latwoodtech.work/health', contains: 'ok' },
  { id: 'slo.journey.video-dispatch', url: 'https://video-cron.adrper79.workers.dev/health', contains: 'ok' },
  { id: 'slo.journey.auth-api', url: 'https://api.selfprime.net/health', contains: 'ok' },
  { id: 'slo.journey.operator-plane', url: 'https://api.admin.latimerwoods.dev/health', contains: 'ok' },
] as const;
