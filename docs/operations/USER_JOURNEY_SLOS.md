# User Journey SLOs — W360-022

**Status:** Active  
**Owned by:** Observability team (D10)  
**Implemented:** 2026-04-29  
**Parent task:** W360-022 — User-journey SLOs

---

## 1. Availability target

All critical user journeys target **99.9% availability** (≤ 43.8 min/month downtime) per the `docs/runbooks/slo.md` baseline.

Error budget: **0.1%** (~43.8 min/month). Budget exhaustion triggers P2 incident.

---

## 2. Journey SLO definitions

| Journey ID | Journey name | Synthetic probe ID | Probe URL | SLA target | Latency p95 |
|---|---|---|---|---|---|
| J01 | Render ingest | `slo.journey.render-ingest` | `schedule-worker.adrper79.workers.dev/health` | 99.9% | < 500 ms |
| J02 | Video dispatch | `slo.journey.video-dispatch` | `video-cron.adrper79.workers.dev/health` | 99.9% | < 500 ms |
| J03 | Auth API | `slo.journey.auth-api` | `prime-self.adrper79.workers.dev/health` | 99.9% | < 300 ms |
| J04 | Operator plane | `slo.journey.operator-plane` | `api.admin.latimerwoods.dev/health` | 99.9% | < 500 ms |
| J05 | Checkout start | _Pending_ — requires `/v1/checkout` endpoint on schedule-worker | — | 99.9% | < 800 ms |
| J06 | First render complete | _Pending_ — requires job status webhook callback URL | — | 99% | < 300 s end-to-end |
| J07 | Booking confirmation | _Pending_ — requires `/v1/bookings` on Xico City (W360-014) | — | 99.9% | < 600 ms |
| J08 | Webhook ingress | `slo.journey.webhook` | `schedule-worker.adrper79.workers.dev/stripe/health` | 99.9% | < 400 ms |
| J09 | Dashboard load | _Pending_ — requires practitioner dashboard route (W360-008) | — | 99.9% | < 1 s |

---

## 3. Active synthetic probes (in TARGETS_JSON)

All probes run on a 5-minute cron via `apps/synthetic-monitor`.

### Infrastructure health probes
```
schedule-worker.health     → https://schedule-worker.adrper79.workers.dev/health (200, contains "ok")
video-cron.health          → https://video-cron.adrper79.workers.dev/health (200, contains "ok")
admin-studio.staging.health → https://api.admin.latimerwoods.dev/health (200, contains "ok")
prime-self.api             → https://prime-self.adrper79.workers.dev/health (200)
```

### Manifest integrity probes (added 2026-04-29 — W360-022)
```
schedule-worker.manifest   → https://schedule-worker.adrper79.workers.dev/manifest (200, contains "manifestVersion")
video-cron.manifest        → https://video-cron.adrper79.workers.dev/manifest (200, contains "manifestVersion")
admin-studio.manifest      → https://api.admin.latimerwoods.dev/manifest (200, contains "manifestVersion")
```

### Journey SLO proxies (added 2026-04-29 — W360-022)
```
slo.journey.render-ingest  → schedule-worker health (proxy for J01 until /checkout exists)
slo.journey.video-dispatch → video-cron health (proxy for J02 until job callback exists)
slo.journey.auth-api       → prime-self health (proxy for J03)
slo.journey.operator-plane → admin-studio staging health (proxy for J04)
slo.journey.webhook        → schedule-worker /stripe/health (J08 ingress probe)
```

### Runtime evidence (2026-04-30)
```
Direct external verification:
- https://schedule-worker.adrper79.workers.dev/health        → 200
- https://video-cron.adrper79.workers.dev/health             → 200
- https://api.admin.latimerwoods.dev/health                  → 200
- https://schedule-worker.adrper79.workers.dev/stripe/health → 200

Synthetic monitor execution context:
- Root cause was worker-to-workers.dev runtime access returning `error code: 1042` for internal checks.
- Mitigation deployed: service bindings in synthetic-monitor (`SCHEDULE_WORKER`, `VIDEO_CRON`, `ADMIN_STUDIO_STAGING`, `PRIME_SELF`) with internal fetch routing.
- Result after deploy run `25169847401`: `GET /checks/run` returns `status: ok` and all configured probes pass.
```

---

## 4. SLO burn rate alerts

| Alert | Threshold | Action |
|---|---|---|
| Fast burn (1h window) | > 14.4× error rate | P1 incident — page on-call |
| Slow burn (6h window) | > 6× error rate | P2 — Slack alert, review within 4h |
| Error budget < 50% | — | P3 — weekly review agenda item |

Alerts are configured in Sentry (uptime monitor) and PostHog (funnel drop alerts).

---

## 5. Pending journey probe additions

When the following endpoints go live, update `apps/synthetic-monitor/wrangler.jsonc` `TARGETS_JSON` for production:

```jsonc
// J05 — Checkout (W360-007): schedule-worker or dedicated checkout service
{ "id": "slo.journey.checkout", "url": "https://schedule-worker.adrper79.workers.dev/v1/checkout/health", "expectedStatus": 200 }

// J06 — First render complete (W360-007): requires a smoke-render test job endpoint
{ "id": "slo.journey.first-render", "url": "https://schedule-worker.adrper79.workers.dev/v1/jobs/smoke", "expectedStatus": 200 }

// J07 — Booking (W360-014): Xico City bookings health
{ "id": "slo.journey.booking", "url": "https://xico-city.adrper79.workers.dev/v1/bookings/health", "expectedStatus": 200 }

// J08 — Webhook ingress (W360-005): schedule-worker stripe webhook acceptance check
{ "id": "slo.journey.webhook", "url": "https://schedule-worker.adrper79.workers.dev/stripe/health", "expectedStatus": 200 }

// J09 — Dashboard (W360-008): practitioner dashboard health
{ "id": "slo.journey.dashboard", "url": "https://prime-self.adrper79.workers.dev/v1/dashboard/health", "expectedStatus": 200 }
```

---

## 6. Evidence requirements for W360-022 done state

- [x] Synthetic monitor `TARGETS_JSON` updated with manifest probes (J01–J04 proxies)
- [x] SLO doc created with journey definitions, latency targets, burn rate thresholds
- [ ] J05 (checkout) probe live — requires W360-007
- [ ] J06 (first render) probe live — requires W360-007 and render smoke test
- [ ] J07 (booking) probe live — requires W360-014 (Xico City bookings)
- [x] J08 (webhook ingress) probe live — endpoint deployed and monitor output passing (`slo.journey.webhook` → 200)
- [ ] J09 (dashboard) probe live — requires W360-008

_W360-022 is partially done. Full completion blocked on W360-005, W360-007, W360-008, W360-014._
