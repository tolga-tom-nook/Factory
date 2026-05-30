# I1 — Per-User Energy Blueprint Video: Implementation Plan

> **Seam I1** from [`../PORTFOLIO_CAPABILITY_RECONCILIATION.md`](../PORTFOLIO_CAPABILITY_RECONCILIATION.md).
> Goal: make the "your chart rendered as a personal short film" claim true — a per-user
> Energy Blueprint video, generated from a user's real reading, surfaced on their blueprint
> page (and, via [I3], shareable through Capricast + Discord).
>
> **Difficulty verdict: Medium–High.** This is *integration*, not greenfield — the expensive parts
> already exist — but (per review) the MVP is more **contract + orchestration + privacy/cost control**
> than "just wiring." Realistic MVP: **~3–4 focused weeks** once Phase 0 locks the job/callback
> schema, the entitlement-enforcement boundary, Stream-only hosting, and selfprime-authored narration.
> Social attribution (I3) and a dedicated render service (scaling) are follow-on milestones.
>
> *Revision history: v2 (2026-05-30) tightened Phase 0 contracts and added the public-visibility
> privacy guard after review.*

---

## Why it's not "hard" (what already exists — the de-risk)

| Asset | Repo | State |
|---|---|---|
| `EnergyBlueprintVideo` Remotion composition — schema accepts `hdType`, `definedCenters`, `scenes[]`, `forgeTheme`, `script`, `narrationUrl`, branding | Factory `apps/video-studio` | **Built, per-user-capable** |
| Full render pipeline: script → ElevenLabs narration → Remotion → ffmpeg → R2 → Stream → `publish-to-capricast` → callback | Factory `render-video.yml` + `apps/video-studio/scripts/*` | **Working** (for content videos) |
| Render dispatcher (`video-cron` → `workflow_dispatch`) + job model with `status`/`webhook`/`done` transitions | Factory `apps/video-cron`, `apps/schedule-worker` | **Built** |
| Capricast import endpoint `POST /api/admin/videos/import` | capricast `apps/worker/src/routes/admin.ts` | **Built** |
| Full chart data (type, authority, defined/undefined centers, channels, 64 gates) + synthesis reading text | selfprime `HumanDesign` | **Built** |

## Why it's not "easy" (the actual I1 work — what's missing)

| Gap | Where | Notes |
|---|---|---|
| **G1. Per-user trigger** | selfprime | Nothing enqueues a render on reading completion. The schedule-worker queue is content-calendar-driven (topic/brief), not per-user. |
| **G2. Per-user props not passed** | `render-video.yml` (~L666) | The `EnergyBlueprintVideo` branch passes only `{script, narrationUrl, branding}` — **not** `hdType`/`definedCenters`/`scenes`. So today it renders a *generic* blueprint (scenes auto-derived from text), not the user's chart. |
| **G3. Chart→scenes mapper** | new (Factory `video-studio` lib or shared pkg) | Map a selfprime profile (type, authority, defined centers, key gates, forge) → `scenes[]` + `hdType` + `forgeTheme`. Net-new; quality-sensitive. |
| **G4. Narration from the real reading** | `generate-script.mjs` | Today it generates narration from a *topic* via LLM. Per-user needs a mode that condenses the user's **actual synthesis** into a ~75s / ~200-word narration. Must obey the **no-"AI"-in-copy** rule. |
| **G5. Async job + status + return-to-user** | selfprime + pipeline | Render takes minutes. Need: a `blueprint_video` status on the profile, a signed callback from the pipeline → selfprime to store the video URL, user notification (email + in-app), and a blueprint-page video panel with none/generating/ready/failed states. |
| **G6. Entitlement + cost gating** | selfprime | Per-user Remotion + ElevenLabs + Stream + CI minutes cost real money. Must gate (paid tiers and/or on-demand, deduped, quota-capped). Free-for-all = cost blowout + GitHub-Actions-as-render-farm abuse. |
| **G7. Cross-repo auth** | selfprime ↔ schedule-worker ↔ Actions | Enqueue + callback need a shared HMAC secret; workflow dispatch already uses a least-privilege GitHub App token (`create-github-app-token`). |
| **G8. Identity/attribution** | Capricast (I3) | `publish-to-capricast` attributes every upload to **one** `CAPRICAST_CREATOR_ID`. Per-user/social attribution needs Discord↔selfprime↔Capricast identity linking — **deferred to I3**; I1 MVP hosts on selfprime's own Stream or a system creator. |

---

## Target architecture (data flow)

