#!/usr/bin/env node
/**
 * gcp-harden.mjs — One-shot GCP security hardening script
 *
 * Steps:
 *   1. Create Resource Manager tag taxonomy (sensitivity: critical/service/config)
 *   2. Create claude-code-agent-readonly SA with per-secret IAM bindings
 *   3. Set up Cloud Monitoring audit alerts (Slack webhook)
 *   4. Strip roles/editor from claude-code-agent (requires Owner token — see NOTE)
 *   5. Rotate the current SA key
 *
 * Run: node scripts/gcp-harden.mjs [--step=N] [--dry-run]
 */

import { createSign } from 'node:crypto';

const PROJECT = 'factory-495015';
const SM_BASE = `https://secretmanager.googleapis.com/v1/projects/${PROJECT}`;
const IAM_BASE = `https://iam.googleapis.com/v1/projects/${PROJECT}`;
const CRM_BASE = `https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}`;
const CRM_V3 = `https://cloudresourcemanager.googleapis.com/v3`;
const MON_BASE = `https://monitoring.googleapis.com/v3/projects/${PROJECT}`;
const LOG_BASE = `https://logging.googleapis.com/v2/projects/${PROJECT}`;
const TOKEN_URI = 'https://oauth2.googleapis.com/token';

const AGENT_SA = `claude-code-agent@${PROJECT}.iam.gserviceaccount.com`;
const READONLY_SA = `claude-code-agent-readonly@${PROJECT}.iam.gserviceaccount.com`;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const STEP_ARG = args.find(a => a.startsWith('--step='));
const ONLY_STEP = STEP_ARG ? parseInt(STEP_ARG.split('=')[1]) : null;

function log(msg) { console.log(msg); }
function step(n, msg) {
  if (ONLY_STEP && ONLY_STEP !== n) return false;
  log(`\n${'═'.repeat(60)}\nStep ${n}: ${msg}\n${'═'.repeat(60)}`);
  return true;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function getAccessToken(keyEnvVar = 'GCP_SA_KEY') {
  const raw = process.env[keyEnvVar];
  if (!raw) throw new Error(`${keyEnvVar} env var is not set`);
  const candidate = raw.trim().startsWith('{') ? raw : `{${raw}}`;
  const key = JSON.parse(candidate);
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: TOKEN_URI, iat: now, exp: now + 3600,
  }));
  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = base64url(sign.sign(key.private_key));
  const jwt = `${header}.${payload}.${sig}`;
  const res = await fetch(TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!res.ok) throw new Error(`Token exchange failed ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function apiFetch(token, url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${opts.method ?? 'GET'} ${url} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// SM set helper
async function smSet(token, name, value) {
  const cr = await fetch(`${SM_BASE}/secrets?secretId=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replication: { automatic: {} } }),
  });
  if (!cr.ok) { const t = await cr.text(); if (!t.includes('ALREADY_EXISTS') && !t.includes('409')) throw new Error(t); }
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  const ar = await fetch(`${SM_BASE}/secrets/${encodeURIComponent(name)}:addVersion`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: { data: encoded } }),
  });
  if (!ar.ok) throw new Error(`AddVersion failed: ${await ar.text()}`);
}

// ---------------------------------------------------------------------------
// Step 1: Resource Manager tag taxonomy
// ---------------------------------------------------------------------------

