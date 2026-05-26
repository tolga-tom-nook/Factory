#!/usr/bin/env node
/**
 * Mint a short-lived GCP access token from a service-account key held in the
 * `GCP_SA_KEY` environment variable (raw JSON or base64-encoded JSON), then
 * print the bare access token to stdout.
 *
 * Usage:
 *   node scripts/gcp-token.mjs                 # cloud-platform scope
 *   GCP_SCOPE="https://www.googleapis.com/auth/devstorage.read_only" \
 *     node scripts/gcp-token.mjs
 *   curl -H "Authorization: Bearer $(node scripts/gcp-token.mjs)" ...
 *
 * Local/CI Node tool only. The secret never lives in this repo — only the
 * `GCP_SA_KEY` env var (set in the Claude Code environment config) holds it.
 */
import { createSign } from 'node:crypto';

const SCOPE = process.env.GCP_SCOPE ?? 'https://www.googleapis.com/auth/cloud-platform';

function loadKey() {
  const raw = process.env.GCP_SA_KEY;
  if (!raw) {
    console.error(
      'GCP_SA_KEY is not set. Add the claude-code-agent service-account key JSON ' +
      '(raw or base64) to your Claude Code environment configuration.',
    );
    process.exit(1);
  }
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const key = JSON.parse(text);
  if (!key.client_email || !key.private_key || !key.token_uri) {
    console.error('GCP_SA_KEY is missing client_email / private_key / token_uri.');
    process.exit(1);
  }
  return key;
}

const b64url = (input) => Buffer.from(input).toString('base64url');

async function main() {
  const key = loadKey();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    scope: SCOPE,
    aud: key.token_uri,
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claims}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(key.private_key, 'base64url');
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch(key.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!res.ok) {
    console.error(`Token exchange failed: HTTP ${res.status}\n${await res.text()}`);
    process.exit(1);
  }

  const data = await res.json();
  process.stdout.write(data.access_token);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