```
selfprime: reading completes (profile.js / profile-stream.js)
  └─ entitlement + quota check (G6) → enqueue render job
       POST schedule-worker /jobs  { appId:'prime_self', type:'blueprint_video',
         idempotencyKey: profileId, userId, callbackUrl, props:{ hdType, definedCenters,
         forgeTheme, scenes[], sourceReading } }              (HMAC-signed, G7)
  └─ profile.blueprint_video_status = 'queued'

Factory video-cron (cron) → dispatch render-video.yml (job_id, composition=EnergyBlueprintVideo,
  per-user props)                                            (G2: pass full props)
  └─ generate-script.mjs --from-reading (condense user's synthesis → narration, G4)
  └─ ElevenLabs narration → R2
  └─ Remotion render EnergyBlueprintVideo(props incl. real scenes, G3) → ffmpeg → R2 → Stream
  └─ publish-to-capricast (system creator for MVP; per-user via I3)
  └─ PATCH schedule-worker job → done
  └─ signed callback → selfprime: store video URL + status=ready (G5)

selfprime: blueprint page renders video panel (none/generating/ready/failed)
  └─ notify user (Resend email + in-app)                     (G5)
```

**Cohesion principle:** reuse the existing job model and pipeline rather than inventing a parallel
one. The reading never blocks on the render (fully async). Trigger is **idempotent** (one video per
`profileId`; re-generation supersedes).

---

## Decisions — LOCKED for MVP (Phase 0)

> Tightened after review. The MVP is **contract + orchestration + privacy/cost controls**, not "just
> wiring" — so these are locked up front to prevent sprawl.

1. **Who gets a video — PAID + ON-DEMAND only.** Individual/Practitioner tiers, triggered by an explicit "Generate my film" action (never auto on free/anonymous readings). New `blueprintVideo` feature in `getTierConfig` (default off) + a `blueprint_video_generation` quota via the existing atomic `enforceUsageQuota` machinery.
2. **Hosting — STREAM-ONLY for MVP.** Render → selfprime's own Cloudflare Stream, surfaced privately on the blueprint page. **Capricast publishing is SKIPPED for personal jobs** (see privacy note below). Per-user Capricast attribution/social is deferred to **I3**.
3. **Narration — SELFPRIME-AUTHORED.** selfprime condenses the user's real synthesis into the final narration text and passes it in the job. **Personal jobs skip Factory `generate-script.mjs` entirely** — no Factory-side LLM call. This puts the no-"AI"-wording governance where the content already lives and removes a moving part.
4. **Notification — email (Resend) + in-app.** Both exist.

> ⚠️ **Privacy (review finding):** the Capricast import path hardcodes `visibility: "public"`
> (`capricast .../routes/admin.ts`). A per-user reading auto-published public is a privacy breach.
> The render workflow's "Publish to Capricast" step is currently **unconditional** — personal jobs
> MUST skip it (or, in I3, publish only with explicit consent + private/unlisted visibility).

## Contracts to lock in Phase 0

**Personal render job** (extends the schedule-worker `POST /jobs` schema, which today carries only
`appId`/`type`/`topic`/scheduling/score/idempotency). Add a new render type — the shared
`RenderJobType` union (`packages/video`) is currently `marketing | training | walkthrough` and must
gain `personal_blueprint`:

```jsonc
{
  "appId": "prime_self",
  "type": "personal_blueprint",
  "idempotencyKey": "<profileId>",          // one in-flight render per profile version
  "userId": "<uuid>",
  "profileId": "<uuid>",
  "callbackUrl": "https://api.selfprime.net/api/internal/blueprint-video/callback",
  "props": {                                  // → EnergyBlueprintVideo (no Factory LLM)
    "hdType": "projector",
    "forgeTheme": "lux",
    "definedCenters": ["G","Ajna","Throat"],
    "scenes": [ /* from chartToScenes() */ ],
    "narration": "<final selfprime-authored text>",
    "brandColor": "#c9a84c", "logoUrl": "..."
  }
}
```

**Enforcement point (cost gating, review finding):** Factory scheduling does **not** check
entitlement and `video-cron` dispatches any pending job for an app. So the trust boundary is:
(a) selfprime enforces tier + quota **before** enqueue, and (b) schedule-worker **rejects personal
jobs unless they carry a valid signed entitlement proof from a trusted internal caller** (shared
HMAC, see below). Never accept an unauthenticated `personal_blueprint` job.

