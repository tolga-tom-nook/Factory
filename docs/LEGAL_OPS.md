# Legal & Domain Operations (G18)

> **Why this exists.** A single place to track the legal/operational facts that don't live in
> code: domain renewals, trademark/IP status, ToS/Privacy-Policy versions per product, business
> entity + tax registrations, and the third-party data processors we're accountable for. Without
> this, a domain silently expires or a privacy obligation is missed.
>
> **Closes:** [`GAP_REGISTER.md`](./GAP_REGISTER.md) G18. **Companion:** [`BUS_FACTOR.md`](./BUS_FACTOR.md) (operator continuity).
>
> 🔲 = operator-only fact to fill in. **Review cadence:** monthly (Monday review) for renewal
> dates; quarterly for entity/tax/IP. Domains/zones cross-check against
> [`service-registry.yml`](./service-registry.yml).

---

## 1. Domain registry

Domains discovered from [`service-registry.yml`](./service-registry.yml) on 2026-06-01. Fill in
registrar, renewal date, and auto-renew status — **an expired apex domain takes the whole product
offline.**

| Domain | Product / use | Registrar | Renewal date | Auto-renew | Notes |
|---|---|---|---|---|---|
| `selfprime.net` | Selfprime (apex + `api.selfprime.net`) | 🔲 | 🔲 | 🔲 | Primary, #1 product |
| `latwoodtech.com` | Factory / LWT corporate | 🔲 | 🔲 | 🔲 | |
| `latwoodtech.work` | Factory control-plane workers (`*.latwoodtech.work`) | 🔲 | 🔲 | 🔲 | core/supervisor/monitor/status/webhooks/etc. |
| `apunlimited.com` | admin-studio prod API (`api.apunlimited.com`) | 🔲 | 🔲 | 🔲 | |
| `latimerwoods.dev` | admin / QA (`api.admin.*`, `api.qa.*`) | 🔲 | 🔲 | 🔲 | |
| `capricast.com` | Capricast (apex + `api.capricast.com`) | 🔲 | 🔲 | 🔲 | |
| `cypherofhealing.com` | Cypher of Healing (apex + `api.*`) | 🔲 | 🔲 | 🔲 | ⚠️ both `cypher`/`cipher` spellings appear in registry — confirm which is canonical |
| `cipherofhealing.com` | coh alt-spelling | 🔲 | 🔲 | 🔲 | ⚠️ confirm owned + which is canonical vs redirect |
| `xicocity.com` | XicoCity (apex + `staging.*`) | 🔲 | 🔲 | 🔲 | |
| `mysticapi.com` | planned (PR #1214) | 🔲 | 🔲 | 🔲 | not yet live |
| `itsjusus.com` | 🔲 _product?_ | 🔲 | 🔲 | 🔲 | referenced in CLAUDE.md examples — confirm status |
| 🔲 `wordis-bond` domain | wordis-bond (⚠️ TCPA hold) | 🔲 | 🔲 | 🔲 | UI under regulatory hold — see FRIDGE rule 1 |

> **DNS lives at Cloudflare** for the active products (zones managed in the `adrper79` account).
> Registrar (where the domain is *bought/renewed*) may differ from DNS host — track both.

---

## 2. Trademark / IP status

| Brand / mark | Type | Status | Owner of record | Notes |
|---|---|---|---|---|
| Selfprime / "Energy Blueprint" | 🔲 wordmark | 🔲 _unregistered / filed / registered_ | 🔲 | "Energy Blueprint" is the in-product brand vocab for Human Design |
| Capricast | 🔲 | 🔲 | 🔲 | |
| Cypher of Healing / "Classic Man" | 🔲 | 🔲 | 🔲 | barber-led brand |
| XicoCity / DJMEXXICO | 🔲 | 🔲 | 🔲 | |
| Latimer-Woods-Tech | 🔲 company name | 🔲 | 🔲 | |

> Also track: logo/copyright ownership (esp. any contractor-produced art), and whether any
> brand name conflicts with an existing registered mark before spending on it.

---

## 3. ToS / Privacy Policy version per product

Each customer-facing product needs a published Terms of Service and Privacy Policy, versioned so
we know what a user agreed to and when. Ties to the privacy conformance dimension
([`PLATFORM_STANDARDS.md`](./PLATFORM_STANDARDS.md)) and per-app `PII_INVENTORY.md`.

| Product | ToS URL + version/date | Privacy Policy URL + version/date | Cookie/consent banner | DSR (export/delete) live? |
|---|---|---|---|---|
| Selfprime | 🔲 | 🔲 | 🔲 | 🔲 |
| Capricast | 🔲 | 🔲 | 🔲 | 🔲 |
| Cypher of Healing | 🔲 | 🔲 | 🔲 | 🔲 |
| XicoCity | 🔲 | 🔲 | 🔲 | 🔲 |
| Factory / admin (internal) | n/a (internal) | n/a | n/a | n/a |

---

## 4. Business entity & tax

| Item | Value |
|---|---|
| Legal entity name + type | 🔲 _(LLC / S-corp / sole prop)_ |
| State/jurisdiction of formation | 🔲 |
| EIN | 🔲 _(store the number in the password manager, not here)_ |
| Registered agent | 🔲 |
| Annual report / franchise-tax due date | 🔲 |
| Sales-tax / nexus registrations (per state) | 🔲 |
| Stripe account legal entity matches above? | 🔲 |

---

## 5. Third-party data processors (sub-processor list)

Vendors that process customer/personal data on our behalf — needed for privacy-policy disclosure
and DPA tracking. Pre-filled from the platform stack; confirm a DPA is on file for each that
touches personal data.

| Processor | What data | DPA on file? | Notes |
|---|---|---|---|
| Cloudflare | All traffic, R2 storage, D1, KV | 🔲 | Infra host for everything |
| Neon | Postgres (user/profile/booking data) | 🔲 | Primary datastore |
| Stripe | Payment + customer billing data | 🔲 | LIVE keys |
| Anthropic / Google Vertex | Prompt content (may include user inputs) | 🔲 | LLM features |
| Resend | Email addresses + message content | 🔲 | Transactional email |
| Telnyx / Deepgram / ElevenLabs | Phone numbers, call audio, voice | 🔲 | Telephony + narration |
| PostHog | Product analytics / engagement events | 🔲 | Confirm PII-minimization config |
| Sentry | Error payloads (scrub PII) | 🔲 | Confirm data-scrubbing on |
| HubSpot | Practitioner CRM contacts (planned) | 🔲 | Per GAP_REGISTER G29 (keep decision) |

---

## 6. Review log

| Date | Reviewer | What changed |
|---|---|---|
| 2026-06-01 | @adrper79-dot (drafted by Claude) | Initial skeleton; domains pre-filled from service-registry; all 🔲 pending operator input |