async function createTagTaxonomy(token) {
  if (!step(1, 'Create Resource Manager tag taxonomy')) return;

  log('Creating tag key: factory-495015/sensitivity...');
  let tagKeyName;
  try {
    const res = await apiFetch(token, `${CRM_V3}/tagKeys`, {
      method: 'POST',
      body: JSON.stringify({
        parent: `projects/${PROJECT}`,
        shortName: 'sensitivity',
        description: 'Secret sensitivity tier: critical | service | config',
      }),
    });
    if (res?.name?.startsWith('operations/')) {
      let op = res;
      for (let i = 0; i < 10 && !op.done; i++) {
        await new Promise(r => setTimeout(r, 2000));
        op = await apiFetch(token, `https://cloudresourcemanager.googleapis.com/v3/${op.name}`);
      }
      tagKeyName = op.response?.name;
    } else {
      tagKeyName = res?.name;
    }
    log(`  ✅ Tag key: ${tagKeyName}`);
  } catch (err) {
    if (err.message.includes('ALREADY_EXISTS') || err.message.includes('409')) {
      log('  ⚠️  Tag key already exists, fetching...');
      const list = await apiFetch(token, `${CRM_V3}/tagKeys?parent=projects%2F${PROJECT}`);
      tagKeyName = list?.tagKeys?.find(k => k.shortName === 'sensitivity')?.name;
      log(`  ℹ️  Using: ${tagKeyName}`);
    } else throw err;
  }

  for (const value of ['critical', 'service', 'config']) {
    try {
      const res = await apiFetch(token, `${CRM_V3}/tagValues`, {
        method: 'POST',
        body: JSON.stringify({ parent: tagKeyName, shortName: value }),
      });
      if (res?.name?.startsWith('operations/')) {
        let op = res;
        for (let i = 0; i < 10 && !op.done; i++) {
          await new Promise(r => setTimeout(r, 2000));
          op = await apiFetch(token, `https://cloudresourcemanager.googleapis.com/v3/${op.name}`);
        }
        log(`  ✅ Tag value '${value}': ${op.response?.name}`);
      } else {
        log(`  ✅ Tag value '${value}': ${res?.name}`);
      }
    } catch (err) {
      if (err.message.includes('ALREADY_EXISTS') || err.message.includes('409')) {
        log(`  ⚠️  Tag value '${value}' already exists`);
      } else throw err;
    }
  }
  log('\n✅ Step 1 complete');
}

// ---------------------------------------------------------------------------
// Step 2: Create claude-code-agent-readonly SA + per-secret IAM
// ---------------------------------------------------------------------------

