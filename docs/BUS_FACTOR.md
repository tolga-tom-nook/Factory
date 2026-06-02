# Bus-Factor & Recovery — Operator Continuity (G19)

> **Why this exists.** Latimer-Woods-Tech is a solo-operator platform. If the operator
> (@adrper79-dot) is suddenly unavailable — illness, accident, travel without access —
> a trusted person must be able to keep the lights on and recover access. This is the
> single entry point for "the operator is gone; what now?". It is a **tour + index**,
> not a replacement for the per-system runbooks it links.
>
> **Closes:** [`GAP_REGISTER.md`](./GAP_REGISTER.md) G19. **Companion:** G20 (per-product
> backup/DR — `RECOVERY.md`), G18 ([`LEGAL_OPS.md`](./LEGAL_OPS.md)).
>
> 🔲 = an operator-only fact that must be filled in by hand. Do not commit secrets here —
> store *locations/pointers*, never the credential itself.

---

## 0. First 10 minutes — if you just inherited this

1. Read §1 (what the platform is) and §2 (the critical-systems map).
2. Get into the **password manager** (🔲 _which one + where the emergency kit lives_) — this is the master key to everything else.
3. Confirm **GitHub** org access (`Latimer-Woods-Tech`) — that's where all code + automation lives.
4. Confirm **Cloudflare** account access — that's where every production service runs.
5. Check the daily **Pushover** digest / **Sentry** for active incidents (§4).
6. If something is actively down, jump to §4 (recovery procedures) — don't improvise.

---

## 1. The 60-second tour — what this platform is

A portfolio of Cloudflare-Workers-first products under the **Latimer-Woods-Tech** GitHub org,
plus a **Factory** control plane (this repo) that automates governance, deploys, and
observability across them.

**Products (priority order):**

| Product | What it is | Primary domain | Repo |
|---|---|---|---|
| **Selfprime** | Human Design / "Energy Blueprint" practitioner lead-gen network | `selfprime.net` | `Latimer-Woods-Tech/HumanDesign` |
| **Factory** | Shared infra packages + control plane + admin studio | `latwoodtech.com`, `*.latwoodtech.work` | `Latimer-Woods-Tech/Factory` (this repo) |
| **Capricast** | Automated video product | `capricast.com` | `Latimer-Woods-Tech/capricast` |
| **Cypher of Healing** | Barber-led wellness brand, booking + store | `cypherofhealing.com` | `Latimer-Woods-Tech/coh` |
| **XicoCity** | DJMEXXICO creative-economy OS | `xicocity.com` | `Latimer-Woods-Tech/xico-city` |

> Other surfaces: `apunlimited.com` (admin-studio prod API), `latimerwoods.dev` (admin/QA),
> `mysticapi.com` (planned), `wordis-bond` (⚠️ TCPA regulatory hold — see
> [`docs/supervisor/FRIDGE.md`](./supervisor/FRIDGE.md) rule 1; do not touch the UI).

**How it runs day-to-day:** a **supervisor** automation loop opens/merges PRs on green CI,
a **daily-brief** GitHub Action sends AM/PM status, and most products auto-deploy from `main`.
Authoritative "what's true right now" is [`docs/STATE.md`](./STATE.md).

---

## 2. Critical-systems map

For each system: what it holds, where the account is, and the recovery runbook. **Losing
access to the password manager or GitHub is the highest-impact failure** — start there.

| System | What dies without it | Account / identifier | Access recovery |
|---|---|---|---|
| **Password manager** | Everything (master key) | 🔲 _provider + emergency-kit location_ | 🔲 _printed recovery kit location_ |
| **GitHub** (org) | All code + all automation | `Latimer-Woods-Tech` org; owner @adrper79-dot | 🔲 _2FA backup codes location_; GitHub account-recovery |
| **Cloudflare** | Every production service (Workers/Pages/R2/D1/Stream/Hyperdrive/DNS) | account subdomain `adrper79` | 🔲 _login + 2FA recovery location_ · [`secret-rotation.md`](./runbooks/secret-rotation.md) |
| **Neon Postgres** | All product databases | org `org-withered-wave-19602339` | [`runbooks/database.md`](./runbooks/database.md) · [`reference_neon_access`] 🔲 _login_ |
| **GCP** | Secret Manager (all CI secrets via WIF) + Vertex AI LLM | project `factory-495015`, SA `factory-sa@factory-495015` | [`runbooks/rotate-gcp-sa.md`](./runbooks/rotate-gcp-sa.md) · [`runbooks/SECRET_RECOVERY.md`](./runbooks/SECRET_RECOVERY.md) |
| **Stripe** (LIVE) | All payments/payouts | 🔲 _account id_ | 🔲 _login + 2FA_ · rotate per [`secret-rotation.md`](./runbooks/secret-rotation.md) |
| **Anthropic / Vertex** | All LLM features (the "Oracle", narration, council) | key `LATIMER_ANTHROPIC_API` in GCP SM | re-key in GCP Secret Manager |
| **npm** | Package publishing (`@latimer-woods-tech/*`) | `NPM_TOKEN` (OIDC trusted publisher) | [`runbooks/npm-oidc-publishing.md`](./runbooks/npm-oidc-publishing.md) |
| **Email — Resend** | Transactional + brief delivery | 🔲 _account_ | re-key in GCP SM |
| **Voice — ElevenLabs / Telnyx / Deepgram** | Video narration + telephony | keys in GCP SM | re-key in GCP SM |
| **Analytics — PostHog** | Engagement signals (drives video pipeline) | 🔲 _project_ | [`runbooks/posthog-secrets.md`](./runbooks/posthog-secrets.md) |
| **Errors — Sentry** | Production error visibility | org 🔲 | [`runbooks/github-secrets-and-tokens.md`](./runbooks/github-secrets-and-tokens.md) |
| **Alerts — Pushover** | The daily digest + dead-man's-switch | keys `FACTORY_PUSHOVER_*` in GCP SM | re-key in GCP SM |

