#!/usr/bin/env node
/**
 * gcp.mjs — GCP Secret Manager helper (no gcloud required)
 *
 * Reads GCP_SA_KEY env var (service account key JSON) and calls the
 * Secret Manager REST API directly using a self-signed JWT.
 *
 * Usage:
 *   node scripts/gcp.mjs list                       — list all secret names
 *   node scripts/gcp.mjs get <name>                 — print the latest version value
 *   node scripts/gcp.mjs set <name> <val>           — create secret (if needed) + add version
 *   node scripts/gcp.mjs label <name> <tier>        — set sensitivity label (critical|service|config)
 *   node scripts/gcp.mjs label-all                  — bulk-label all 181 secrets from built-in map
 *   node scripts/gcp.mjs label-list                 — list secrets with their current labels
 */

import { createSign } from 'node:crypto';

const PROJECT = 'factory-495015';
const SM_BASE = `https://secretmanager.googleapis.com/v1/projects/${PROJECT}`;
const TOKEN_URI = 'https://oauth2.googleapis.com/token';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function base64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function getAccessToken() {
  const raw = process.env.GCP_SA_KEY;
  if (!raw) throw new Error('GCP_SA_KEY env var is not set');

  let key;
  try {
    // Tolerate keys stored without outer braces (e.g. stripped by env injection).
    const candidate = raw.trim().startsWith('{') ? raw : `{${raw}}`;
    key = JSON.parse(candidate);
  } catch {
    throw new Error('GCP_SA_KEY is not valid JSON (tried bare and brace-wrapped)');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: TOKEN_URI,
    iat: now,
    exp: now + 3600,
  }));

  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = base64url(sign.sign(key.private_key));
  const jwt = `${header}.${payload}.${sig}`;

  const res = await fetch(TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed ${res.status}: ${body}`);
  }

  const { access_token } = await res.json();
  return access_token;
}

// ---------------------------------------------------------------------------
// Secret Manager helpers
// ---------------------------------------------------------------------------

async function smFetch(token, path, opts = {}) {
  const res = await fetch(`${SM_BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SM ${opts.method ?? 'GET'} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function listSecrets(token) {
  let pageToken;
  const names = [];
  do {
    const qs = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : '';
    const data = await smFetch(token, `/secrets${qs}`);
    for (const s of data.secrets ?? []) {
      names.push(s.name.split('/').pop());
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return names;
}

async function getSecret(token, name) {
  const data = await smFetch(token, `/secrets/${name}/versions/latest:access`);
  const encoded = data.payload?.data;
  if (!encoded) return '';
  // Strip BOM if present
  const buf = Buffer.from(encoded, 'base64');
  const str = buf.toString('utf8').replace(/^﻿/, '').trimEnd();
  return str;
}

async function patchSecretLabels(token, name, labels) {
  return smFetch(token, `/secrets/${name}?updateMask=labels`, {
    method: 'PATCH',
    body: JSON.stringify({ labels }),
  });
}

async function listSecretsWithLabels(token) {
  let pageToken;
  const secrets = [];
  do {
    const qs = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : '';
    const data = await smFetch(token, `/secrets${qs}`);
    for (const s of data.secrets ?? []) {
      secrets.push({ name: s.name.split('/').pop(), labels: s.labels ?? {} });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return secrets;
}

// Canonical sensitivity tier map for all 181 secrets.
// critical = production financial/infra master keys, never readable by restricted agents
// service  = API keys agents legitimately use for dev/operations
// config   = public identifiers and non-secret configuration
const SENSITIVITY_MAP = {
  // ── critical ──────────────────────────────────────────────────────────────
  STRIPE_SECRET_KEY: 'critical',
  STRIPE_PUBLISHABLE_KEY: 'critical',
  STRIPE_WEBHOOK_SECRET: 'critical',
  DATABASE_URL: 'critical',
  NEON_CONNECT_STRING: 'critical',
  FACTORY_CONNECTION_STRING: 'critical',
  SELFPRIME_CONNECTION_STRING: 'critical',
  PRIME_SELF_CONNECTION_STRING: 'critical',
  WORDISBOND_CONNECTION_STRING: 'critical',
  'WORDIS-BOND_NEON_CONNECTION_STRING': 'critical',
  WORDIS_BOND_FACTORY_CONNECTION_STRING: 'critical',
  THECALLING_CONNECTION_STRING: 'critical',
  THE_CALLING_FACTORY_CONNECTION_STRING: 'critical',
  CYPHEROFHEALING_CONNECTION_STRING: 'critical',
  HUMAN_DESIGN_CONNECTION_STRING: 'critical',
  KAIROSCOUNCIL_CONNECTION_STRING: 'critical',
  NICHESTREAM_CONNECTION_STRING: 'critical',
  XPELEVATOR_CONNECTION_STRING: 'critical',
  MEXXICO_CITY_CONNECTION_STRING: 'critical',
  GEMINI_PRODUCTION_CONNECTION_STRING: 'critical',
  GEMINI_STAGING_CONNECTION_STRING: 'critical',
  CF_API_TOKEN: 'critical',
  CF_STREAM_TOKEN: 'critical',
  NEON_API: 'critical',
  NEON_ORGANIZATION_KEY: 'critical',
  FACTORY_GH_PAT: 'critical',
  FACTORY_APP_PRIVATE_KEY: 'critical',
  APPLE_PRIVATE_KEY: 'critical',
  VERTEX_SA_KEY: 'critical',
  ADMIN_STUDIO_RUNTIME_SA_KEY: 'critical',
  WORKLOAD_IDENTITY_PROVIDER: 'critical',
  DISCORD_BOT_TOKEN: 'critical',
  R2_ACCESS_KEY_ID: 'critical',
  R2_SECRET_ACCESS_KEY: 'critical',
  'browser-agent-r2-access-key-id': 'critical',
  'browser-agent-r2-secret-access-key': 'critical',
  JWT_SECRET: 'critical',
  CAPRICAST_STREAM_API_TOKEN: 'critical',
  CAPRICAST_BETTER_AUTH_SECRET: 'critical',
  GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON: 'critical',
  ADMIN_STUDIO_BOOTSTRAP_EMAIL: 'critical',
  ADMIN_STUDIO_BOOTSTRAP_PASSWORD: 'critical',
  PRIME_SELF_API_SECRET: 'critical',
  GOOGLE_CLIENT_SECRET: 'critical',
  FACTORY_GOOGLE_API: 'critical',
  FACTORY_GOOGLE_SECRET: 'critical',
  SELFPRIME_GOOGLE_SECRET: 'critical',
  CAPRICAST_OAUTH_SECRET: 'critical',
  YOUTUBE_CLIENT_SECRET: 'critical',
  APPLE_PRIVATE_KEY: 'critical',
  SLACK_CLIENT_SECRET: 'critical',
  SLACK_SIGNING_SECRET: 'critical',
  SLACK_VERIFICATION_TOKEN: 'critical',
  SLACK_FACTORY_CLIENT_SECRET: 'critical',
  SLACK_FACTORY_SIGNING_SECRET: 'critical',
  SLACK_FACTORY_VERIFICATION_TOKEN: 'critical',
  SLACK_SELFPRIME_CLIENT_SECRET: 'critical',
  SLACK_SELFPRIME_SIGNING_SECRET: 'critical',
  SLACK_SELFPRIME_VERIFICATION_TOKEN: 'critical',
  SELFPRIME_SIGNING_SECRET: 'critical',
  SELFPRIME_VERIFICATION_TOKEN: 'critical',
  SELFPRIME_SOCKET_TOKEN: 'critical',
  AP_GENERAL_KEY: 'critical',

  // ── service ───────────────────────────────────────────────────────────────
  ANTHROPIC_API_KEY: 'service',
  ANTHROPIC_ADMIN_KEY: 'service',
  SELFPRIME_CLAUDE_API: 'service',
  FACTORY_OPENAI_TOKEN: 'service',
  FACTORY_XAI_TOKEN: 'service',
  GROK_API_KEY: 'service',
  GROK_GENERAL_API: 'service',
  GROK_WIB_API: 'service',
  GROQ_API_KEY: 'service',
  LATIMERWOODS_GEMINI_KEY: 'service',
  VERTEX_ACCESS_TOKEN: 'service',
  ELEVENLABS_API_KEY: 'service',
  ELEVENLABS_VOICE_CYPHER: 'service',
  ELEVENLABS_VOICE_DEFAULT: 'service',
  ELEVENLABS_VOICE_PRIME_SELF: 'service',
  RESEND_API_KEY: 'service',
  LOOPS_API_KEY: 'service',
  SENTRY_AUTH_TOKEN: 'service',
  SENTRY_ORG: 'service',
  SENTRY_DSN: 'service',
  POSTHOG_API_KEY: 'service',
  POSTHOG_PROJECT_ID: 'service',
  POSTHOG_CIMD_SECRET: 'service',
  SELFPRIME_ANALYTICS_API: 'service',
  FACTORY_DEEPGRAM_API: 'service',
  MINTLIFY_API: 'service',
  HUGGINGFACE_API_TOKEN: 'service',
  NPM_TOKEN: 'service',
  NEWS_API_KEY: 'service',
  FACTORY_NEWS_API: 'service',
  BETTERSTACK_API_TOKEN: 'service',
  CHARTMOGUL_API_TOKEN: 'service',
  TELNYX_API_KEY: 'service',
  SELFPRIME_TELNYX_API: 'service',
  THECALLING_TELNYX_API: 'service',
  WIB_TELNYX_API: 'service',
  XPELEVATOR_TELNYX_API: 'service',
  NAMECHEAP_API: 'service',
  FACTORY_PUSHOVER_API: 'service',
  FACTORY_PUSHOVER_USER: 'service',
  DAILY_BRIEF_TRIGGER_TOKEN: 'service',
  WORKER_API_TOKEN: 'service',
  SLACK_WEBHOOK_OPS: 'service',
  SLACK_WEBHOOK_REVENUE: 'service',
  SLACK_WEBHOOK_DELIVERY_KPIS: 'service',
  E2E_TEST_EMAIL: 'service',
  E2E_TEST_PASSWORD: 'service',
  CAPRICAST_PUBLISH_TOKEN: 'service',
  CAPRICAST_STREAM_ACCOUNT_ID: 'service',

  // ── config ────────────────────────────────────────────────────────────────
  CF_ACCOUNT_ID: 'config',
  CF_STREAM_CUSTOMER_DOMAIN: 'config',
  NEON_ORGANIZATION_ID: 'config',
  RATE_LIMITER_CYPHER_HEALING: 'config',
  RATE_LIMITER_IJUSTUS: 'config',
  RATE_LIMITER_NEIGHBOR_AID: 'config',
  RATE_LIMITER_PRIME_SELF: 'config',
  RATE_LIMITER_THE_CALLING: 'config',
  RATE_LIMITER_WORDIS_BOND: 'config',
  HYPERDRIVE_CYPHER_HEALING: 'config',
  HYPERDRIVE_FACTORY_CORE: 'config',
  HYPERDRIVE_IJUSTUS: 'config',
  HYPERDRIVE_NEIGHBOR_AID: 'config',
  HYPERDRIVE_PRIME_SELF: 'config',
  HYPERDRIVE_THE_CALLING: 'config',
  HYPERDRIVE_WORDIS_BOND: 'config',
  HYPERDRIVE_XICO_CITY: 'config',
  FACTORY_APP_ID: 'config',
  FACTORY_APP_INSTALLATION_ID: 'config',
  FACTORY_APP_CLIENT_ID: 'config',
  SELFPRIME_APP_ID: 'config',
  SELFPRIME_CLIENT_ID: 'config',
  SLACK_APP_ID: 'config',
  SLACK_FACTORY_APP_ID: 'config',
  SLACK_SELFPRIME_APP_ID: 'config',
  SLACK_CLIENT_ID: 'config',
  SLACK_FACTORY_CLIENT_ID: 'config',
  SLACK_SELFPRIME_CLIENT_ID: 'config',
  DISCORD_APPLICATION_ID: 'config',
  DISCORD_PUBLIC_KEY: 'config',
  APPLE_CLIENT_ID: 'config',
  APPLE_TEAM_ID: 'config',
  APPLE_KEY_ID: 'config',
  YOUTUBE_CLIENT_ID: 'config',
  FACTORY_GOOGLE_CLIENT_ID: 'config',
  SELFPRIME_GOOGLE_CLIENTID: 'config',
  CAPRICAST_OAUTH_CLIENTID: 'config',
  ADMIN_STUDIO_PROD_URL: 'config',
  ADMIN_STUDIO_STAGING_URL: 'config',
  ADMIN_STUDIO_ALLOWED_USERS_JSON: 'config',
  ADMIN_STUDIO_GOOGLE_CLIENT_ID: 'config',
  SCHEDULE_WORKER_URL: 'config',
  AI_GATEWAY_URL: 'config',
  SERVICE_ACCOUNT_EMAIL: 'config',
  R2_BUCKET_NAME: 'config',
  R2_PUBLIC_DOMAIN: 'config',
  PRIME_SELF_LOGO_URL: 'config',
  CAPRICAST_SYSTEM_CREATOR_ID: 'config',
  TELNYX_PHONE_NUMBER: 'config',
  TELNYX_CONNECTION_ID: 'config',
  TELNYX_PUBLIC_KEY: 'config',
  'claude-code-agent-test': 'config',
  'test-cleanup-marker': 'config',
};

async function setSecret(token, name, value) {
  // Try to create the secret; ignore 409 (already exists).
  try {
    await smFetch(token, `/secrets?secretId=${encodeURIComponent(name)}`, {
      method: 'POST',
      body: JSON.stringify({ replication: { automatic: {} } }),
    });
  } catch (err) {
    if (!err.message.includes('409') && !err.message.includes('ALREADY_EXISTS')) throw err;
  }

  // Add a new version.
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  await smFetch(token, `/secrets/${name}:addVersion`, {
    method: 'POST',
    body: JSON.stringify({ payload: { data: encoded } }),
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [,, cmd, ...args] = process.argv;

if (!cmd || cmd === 'help') {
  console.log('Usage:');
  console.log('  node scripts/gcp.mjs list');
  console.log('  node scripts/gcp.mjs get <secret-name>');
  console.log('  node scripts/gcp.mjs set <secret-name> <value>');
  console.log('  node scripts/gcp.mjs label <secret-name> <tier>   (tier: critical|service|config)');
  console.log('  node scripts/gcp.mjs label-all                    (bulk-label from built-in map)');
  console.log('  node scripts/gcp.mjs label-list                   (list secrets with labels)');
  process.exit(0);
}

const token = await getAccessToken();

if (cmd === 'list') {
  const names = await listSecrets(token);
  if (names.length === 0) {
    console.log('(no secrets found)');
  } else {
    names.sort().forEach(n => console.log(n));
  }
} else if (cmd === 'get') {
  const [name] = args;
  if (!name) { console.error('Usage: gcp.mjs get <name>'); process.exit(1); }
  const val = await getSecret(token, name);
  process.stdout.write(val + '\n');
} else if (cmd === 'set') {
  const [name, value] = args;
  if (!name || value === undefined) { console.error('Usage: gcp.mjs set <name> <value>'); process.exit(1); }
  await setSecret(token, name, value);
  console.log(`✅ ${name} updated`);
} else if (cmd === 'label') {
  const [name, tier] = args;
  if (!name || !tier) { console.error('Usage: gcp.mjs label <name> <tier>'); process.exit(1); }
  if (!['critical', 'service', 'config'].includes(tier)) {
    console.error('tier must be: critical | service | config'); process.exit(1);
  }
  await patchSecretLabels(token, name, { tier });
  console.log(`✅ ${name} → tier:${tier}`);
} else if (cmd === 'label-all') {
  const names = await listSecrets(token);
  let ok = 0, skipped = 0, unknown = 0;
  for (const name of names) {
    const tier = SENSITIVITY_MAP[name];
    if (!tier) {
      console.warn(`⚠️  ${name}: not in sensitivity map — defaulting to 'service'`);
      await patchSecretLabels(token, name, { tier: 'service' });
      skipped++;
    } else {
      await patchSecretLabels(token, name, { tier });
      console.log(`  ${tier.padEnd(8)} ${name}`);
      ok++;
    }
  }
  console.log(`\n✅ Labelled ${ok} secrets. Defaulted ${skipped} unmapped to 'service'. ${unknown} errors.`);
} else if (cmd === 'label-list') {
  const secrets = await listSecretsWithLabels(token);
  const byTier = { critical: [], service: [], config: [], unlabeled: [] };
  for (const s of secrets) {
    const tier = s.labels.tier ?? 'unlabeled';
    (byTier[tier] ?? byTier.unlabeled).push(s.name);
  }
  for (const [tier, names] of Object.entries(byTier)) {
    if (names.length === 0) continue;
    console.log(`\n── ${tier} (${names.length}) ──`);
    names.sort().forEach(n => console.log(`  ${n}`));
  }
} else {
  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}