async function createReadonlySA(token, iamToken) {
  if (!step(2, 'Create claude-code-agent-readonly SA + per-secret IAM')) return;
  // iamToken is an Owner-level OAuth token for setIamPolicy calls (requires elevated perms)

  // Create SA
  log(`Creating SA: ${READONLY_SA}...`);
  try {
    const res = await apiFetch(token, `${IAM_BASE}/serviceAccounts`, {
      method: 'POST',
      body: JSON.stringify({
        accountId: 'claude-code-agent-readonly',
        serviceAccount: {
          displayName: 'Claude Code Agent (readonly — session default)',
          description: 'Restricted SA. Per-secret IAM grants access to service+config tier only.',
        },
      }),
    });
    log(`  ✅ Created: ${res?.email}`);
  } catch (err) {
    if (err.message.includes('ALREADY_EXISTS') || err.message.includes('409')) {
      log(`  ⚠️  SA already exists, continuing...`);
    } else throw err;
  }

  // Grant per-secret secretAccessor on every service+config tier secret.
  // roles/editor includes secretmanager.secrets.setIamPolicy so this works
  // without project-level IAM admin.
  log('\nGranting per-secret access on service+config secrets...');
  const readonlyMember = `serviceAccount:${READONLY_SA}`;

  let pageToken;
  const secretsToGrant = [];
  do {
    const qs = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : '';
    const data = await apiFetch(token, `${SM_BASE}/secrets${qs}`);
    for (const s of data?.secrets ?? []) {
      const tier = s.labels?.tier;
      if (tier === 'service' || tier === 'config') {
        secretsToGrant.push(s.name.split('/').pop());
      }
    }
    pageToken = data?.nextPageToken;
  } while (pageToken);

  log(`  ${secretsToGrant.length} service+config secrets to grant access on`);

  let granted = 0, failed = 0;
  for (const name of secretsToGrant) {
    try {
      const pol = await apiFetch(token, `${SM_BASE}/secrets/${encodeURIComponent(name)}:getIamPolicy`);
      const bindings = pol?.bindings ?? [];
      const existing = bindings.find(b => b.role === 'roles/secretmanager.secretAccessor');
      if (existing) {
        if (!existing.members.includes(readonlyMember)) existing.members.push(readonlyMember);
      } else {
        bindings.push({ role: 'roles/secretmanager.secretAccessor', members: [readonlyMember] });
      }
      if (!DRY_RUN) {
        const iamCallToken = iamToken ?? token;
        await apiFetch(iamCallToken, `${SM_BASE}/secrets/${encodeURIComponent(name)}:setIamPolicy`, {
          method: 'POST',
          body: JSON.stringify({ policy: { bindings, version: 1 } }),
        });
      }
      granted++;
      if (granted % 20 === 0) log(`  ... ${granted}/${secretsToGrant.length}`);
    } catch (err) {
      log(`  ⚠️  ${name}: ${err.message.slice(0, 80)}`);
      failed++;
    }
  }
  log(`  ✅ Granted access on ${granted} secrets (${failed} errors)`);

  // Generate SA key
  log('\nGenerating SA key for readonly SA...');
  if (!DRY_RUN) {
    const keyRes = await apiFetch(token, `${IAM_BASE}/serviceAccounts/${READONLY_SA}/keys`, {
      method: 'POST',
      body: JSON.stringify({ privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE', keyAlgorithm: 'KEY_ALG_RSA_2048' }),
    });
    const keyJson = Buffer.from(keyRes.privateKeyData, 'base64').toString('utf8');
    const keyObj = JSON.parse(keyJson);
    log(`  ✅ Key ID: ${keyObj.private_key_id}`);

    // Save current admin key before overwriting GCP_SA_KEY
    log('Storing current admin SA key as GCP_SA_KEY_ADMIN...');
    const adminRaw = process.env.GCP_SA_KEY;
    const adminJson = adminRaw.trim().startsWith('{') ? adminRaw : `{${adminRaw}}`;
    await smSet(token, 'GCP_SA_KEY_ADMIN', adminJson);
    log('  ✅ GCP_SA_KEY_ADMIN stored');

    log('Replacing GCP_SA_KEY with readonly SA key...');
    await smSet(token, 'GCP_SA_KEY', keyJson);
    log('  ✅ GCP_SA_KEY → restricted readonly SA');

    log('\n' + '─'.repeat(60));
    log('ACTION REQUIRED: Update your Claude Code environment config');
    log('Set GCP_SA_KEY to this restricted readonly key:');
    log('─'.repeat(60));
    log(keyJson);
    log('─'.repeat(60) + '\n');
  } else {
    log('  [DRY-RUN] Would generate key');
  }

  log('\n  NOTE on project-level IAM changes (Steps 4 / roles/editor removal):');
  log('  roles/editor does NOT include resourcemanager.projects.setIamPolicy.');
  log('  To remove editor and add specific roles, run in GCP Console:');
  log(`  → https://console.cloud.google.com/iam-admin/iam?project=${PROJECT}`);
  log('  Or provide a new Owner-level OAuth token and run: node scripts/gcp-harden.mjs --step=4 --oauth=<token>');

  log('\n✅ Step 2 complete');
}

// ---------------------------------------------------------------------------
// Step 3: Cloud Monitoring audit alerts
// ---------------------------------------------------------------------------

async function createAuditAlerts(token) {
  if (!step(3, 'Create Cloud Audit Log alerts')) return;

  // Get Slack webhook
  const whRes = await fetch(`${SM_BASE}/secrets/SLACK_WEBHOOK_OPS/versions/latest:access`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!whRes.ok) throw new Error('Cannot read SLACK_WEBHOOK_OPS');
  const whData = await whRes.json();
  const slackWebhook = Buffer.from(whData.payload.data, 'base64').toString('utf8').trim();
  log('  ✅ Got SLACK_WEBHOOK_OPS');

  // Create notification channel
  log('Creating Slack notification channel...');
  let channelName = null;
  try {
    const chan = await apiFetch(token, `${MON_BASE}/notificationChannels`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'webhook_tokenauth',
        displayName: 'GCP Security Alerts → #ops',
        labels: { url: slackWebhook },
      }),
    });
    channelName = chan?.name;
    log(`  ✅ Channel: ${channelName}`);
  } catch (err) {
    log(`  ⚠️  Notification channel: ${err.message.slice(0, 120)}`);
    log('  Continuing — channels can be wired in GCP Console.');
  }

  // Log-based metric: all agent SA AccessSecretVersion calls
  log('\nCreating log-based metric...');
  try {
    await apiFetch(token, `${LOG_BASE}/metrics`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'secret_manager_agent_access',
        description: 'Counts Secret Manager AccessSecretVersion calls by claude-code-agent SAs',
        filter: [
          'protoPayload.methodName="google.cloud.secretmanager.v1.SecretManagerService.AccessSecretVersion"',
          `protoPayload.authenticationInfo.principalEmail=~"claude-code-agent.*@${PROJECT}.iam.gserviceaccount.com"`,
        ].join('\n'),
        metricDescriptor: { metricKind: 'DELTA', valueType: 'INT64', unit: '1' },
      }),
    });
    log('  ✅ Log metric: secret_manager_agent_access');
  } catch (err) {
    if (err.message.includes('ALREADY_EXISTS')) {
      log('  ⚠️  Metric already exists');
    } else {
      log(`  ⚠️  Metric: ${err.message.slice(0, 120)}`);
    }
  }

  // Alert policy: >30 reads in 5 min = exfiltration pattern
  log('\nCreating alert policy (bulk read anomaly)...');
  try {
    const pol = await apiFetch(token, `${MON_BASE}/alertPolicies`, {
      method: 'POST',
      body: JSON.stringify({
        displayName: '[SECURITY] Agent SA bulk secret read — possible exfiltration',
        combiner: 'OR',
        conditions: [{
          displayName: '>30 secret reads in 5 min by agent SA',
          conditionThreshold: {
            filter: 'metric.type="logging.googleapis.com/user/secret_manager_agent_access" resource.type="global"',
            comparison: 'COMPARISON_GT',
            thresholdValue: 30,
            duration: '0s',
            aggregations: [{ alignmentPeriod: '300s', perSeriesAligner: 'ALIGN_DELTA' }],
          },
        }],
        notificationChannels: channelName ? [channelName] : [],
        documentation: {
          content: 'Agent SA read >30 secrets in 5 min. Check audit logs: https://console.cloud.google.com/logs/query',
          mimeType: 'text/markdown',
        },
        alertStrategy: { notificationRateLimit: { period: '300s' } },
      }),
    });
    log(`  ✅ Alert policy: ${pol?.name}`);
  } catch (err) {
    log(`  ⚠️  Alert policy: ${err.message.slice(0, 120)}`);
  }

  log('\n✅ Step 3 complete');
}