> **Secret topology (important):** CI secrets are **not** GitHub Actions repo secrets — they
> live in **GCP Secret Manager** (`factory-495015`) and are pulled at runtime via Workload
> Identity Federation (`scripts/fetch_gcp_secrets.sh`). So GCP access ≈ access to most keys.
> See [`runbooks/github-secrets-and-tokens.md`](./runbooks/github-secrets-and-tokens.md).

---

## 3. Where things live (quick directory)

- **What's true right now:** [`docs/STATE.md`](./STATE.md)
- **Non-negotiable operating rules:** [`docs/supervisor/FRIDGE.md`](./supervisor/FRIDGE.md)
- **Every Worker + its URL + consumers:** [`docs/service-registry.yml`](./service-registry.yml)
- **Known debt:** [`docs/GAP_REGISTER.md`](./GAP_REGISTER.md)
- **All runbooks:** [`docs/runbooks/`](./runbooks/)
- **Domains / legal / IP:** [`docs/LEGAL_OPS.md`](./LEGAL_OPS.md)

---

## 4. Recovery procedures (index — don't improvise)

| Situation | Runbook |
|---|---|
| A production service is down | [`runbooks/INCIDENT.md`](./runbooks/INCIDENT.md) · [`runbooks/incident-response-playbook.md`](./runbooks/incident-response-playbook.md) |
| A bad deploy needs rolling back | [`runbooks/DEPLOY_ROLLBACK.md`](./runbooks/DEPLOY_ROLLBACK.md) · [`runbooks/rollback-runbook.md`](./runbooks/rollback-runbook.md) |
| A secret/credential is lost or leaked | [`runbooks/SECRET_RECOVERY.md`](./runbooks/SECRET_RECOVERY.md) · [`runbooks/secret-rotation.md`](./runbooks/secret-rotation.md) |
| GCP service-account key compromised | [`runbooks/rotate-gcp-sa.md`](./runbooks/rotate-gcp-sa.md) |
| Database issue / migration recovery | [`runbooks/database.md`](./runbooks/database.md) |
| First-time environment setup | [`runbooks/getting-started.md`](./runbooks/getting-started.md) · [`runbooks/CREDENTIALS_SETUP.md`](./runbooks/CREDENTIALS_SETUP.md) |
| Handing a product to someone else | [`runbooks/transfer.md`](./runbooks/transfer.md) |
| Writing up what happened | [`runbooks/POSTMORTEM_TEMPLATE.md`](./runbooks/POSTMORTEM_TEMPLATE.md) |

---

## 5. Designated trusted contact

The person authorized to act if the operator is unavailable.

- **Name / relationship:** 🔲
- **Contact (phone + email):** 🔲
- **What they have today:** 🔲 _(e.g., emergency password-manager kit, knows where this doc is)_
- **What they are authorized to do:** 🔲 _(keep services running / rotate secrets / contact customers / nothing financial)_
- **Escalation order if unreachable:** 🔲

---

## 6. Account & credential recovery vault

Pointers only — **never the secret itself**.

- **Password manager emergency kit:** 🔲 _location (safe / sealed envelope / with trusted contact)_
- **2FA backup codes** (GitHub, Cloudflare, Stripe, GCP, Neon): 🔲 _location_
- **Domain registrar logins:** see [`LEGAL_OPS.md`](./LEGAL_OPS.md) §1 · 🔲 _recovery location_
- **Payment/payout account (Stripe) recovery:** 🔲
- **Phone/SIM** (if 2FA is SMS-based — single point of failure): 🔲 _carrier account + port-out PIN location_

---

## 7. Annual fire drill

Once a year, prove this doc actually works:

- [ ] Trusted contact follows §0 end-to-end **without the operator's help** and reports what was missing.
- [ ] Restore one product database from backup (per G20 `RECOVERY.md`) and verify it boots.
- [ ] Rotate one non-critical secret using the runbook, start to finish.
- [ ] Confirm every 🔲 in this doc is still accurate.

**Last drill:** 🔲 _date_ · **Next due:** 🔲 _date_

---

## 8. If the operator is unavailable — decision tree

```
Is something actively DOWN?
  ├─ No  → do nothing destructive. Let automation run. Watch the daily Pushover digest.
  │        Re-evaluate in 24–48h. Most things self-heal or wait.
  └─ Yes → §4 runbook for that situation.
            ├─ Recoverable from a runbook?  → follow it exactly; write a postmortem (§4).
            └─ Not recoverable / financial / legal?  → contact the trusted contact (§5)
                 and, if it concerns customers or money, pause rather than guess.
```

> Guiding principle: **a paused service is recoverable; a wrong destructive action may not be.**
> When unsure, stop and escalate.
