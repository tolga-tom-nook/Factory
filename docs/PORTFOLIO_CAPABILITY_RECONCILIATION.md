# Portfolio Capability ↔ Marketing Reconciliation

> **Status:** initial review, 2026-05-30. Scope: selfprime + Capricast + Factory facilities.
> **Method:** cross-referenced tier configs, route tables, and source against public claims
> (marketing pages, `llms.txt`, pricing, structured data). Only **drift** is recorded — the
> large majority of claims are accurate and are not listed.

## Thesis: the gap is integration debt, not feature debt

We operate three strong, largely-built, **standalone** systems:

- **selfprime** (`Latimer-Woods-Tech/HumanDesign`) — the reading engine: chart + cross-system
  synthesis, tiers, a live (but unadvertised) public API.
- **Capricast** (`Latimer-Woods-Tech/capricast`) — a creator video platform: Cloudflare Stream,
  Durable Object realtime, Stripe Connect, on `itsjusus.com`.
- **Factory** (`Latimer-Woods-Tech/Factory`) — shared infra: a Remotion render engine
  (`apps/video-studio`) with an **`EnergyBlueprintVideo`** composition, a content render pipeline
  (`apps/video-cron` + `apps/schedule-worker` → `.github/workflows/render-video.yml` →
  `publish-to-capricast.mjs`), and shared packages (`social`, `creator`, `content`, `video`,
  `schedule`, `entitlements`).

Our **marketing already describes these as one connected product** — a "personal short film" of
your reading, a Discord + Capricast "social layer" for selfprime. The connective tissue largely
**does not exist**. The expensive, hard parts (render engine, video composition, Capricast platform,
Discord bot) are built; the **seams between them are not**. Several marketing claims become true at
once the moment a small number of integration seams are wired.

---

## selfprime — drift

| # | Claim (source) | Reality | Verdict |
|---|---|---|---|
| S1 | "Cinematic Energy Blueprint **video** — your chart rendered as a personal short film" (marketing.html L73; `llms.txt` ×4 — the stated differentiator) | No per-user video generation in the HumanDesign repo. One static welcome video + static training clips. **However**, the render *engine* exists in Factory (`video-studio/EnergyBlueprintVideo.tsx`, per-user-capable schema). Missing = the trigger + data feed (see seam I1). | **Over-claim** — true engine exists, not wired per-user |
| S2 | Studio tier: "**On the roadmap**: white-label client portal, API access, custom webhooks" (pricing.html L276) | Agency tier already has `whiteLabel:true`, `apiCallsPerMonth:10000`, `customWebhooks:true`. API keys + webhooks + embed widget are live (`/api/keys`, `/api/webhooks`, `/api/embed`). | **Under-claim** — shipped, sold as "future" |
| S3 | "14-day free trial — **no credit card required**" (pricing.html L117) | Checkout collected a card. **Fixed** in HumanDesign PR #327 (`payment_method_collection: 'if_required'`). | ✅ Resolved |
| S4 | Free: "1 Synthesis reading / month" | Delivered but `savedProfilesMax:0` → reading vanished on return. **Fixed** in PR #327 (→1). | ✅ Resolved |
| S5 | "Sign in with Google" | OAuth users blocked next session by email-verify DB desync. **Fixed** in PR #327. | ✅ Resolved |

## Capricast — drift

| # | Claim (source) | Reality | Verdict |
|---|---|---|---|
| C1 | "Stream, interact, and **monetize** — all in real time" (README/positioning) | Stream ✅ and realtime ✅ are built. **Monetize**: Stripe Connect is wired but creator payout distribution (C-9) is **design-pending** — "requires creator onboarding flow, out of scope for MVP." Creators cannot be paid out yet. | ⚠️ "Monetize" partially aspirational |
| C2 | Implied connection to selfprime / "social layer" | **Zero** references to selfprime, Energy Blueprint, or Discord in the entire Capricast repo. Fully standalone. | 🔴 Unbuilt |

## Factory — facilities relevant to integration