**Callback/auth contract:** the existing completion is a *bearer-token PATCH to schedule-worker*
`{status, streamUid, videoUrl}` — that is **not** a signed selfprime callback. Define:
- Topology: workflow → schedule-worker (existing PATCH) → **signed** schedule-worker → selfprime callback (keeps the GitHub App token out of selfprime's trust domain).
- Auth: HMAC-SHA256 over the raw body with a shared secret (GCP Secret Manager); `X-Signature` + `X-Timestamp` headers; **±5-min replay window**; reject stale/duplicate by `idempotencyKey`.
- Final statuses: `ready | failed` (with `failureReason`); selfprime stores `blueprint_video_url`, `blueprint_video_status`, `blueprint_video_profile_id`.

---

## Phased plan

### Phase 0 — Lock contracts & decisions (0.5 wk)
- Ratify the locked decisions above. Land the three contracts as the source of truth: (1) the `personal_blueprint` job payload + extend `RenderJobType` in `packages/video`; (2) the entitlement/enforcement boundary (selfprime quota + schedule-worker rejects unsigned personal jobs); (3) the signed callback schema (HMAC, replay window, statuses). Add `blueprintVideo` feature to `getTierConfig` (default off) and the `blueprint_video_generation` quota.

### Phase 1 — Render fidelity (Factory) (1 wk)
- **G3:** `chartToScenes(profile)` mapper in `video-studio` (type→`hdType`/`forgeTheme`, defined centers→`definedCenters`/`showBodyGraph` scenes, signature gates→concept scenes). Snapshot-test the props.
- **G4:** personal jobs **bypass `generate-script.mjs`** — narration text comes pre-authored from selfprime in the job payload (no-"AI" governance at source). Topic/LLM mode stays only for content videos.
- **G2:** extend `render-video.yml` props assembly so `EnergyBlueprintVideo` receives the full per-user props (`hdType`/`definedCenters`/`scenes`/`narration`) from the job payload via `job_id`; **skip the Capricast publish step for `personal_blueprint`** (privacy).
- *Verify:* `dry_run` render of a fixture profile produces a chart-accurate MP4.

### Phase 2 — Trigger & orchestration (selfprime + Factory) (1 wk)
- **G6 (enforcement):** on-demand endpoint `POST /api/profile/:id/video` enforces tier + `blueprint_video_generation` quota on selfprime **before** enqueue; schedule-worker accepts `personal_blueprint` **only** with a valid signed entitlement proof from the trusted internal caller (no open enqueue).
- **G1/G7:** selfprime enqueues the HMAC-signed `personal_blueprint` job (payload per the Phase 0 contract) with `idempotencyKey=profileId`; `video-cron` dispatches with per-user props.
- *Verify:* end-to-end `curl` from enqueue → workflow run → Stream asset; confirm an unsigned/over-quota enqueue is rejected.

### Phase 3 — Return-to-user (selfprime) (0.5–1 wk)
- **G5:** signed callback endpoint stores `blueprint_video_url` + `status` on the profile; migration for the new columns.
- Blueprint-page video panel: states none/generating/ready/failed+retry (mirror the existing profile-generation UX).
- Notify: Resend email + in-app on `ready`.
- *Verify:* click-through — generate → pending → email → video plays on blueprint page.

### Phase 4 — Capricast attribution & social (I3 overlap) (later)
- Per-user creator attribution in `publish-to-capricast`; Discord↔selfprime↔Capricast identity linking; watch page + share. Tracked as **I3**.

### Phase 5 — Scale off GitHub Actions (later, volume-gated)
- GitHub Actions concurrency/cost ceilings make it a poor per-user render farm at volume. Move render to a dedicated service (Cloud Run + Remotion, or a render queue) once demand warrants. MVP volume is fine on Actions with a quota cap.

---

## Risk hotspots & guardrails

- **Cost/abuse (highest):** gate by tier + monthly quota (reuse `enforceUsageQuota`), dedupe by `profileId`, daily ceiling. Never render on every anonymous/free reading.
- **Async UX:** explicit pending/failed states + retry; never imply instant. Email when ready.
- **Render quality:** the generic composition must look right with real chart data — snapshot tests + a manual review gate in Phase 1.
- **"No AI" rule:** narration/UI copy must never say "AI" — use "your reading", "synthesis", "the Oracle".
- **Cross-repo security:** least-privilege GitHub App token (exists); HMAC-sign enqueue + callback; validate signatures both ways.
- **Idempotency:** one in-flight render per profile; re-gen supersedes; guard against double-dispatch (the job model already marks `rendering`).
- **Observability:** Sentry + `factory_events`; track render success rate, latency, and per-render cost.
- **Secrets:** ElevenLabs / Stream / Capricast tokens already sourced from GCP Secret Manager via WIF — add the selfprime↔schedule-worker HMAC secret there.

## Effort summary

| Phase | Scope | Est. |
|---|---|---|
| 0 | Spec + decisions + feature flag | 0.5 wk |
| 1 | Render fidelity (mapper, narration, props) | 1 wk |
| 2 | Trigger + orchestration + entitlement | 1 wk |
| 3 | Return-to-user (callback, panel, notify) | 0.5–1 wk |
| **MVP total** | **Phases 0–3** | **~3–3.5 wk** |
| 4 | Capricast/social attribution (I3) | follow-on |
| 5 | Dedicated render service (scale) | follow-on |

**Bottom line:** medium-high difficulty, low-to-moderate *technical risk* (the engine exists), with
the real effort in the async orchestration, the chart→scenes mapper quality, and disciplined cost
gating. It is very achievable as a focused 3–4 week MVP because ~70% of the machinery is already built.
