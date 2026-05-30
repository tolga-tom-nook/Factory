# I1 — Per-User Energy Blueprint Video: Final-State Design

> **Seam I1** from [`../PORTFOLIO_CAPABILITY_RECONCILIATION.md`](../PORTFOLIO_CAPABILITY_RECONCILIATION.md).
> Goal: make "your chart rendered as a personal short film" true — a per-user Energy Blueprint film,
> generated from a user's real reading, owned as a first-class private asset of their reading, and
> (by explicit consent) shareable through Capricast + Discord.
>
> **Design stance:** this document specifies the **final state**, then defines build slices that are
> each **production-final and additive** — no throwaway MVP, no version-by-version reshaping of the
> same surface, no "ship Stream-only then migrate." Every decision below is made once, correctly.
>
> **Effort:** ~5–7 focused weeks to the full final state (private film + social publishing). The
> render *logic* already exists and is reused; the work is correct orchestration, a proper render
> service, clean domain boundaries, and the cross-product identity layer.

---

## 1. Domain model (the thing we are building)

The **Energy Blueprint Film** is a first-class asset of a `Profile` (a user's reading), owned by
selfprime. It is **private by default** and has an explicit lifecycle and a separate, explicit
sharing state. It is never implicitly public.

```
BlueprintFilm
  id, profile_id (1:1 with the reading version), user_id
  status:        requested | rendering | ready | failed
  failure_reason: text | null
  stream_uid:     Cloudflare Stream UID (selfprime's Stream account)   // canonical, private
  playback:       signed-URL policy (private; tokenized playback)
  duration_s, created_at, ready_at
  share:                                                               // social life (consented)
    capricast_video_id | null
    discord_announced_at | null
    visibility: private | unlisted | public                           // user-chosen, default private
```

**Domain boundaries (decided, final):**
- The film **belongs to the private reading** → its canonical home is **selfprime + Cloudflare
  Stream**, with **signed/tokenized playback**. It is not a Capricast object that selfprime borrows.
- **Capricast is the social/creator surface**, reached only by an explicit, consented "share"
  action that publishes the existing Stream asset under the user's **linked Capricast identity**.
- **Discord** is a community surface that announces *shared* films (never private ones).

This boundary is why there is no "migrate from Stream to Capricast later": Stream is the permanent
private home; Capricast publishing is a permanently-distinct, additive capability.

## 2. Component architecture & data flow

```
selfprime (HumanDesign)                Factory                         Cloudflare / Capricast
─────────────────────────             ───────────────────────         ──────────────────────
reading completes / "Generate
  my film" (entitled, on-demand)
  │ enforce tier + quota (atomic)
  │ author narration from synthesis
  │ map chart → scenes
  ▼
POST Render Service  ───signed──▶   Render Service (Cloud Run)
  { filmId, profileId, props,        Remotion(EnergyBlueprintVideo, real props)
    narration, callbackUrl }         → ffmpeg → upload → Cloudflare Stream (private)
                                     → signed callback ──▶  selfprime: store stream_uid, status=ready
  ▼                                                          │
blueprint page: <Player> (signed)  ◀──────────────────────────┘
  states: none|rendering|ready|failed+retry
  notify: email (Resend) + in-app

  ── explicit "Share my film" (consent + visibility) ─────────────────▶
     publish Stream asset → Capricast import (visibility=chosen, creatorId=linked identity)
     → optional Discord announce (linked member)                        [the I3 social bridge]
```

**Render execution is a dedicated service, not CI.** Per-user, on-demand rendering does **not**
belong on GitHub Actions (`workflow_dispatch` has concurrency/throughput ceilings, is semantically
CI, and is the classic "works until volume, then rework" trap). The final state is a **Remotion
render service on Cloud Run** (the platform already runs Cloud Run for `browser-agent`; heavy compute
is GCP per platform convention). The existing `render-video.yml` pipeline **remains** — for its
correct workload, *scheduled content videos* — and the `EnergyBlueprintVideo` composition, the
chart→scenes mapper, and the render scripts are a **shared library** reused by both. Clean separation
of two genuinely different workloads (scheduled content vs on-demand personal).

## 3. Mature engineering decisions (made once)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Film = private first-class Profile asset**, canonical on selfprime + **Cloudflare Stream with signed playback** | Domain-correct; a personal reading is private. No public-by-default ever. |
| D2 | **Dedicated Cloud Run render service** for on-demand personal renders; CI pipeline kept only for scheduled content | Correct workload placement; no CI-as-render-farm rework. Reuses the composition/mapper/scripts as a shared lib. |
| D3 | **selfprime authors the narration** from the real synthesis; Factory never LLM-generates personal narration | No-"AI"-wording governance at source; one fewer moving part; authentic to the reading. |
| D4 | **Capricast `visibility` made explicit** (param; default `unlisted`; **never auto-public**) — a correctness fix to the import endpoint, applied for all callers | Fixes a latent privacy bug properly instead of skip-hacking it for personal jobs. |
| D5 | **First-class cross-product identity link** (selfprime user ↔ Capricast creator ↔ Discord member) in the shared identity layer | The social slice needs real identity, not a system creator. Designed up front so nothing is reworked. |
| D6 | **`blueprintVideo` tier feature + `blueprint_video_generation` quota**, enforced atomically at selfprime; render service accepts only signed, entitled requests | Cost/abuse control is part of the domain, not bolted on. |
| D7 | **Signed, idempotent async contract** (HMAC, replay window, `idempotencyKey=filmId`) end to end | Mature service-to-service security; safe retries; exactly-once render per reading version. |
| D8 | **Generation is on-demand & consented**, not automatic on every reading | Cost + user intent; the film is a deliberate artifact. |

## 4. What is reused vs net-new

**Reused (de-risk — proven to work):** the `EnergyBlueprintVideo` Remotion composition (per-user
schema already present), the render scripts (`render.ts`, ElevenLabs narration, ffmpeg, Stream
upload), the Capricast import endpoint, selfprime's chart engine + synthesis, Resend/in-app
notifications, the atomic quota machinery (`enforceUsageQuota`).

**Net-new (the build):** the Cloud Run render service wrapper (D2); `chartToScenes()` mapper;
selfprime narration-authoring step (D3); `BlueprintFilm` domain + storage + state machine; the
signed render-request + callback contract (D7); `blueprintVideo` entitlement + quota (D6); the
blueprint-page film panel with signed playback; the explicit share action; the `visibility` fix on
Capricast import (D4); the identity-link model + UI (D5); the Discord announce hook.

## 5. Build slices (each production-final, additive — no rework between slices)

Slices are vertical and shippable; **each is built to final-state quality**, and later slices add
capability without reshaping earlier ones.

- **Slice 0 — Foundations & contracts (design-complete artifacts).**
  `BlueprintFilm` schema + migration; the signed render-request and callback schemas (D7); the
  `blueprintVideo` feature in `getTierConfig` + `blueprint_video_generation` quota (D6); the
  identity-link schema (D5, defined now, populated in Slice 3). Shared types in `packages/video`
  extended with the personal render contract. *These are the source of truth; later slices implement
  against them unchanged.*

- **Slice 1 — Render service (Factory, Cloud Run).**
  Remotion render service: accepts a signed render request, renders `EnergyBlueprintVideo` with full
  per-user props, ffmpeg-encodes, uploads to selfprime's Cloudflare Stream (private), emits the
  signed callback. `chartToScenes()` mapper + snapshot tests. Reuses composition/scripts as a lib.
  *Verify:* signed request with a fixture profile → private Stream asset + valid callback.

- **Slice 2 — Generation & private viewing (selfprime, end-to-end private feature complete).**
  Narration authoring from synthesis (D3, no-"AI"); entitlement + quota enforcement (D6); on-demand
  `POST /api/profile/:id/film`; `BlueprintFilm` state machine + signed-playback surfacing on the
  blueprint page (none/rendering/ready/failed+retry); Resend + in-app notify. *This slice fully
  satisfies the marketing claim* — the private personal film exists and plays.

- **Slice 3 — Social publishing (the I3 bridge, additive).**
  Capricast `visibility` correctness fix (D4); cross-product identity link (D5); explicit, consented
  "Share my film" → Capricast publish under the linked creator at chosen visibility; optional Discord
  announce. Nothing in Slices 0–2 changes.

## 6. Contracts (authored in Slice 0, immutable thereafter)

**Render request** (selfprime → render service, signed):
```jsonc
{
  "filmId": "<uuid>",            // == idempotency key; one render per reading version
  "profileId": "<uuid>", "userId": "<uuid>",
  "callbackUrl": "https://api.selfprime.net/api/internal/film/callback",
  "composition": "EnergyBlueprintVideo",
  "props": { "hdType": "...", "forgeTheme": "...", "definedCenters": ["..."],
             "scenes": [ /* chartToScenes() */ ], "narration": "<final text>",
             "brandColor": "#c9a84c", "logoUrl": "..." }
}
```
Auth: `X-Signature` = HMAC-SHA256(rawBody, secret); `X-Timestamp`; **±5-min replay window**; reject
duplicate `filmId` in a terminal state.

**Callback** (render service → selfprime, signed, same scheme): `{ filmId, status: ready|failed,
streamUid?, durationSeconds?, failureReason? }`.

**Entitlement:** `blueprintVideo` feature on Individual/Practitioner tiers; `blueprint_video_generation`
monthly quota via `enforceUsageQuota`; the render service rejects any request lacking a valid signature.

**Identity link** (Slice 0 schema, Slice 3 use): `account_links(user_id, provider: capricast|discord,
external_id, linked_at, verified)`.

## 7. Risks & guardrails

- **Cost/abuse:** on-demand + entitled + quota-capped + deduped by `filmId`; the render service is
  the only renderer and only accepts signed requests. (No anonymous/free render path exists.)
- **Privacy:** private-by-default, signed playback; Capricast publish is opt-in with explicit
  visibility; the `visibility:"public"` default is removed at the source (D4).
- **Render fidelity:** `chartToScenes()` snapshot tests + a human review gate; the generic composition
  must read correctly with real chart data.
- **No "AI" in copy:** narration + all UI strings — "your reading", "synthesis", "the Oracle".
- **Security:** signed both directions (D7); render service runs least-privilege; secrets in GCP
  Secret Manager via WIF.
- **Observability:** Sentry + `factory_events`; track render success rate, latency, cost per film.
- **Workers constraints:** selfprime/worker code stays within the platform hard constraints; the
  render service (Node + Chromium + ffmpeg) runs on Cloud Run, never in a Worker.

## 8. Effort (by slice, final-quality)

| Slice | Scope | Est. |
|---|---|---|
| 0 | Foundations & contracts (schemas, entitlement, identity model, shared types) | ~1 wk |
| 1 | Cloud Run render service + chart→scenes mapper | ~1.5–2 wk |
| 2 | selfprime generation + private viewing + notify (claim satisfied) | ~1.5–2 wk |
| 3 | Social publishing: Capricast visibility fix + identity link + share + Discord | ~1.5 wk |
| **Total (final state)** | Slices 0–3 | **~5–7 wk** |

**Bottom line:** medium-high effort, low technical risk (render logic proven). Designed as a complete
system and built in production-final slices, so there is no v1→v2 churn and no migration debt — the
private film (Slice 2) satisfies the marketing claim, and social (Slice 3) is purely additive.