| Facility | State | Note |
|---|---|---|
| `apps/video-studio` `EnergyBlueprintVideo` composition | **Built, per-user-capable** | Schema accepts `hdType`, `definedCenters`, `showBodyGraph`, personalized `script`, `narrationUrl`, forge theme, brand color/logo. |
| Render pipeline (`video-cron` → `render-video.yml`) | **Built, content-driven** | Dispatches by `{composition, app_id, topic}` from a content calendar seeded by `content-briefs/prime-self/*.json` — **not** by individual user readings. No `user_id`/chart payload. |
| `publish-to-capricast.mjs` | **Built** | Pipeline already renders and publishes to Capricast. |
| Discord bot (`prime-self-discord`) | **Lives in HumanDesign**, deployed | A working **acquisition funnel**, not a social layer: `/primself` → calls the live selfprime API (`/api/chart/calculate`) → Quick Start embed → UTM-tagged 14-day-trial upsell; 3 lookups/day; a 4h cron DMs new guild members a welcome. **No** HD-type roles/channels, **no** Discord↔selfprime identity link, **no** Capricast tie-in, **no** community feed. No Discord app in Factory. |
| `apps/marketing-supervisor` | **Not built** | Spec'd (`MARKETING_SUPERVISOR.md`) but no app directory exists. |
| Packages `social` (290 ln), `content` (297), `creator` (66), `entitlements` (53) | Real, not stubs | Candidate building blocks for a cross-product social/identity layer. |

---

## The integration seams (what's actually missing)

These are the small, well-defined gaps that, once closed, make the marketing true.

- **I1 — Per-user Energy Blueprint video (fixes S1).** selfprime reading completion → enqueue a
  render job carrying the user's real chart (`hdType`, defined centers) + synthesis script →
  `render-video.yml` (already renders `EnergyBlueprintVideo`) → `publish-to-capricast.mjs` (built)
  → surface the video back on the user's blueprint page. The engine and publish steps exist; the
  **per-user trigger + real-data feed + return-to-user surface** do not.
  → **Full difficulty assessment + phased plan: [`architecture/I1_PERSONAL_BLUEPRINT_VIDEO.md`](architecture/I1_PERSONAL_BLUEPRINT_VIDEO.md)** (verdict: medium–high; ~3–4 wk MVP since ~70% of the machinery exists).
- **I2 — API productization (fixes S2).** The API is live on Agency. Decide packaging (surface as
  shipped on the Studio card; consider an API/developer add-on or tier to capture the API buyer who
  doesn't need 5 practitioner seats — competitor humandesignhub.app markets exactly this).
- **I3 — Social layer (the "D" vision).** selfprime/Capricast/Discord are three separate systems.
  The Discord bot is a working **acquisition funnel** (`/primself` → API → trial upsell + welcome-DM
  cron) but has no community/identity features. A "social layer" requires net-new glue on top of it:
  (a) Discord↔selfprime **identity linking** + HD-type **roles/channels** (segment community by energy
  type), (b) surfacing selfprime per-user videos (I1) as **Capricast** channel content, (c) a
  **Capricast↔Discord** bridge (new video → announcement; community → channels), using
  `packages/entitlements` + `packages/social` for shared identity. Entirely unbuilt; depends on I1.
  The "75% done" is the three platforms + the funnel; the missing 25% is this glue.
- **I4 — Capricast creator payouts (fixes C1).** Complete C-9 (creator onboarding + Stripe Connect
  transfer routing) before "monetize" is fully honest.

## Prioritized backlog

1. **I1 — per-user video** (🔴 highest trust risk; engine already exists, so high leverage).
2. **I2 — API positioning** (🟡 cheap, immediate: copy + packaging decision).
3. **I4 — Capricast payouts** (🟡 honesty of "monetize").
4. **I3 — social layer** (🟢 strategic; sequence after I1).
5. *(Resolved in HumanDesign PR #327: S3 trial promise, S4 free-tier retention, S5 OAuth login.)*

## Honest-marketing quick wins (no integration required)

✅ **Shipped in HumanDesign PR #328** (2026-05-30):
- S2 — pricing.html "On the roadmap" → included Studio features (white-label/API/webhooks).
- S1 — removed the per-user "personal short film" promise from feature lists, FAQs, JSON-LD, and
  `llms.txt`; kept the true "cinematic synthesis reading" framing. Reinstate when I1 ships.
