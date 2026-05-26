#!/usr/bin/env node
/**
 * gcp-token.mjs — exchange GCP_SA_KEY (base64 service-account JSON) for a
 * short-lived OAuth2 access token and print it to stdout.
 *
 * Usage:
 *   TOKEN=$(node scripts/gcp-token.mjs)
 *   curl -H "Authorization: Bearer $TOKEN" https://secretmanager.googleapis.com/...
 *
 * Requires: Node.js ≥ 18 (built-in fetch + crypto).
 * GCP_SA_KEY must be set to the base64-encoded contents of a service-account
 * JSON key file created for the factory-sa@factory-495015.iam.gserviceaccount.com
 * principal (or any SA with roles/secretmanager.secretAccessor).
 */
import { createSign } from 'node:crypto';

const rawKey = process.env.GCP_SA_KEY;
if (!rawKey) {
  process.stderr.write('gcp-token: GCP_SA_KEY is not set\n');
  process.exit(1);
}

/**
 * Parse the service-account key, tolerating the formats seen in practice:
 *   1. base64-encoded JSON (the documented format)
 *   2. raw JSON pasted directly into the env var
 *   3. raw JSON whose wrapping `{ }` braces were stripped by an env-var
 *      input field (observed on code.claude.com) — re-wrap and retry
 * A candidate is only accepted if it has the client_email + private_key
 * fields, so a coincidental JSON parse of garbage is rejected.
 */
function parseServiceAccount(value) {
  const candidates = [
    () => Buffer.from(value, 'base64').toString('utf8'),
    () => value,
    () => `{${value.trim().replace(/,\s*$/, '')}}`,
  ];
  for (const build of candidates) {
    try {
      const obj = JSON.parse(build());
      if (obj && obj.client_email && obj.private_key) return obj;
    } catch { /* try the next candidate */ }
  }
  return null;
}

const sa = parseServiceAccount(rawKey);
if (!sa) {
  process.stderr.write('gcp-token: GCP_SA_KEY could not be parsed as base64-encoded or raw service-account JSON\n');
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
const payload = Buffer.from(JSON.stringify({
  iss:   sa.client_email,
  scope: 'https://www.googleapis.com/auth/cloud-platform',
  aud:   'https://oauth2.googleapis.com/token',
  iat:   now,
  exp:   now + 3600,
})).toString('base64url');

const signer = createSign('RSA-SHA256');
signer.update(`${header}.${payload}`);
const sig = signer.sign(sa.private_key, 'base64url');
const jwt = `${header}.${payload}.${sig}`;

const res = await fetch('https://oauth2.googleapis.com/token', {
  method:  'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body:    new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion:  jwt,
  }),
});

const data = await res.json();
if (!data.access_token) {
  process.stderr.write(`gcp-token: token exchange failed — ${JSON.stringify(data)}\n`);
  process.exit(1);
}

process.stdout.write(data.access_token);