// ---------------------------------------------------------------------------
// Step 4: Strip roles/editor (requires Owner token — skipped if not provided)
// ---------------------------------------------------------------------------

async function hardenAgentSARoles(token) {
  if (!step(4, 'Strip roles/editor from claude-code-agent SA')) return;

  const oauthToken = OAUTH_TOKEN;

  if (!oauthToken) {
    log('  SKIPPED — roles/editor removal requires resourcemanager.projects.setIamPolicy');
    log('  which is not included in roles/editor (only roles/owner has this).');
    log('\n  To complete this step:');
    log('  1. Go to GCP Console → IAM → find claude-code-agent@factory-495015.iam.gserviceaccount.com');
    log('  2. Remove: roles/editor');
    log('  3. Add:    roles/secretmanager.secretAccessor');
    log('             roles/secretmanager.secretVersionAdder');
    log('             roles/secretmanager.viewer');
    log('             roles/iam.serviceAccountAdmin');
    log('             roles/resourcemanager.tagAdmin');
    log('             roles/monitoring.admin');
    log('             roles/logging.admin');
    log(`  URL: https://console.cloud.google.com/iam-admin/iam?project=${PROJECT}`);
    log('\n  Or provide an Owner OAuth token:');
    log('  node scripts/gcp-harden.mjs --step=4 --oauth=ya29...');
    return;
  }

  // Use the provided OAuth token for project IAM operations
  log('Using provided OAuth token for project IAM update...');
  const policy = await apiFetch(oauthToken, `${CRM_BASE}:getIamPolicy`, {
    method: 'POST',
    body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }),
  });
  policy.version = 3;

  const agentMember = `serviceAccount:${AGENT_SA}`;
  const rolesToAdd = [
    'roles/secretmanager.secretAccessor',
    'roles/secretmanager.secretVersionAdder',
    'roles/secretmanager.viewer',
    'roles/iam.serviceAccountAdmin',
    'roles/resourcemanager.tagAdmin',
    'roles/monitoring.admin',
    'roles/logging.admin',
  ];

  for (const binding of policy.bindings ?? []) {
    if (binding.role === 'roles/editor') {
      const before = binding.members.length;
      binding.members = binding.members.filter(m => m !== agentMember);
      if (binding.members.length < before) log(`  Removed from roles/editor`);
    }
  }

  for (const role of rolesToAdd) {
    const existing = policy.bindings.find(b => b.role === role && !b.condition);
    if (existing) {
      if (!existing.members.includes(agentMember)) { existing.members.push(agentMember); log(`  + ${role}`); }
      else log(`  already has ${role}`);
    } else {
      policy.bindings.push({ role, members: [agentMember] });
      log(`  + ${role} (new binding)`);
    }
  }

  if (!DRY_RUN) {
    await apiFetch(oauthToken, `${CRM_BASE}:setIamPolicy`, {
      method: 'POST',
      body: JSON.stringify({ policy }),
    });
    log('  ✅ IAM updated — roles/editor removed');
  } else {
    log('  [DRY-RUN] Would update project IAM');
  }
  log('\n✅ Step 4 complete');
}

