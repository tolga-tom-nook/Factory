# Admin Studio — Operator Quick Reference

Daily-use cheat sheet. The full plan lives in [00-MASTER-PLAN.md](./00-MASTER-PLAN.md);
the safety design lives in [01-ENVIRONMENT-SAFETY.md](./01-ENVIRONMENT-SAFETY.md).

## URLs

| Surface          | Staging                                                 | Production                                                                       |
| ---------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| API Worker       | `https://api.admin.latimerwoods.dev`                    | `https://api.apunlimited.com`                                                    |
| UI (Pages)       | `https://staging.admin.latimerwoods.dev`                | `https://apunlimited.com`                                                        |
| workers.dev      | `https://admin-studio-staging.adrper79.workers.dev`     | `https://admin-studio-production.adrper79.workers.dev`                           |
| Health check     | `GET /health` returns `200` with `env: "staging"`       | `GET /health` returns `200` with `env: "production"`                             |

The `workers.dev` URLs are CF infrastructure fallbacks — never link to them from user-facing UI or docs (CLAUDE.md hard constraint). They exist for deploy-verify scripts and direct curl debugging only.

Always confirm env via `curl`:

```bash
curl https://api.admin.latimerwoods.dev/health
# Must return { "env": "staging", ... }

curl https://api.apunlimited.com/health
# Must return { "env": "production", ... }
```

## Confirmation tier matrix

| Env / Action          | Trivial | Reversible | Manual rollback | Irreversible |
| --------------------- | :-----: | :--------: | :-------------: | :----------: |
| **local**             |    0    |     0      |        1        |      2       |
| **staging**           |    0    |     1      |        2        |      2       |
| **production**        |    1    |     2      |        2        |      3       |

- **0** — no prompt
- **1** — click confirm
- **2** — type the action name to confirm
- **3** — two-person approval (admin + admin) within 10 minutes
- **4** — type + 30-second cooldown timer (reserved for `data.delete-all` etc.)

## Header contract

| Header             | Sent by | Purpose                                                             |
| ------------------ | ------- | ------------------------------------------------------------------- |
| `Authorization`    | UI      | `Bearer <jwt>` issued by `/auth/login`                              |
| `X-Request-Id`     | UI      | Client-generated UUID; echoed in audit log + response header        |
| `X-Confirmed`      | UI      | `true` for tier-1 actions after click-confirm                       |
| `X-Confirm-Token`  | UI      | First 16 hex of `SHA-256("${action}:${userId}:${env}")` — tier ≥ 2  |
| `X-Co-Signer-Token`| UI      | Same shape, signed by a second admin — tier 3                       |
| `X-Dry-Run`        | UI      | `true` to receive the action plan without executing                 |

## JWT claim shape

```json
{
  "iat": 1700000000,
  "exp": 1700014400,
  "iss": "factory-admin-studio",
  "sub": "user-id",
  "env": "staging",
  "app": "wordis-bond",
  "sessionId": "uuid",
  "userId": "user-id",
  "userEmail": "alice@thefactory.dev",
  "role": "admin",
  "envLockedAt": 1700000000000
}
```

The `env` claim is **non-negotiable** — every authenticated route rejects tokens whose `env` doesn't match the worker's `STUDIO_ENV` binding.

## Common operator tasks

### Run tests on demand
1. Sign in (env picker → credentials)
2. Tests tab → tick suites → **Dry-run** first to see plan
3. **Run** to dispatch via GitHub Actions
4. Watch live (Phase C) or open the GH Actions URL

### Deploy to staging
1. Tests must be green
2. Deploys tab → pick app → ref (defaults to `main`)
3. Click **Deploy** (tier 1 = single confirm in staging)
4. Verify `/health` post-deploy (workflow does this automatically)

### Deploy to production
1. Owner role required (admins cannot)
2. Type-to-confirm dialog (tier 2)
3. Do not treat production as live until `Verify health post-deploy` passes and `/health` returns `200` from the production URL
4. Tail Sentry for the next 5 minutes — abort with rollback if errors spike

### Rotate a secret
1. Generate new value locally (`openssl rand -base64 32` for JWT)
2. `wrangler secret put SECRET_NAME --env staging`  → test
3. `wrangler secret put SECRET_NAME --env production` → tier-2 confirm in CI
4. Update the rotation log in `docs/runbooks/secret-rotation.md`

## Incident response

1. Banner red? → stop. Re-read what you're about to do.
2. Worker erroring? → `curl /health`. If it's not 200, redeploy the prior version: `wrangler rollback --env <env>`.
3. Bad audit entry visible? → it's append-only by design. File a correction note; never `DELETE`.
4. Tier-3 approval stuck? Use the manual escape: `wrangler tail` + execute via `wrangler` CLI directly with explicit operator note.
