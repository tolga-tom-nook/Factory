#!/usr/bin/env node
/**
 * GCP Secret Manager helper — no gcloud CLI required.
 *
 * Auth priority:
 *   1. GCP_SA_KEY env var (full JSON string)
 *   2. GOOGLE_APPLICATION_CREDENTIALS env var (path to key file)
 *   3. /tmp/sa-key.json (session fallback — never commit)
 *
 * Usage as a module:
 *   import { getSecret, listSecrets, getToken } from './gcp.mjs';
 *
 * Usage as a CLI:
 *   node scripts/gcp.mjs get ANTHROPIC_API_KEY
 *   node scripts/gcp.mjs list
 */

import { createSign } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';

const PROJECT = process.env.GCP_PROJECT ?? 'factory-495015';

// ---------------------------------------------------------------------------
// Key loading
// ---------------------------------------------------------------------------

function loadKey() {
  if (process.env.GCP_SA_KEY && process.env.GCP_SA_KEY.trim().startsWith('{')) {
    try {
      return JSON.parse(process.env.GCP_SA_KEY);
    } catch {
      // fall through
    }
  }
  const filePath = process.env.GOOGLE_APPLICATION_CREDENTIALS ?? '/tmp/sa-key.json';
  if (existsSync(filePath)) {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  }
  throw new Error(
    'No GCP credentials found. Set GCP_SA_KEY env var (full JSON) or ' +
    'GOOGLE_APPLICATION_CREDENTIALS (path to key file).'
  );
}

// ---------------------------------------------------------------------------
// JWT + token exchange
// ---------------------------------------------------------------------------

function b64url(str) {
  return Buffer.from(str).toString('base64url');
}

function httpsGet(opts, body) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(opts, res => {
      let data = '';
      res.on('data', d => (data += d));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let _tokenCache = null;

export async function getToken() {
  if (_tokenCache && _tokenCache.expiresAt > Date.now() + 60_000) {
    return _tokenCache.token;
  }

  const key = loadKey();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }));

  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(key.private_key, 'base64url');
  const jwt = `${header}.${payload}.${sig}`;

  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(jwt)}`;
  const res = await httpsGet({
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);

  if (res.status !== 200 || !res.body.access_token) {
    throw new Error(`GCP token exchange failed: ${JSON.stringify(res.body)}`);
  }

  _tokenCache = { token: res.body.access_token, expiresAt: Date.now() + 3500_000 };
  return _tokenCache.token;
}

// ---------------------------------------------------------------------------
// Secret Manager API
// ---------------------------------------------------------------------------

export async function getSecret(name, project = PROJECT) {
  const token = await getToken();
  const res = await httpsGet({
    hostname: 'secretmanager.googleapis.com',
    path: `/v1/projects/${project}/secrets/${name}/versions/latest:access`,
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status !== 200) {
    throw new Error(`Secret '${name}' not found (${res.status}): ${JSON.stringify(res.body)}`);
  }
  const raw = Buffer.from(res.body.payload.data, 'base64').toString('utf8');
  // Strip UTF-8 BOM and trailing whitespace (matches fetch_gcp_secrets.sh behaviour)
  return raw.replace(/^﻿/, '').trimEnd();
}

export async function listSecrets(project = PROJECT) {
  const token = await getToken();
  const secrets = [];
  let pageToken = '';
  do {
    const qs = pageToken ? `?pageSize=100&pageToken=${pageToken}` : '?pageSize=100';
    const res = await httpsGet({
      hostname: 'secretmanager.googleapis.com',
      path: `/v1/projects/${project}/secrets${qs}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status !== 200) throw new Error(`listSecrets failed (${res.status}): ${JSON.stringify(res.body)}`);
    (res.body.secrets ?? []).forEach(s => secrets.push(s.name.split('/').pop()));
    pageToken = res.body.nextPageToken ?? '';
  } while (pageToken);
  return secrets;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const [, , cmd, ...args] = process.argv;
  if (cmd === 'list') {
    listSecrets().then(names => names.forEach(n => console.log(n))).catch(e => { console.error(e.message); process.exit(1); });
  } else if (cmd === 'get' && args[0]) {
    getSecret(args[0]).then(v => console.log(v)).catch(e => { console.error(e.message); process.exit(1); });
  } else {
    console.error('Usage: node scripts/gcp.mjs list\n       node scripts/gcp.mjs get <SECRET_NAME>');
    process.exit(1);
  }
}