// ---------------------------------------------------------------------------
// Step 5: Rotate claude-code-agent SA key
// ---------------------------------------------------------------------------

async function rotateAgentSAKey(token) {
  if (!step(5, 'Rotate claude-code-agent SA key')) return;

  log('Generating new SA key...');
  if (!DRY_RUN) {
    const keyRes = await apiFetch(token, `${IAM_BASE}/serviceAccounts/${AGENT_SA}/keys`, {
      method: 'POST',
      body: JSON.stringify({ privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE', keyAlgorithm: 'KEY_ALG_RSA_2048' }),
    });
    const newKeyJson = Buffer.from(keyRes.privateKeyData, 'base64').toString('utf8');
    const newKeyObj = JSON.parse(newKeyJson);
    log(`  ✅ New key ID: ${newKeyObj.private_key_id}`);

    await smSet(token, 'GCP_SA_KEY_ADMIN', newKeyJson);
    log('  ✅ Stored as GCP_SA_KEY_ADMIN');

    log('\n' + '─'.repeat(60));
    log('NEW ADMIN SA KEY — store in a safe place, use for provisioning only:');
    log('─'.repeat(60));
    log(newKeyJson);
    log('─'.repeat(60));
    log('\nOLD KEY TO DISABLE:');
    log(`  SA:     ${AGENT_SA}`);
    log(`  Key ID: ac09038c8f15826a800642d60087975a7990ca3d`);
    log(`  URL:    https://console.cloud.google.com/iam-admin/serviceaccounts/details/${AGENT_SA}/keys?project=${PROJECT}`);
  } else {
    log('  [DRY-RUN] Would generate new key');
  }
  log('\n✅ Step 5 complete');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

log(DRY_RUN ? '🔍 DRY-RUN mode\n' : '🔐 GCP Security Hardening\n');
const token = await getAccessToken();
log(`✅ Auth OK (${AGENT_SA})\n`);

// OAuth token (Owner-level) for operations that require elevated IAM permissions
const OAUTH_ARG = args.find(a => a.startsWith('--oauth='));
const OAUTH_TOKEN = OAUTH_ARG ? OAUTH_ARG.split('=').slice(1).join('=') : null;
if (OAUTH_TOKEN) log('✅ Owner OAuth token provided — elevated IAM operations enabled\n');

await createTagTaxonomy(OAUTH_TOKEN ?? token);
await createReadonlySA(token, OAUTH_TOKEN);
await createAuditAlerts(token);
await hardenAgentSARoles(token);
await rotateAgentSAKey(token);

log('\n' + '═'.repeat(60));
log('✅ Hardening complete');
log('═'.repeat(60));
log('\nRemaining manual actions:');
log('1. Update GCP_SA_KEY in Claude Code env config → use the readonly key printed in Step 2');
log('2. Remove roles/editor in GCP Console (Step 4 above has the URL)');
log('3. Disable old key ac09038c8f15826a800642d60087975a7990ca3d in GCP Console');
log('4. Verify: GCP_SA_KEY readonly key cannot read STRIPE_SECRET_KEY');
