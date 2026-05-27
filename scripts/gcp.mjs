#!/usr/bin/env node
/**
 * gcp.mjs — GCP Secret Manager helper (no gcloud required)
 *
 * Reads GCP_SA_KEY env var (service account key JSON) and calls the
 * Secret Manager REST API directly using a self-signed JWT.
 *
 * Usage:
 *   node scripts/gcp.mjs list              — list all secret names in the project
 *   node scripts/gcp.mjs get <name>        — print the latest version value
 *   node scripts/gcp.mjs set <name> <val>  — create secret (if needed) + add version
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

async function setSecret(token, name, value) {
  // Try to create the secret; ignore 409 (already exists).
  try {
    await smFetch(token, `/secrets?secretId=${encodeURIComponent(name)}`, {
      method: 'POST',
      body: JSON.stringify({ replication: { automatic: {} } }),
    });
  } catch (err) {
    // 409 = already exists, 403 = no create permission (secret exists, agent is accessor-only)
    if (!err.message.includes('409') && !err.message.includes('ALREADY_EXISTS') && !err.message.includes('403')) throw err;
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
} else {
  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}
