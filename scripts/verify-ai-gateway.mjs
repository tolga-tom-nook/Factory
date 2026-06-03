#!/usr/bin/env node
/**
 * AI Gateway preflight — fails a deploy when the Cloudflare AI Gateway named in
 * AI_GATEWAY_BASE_URL does not exist.
 *
 * Why: the `@latimer-woods-tech/llm` package routes 100% of provider calls
 * through a CF AI Gateway and has no direct-to-provider path. If the gateway
 * doesn't exist, CF returns 401 for every call and the app degrades to a
 * canned fallback SILENTLY — no error surfaces. This script turns that silent
 * runtime failure into a loud, pre-deploy red.
 *
 * It checks the AI Gateway MANAGEMENT API (not the inference path) so the result
 * is unambiguous (404 = ghost gateway) and needs no provider API key:
 *   GET /accounts/{account}/ai-gateway/gateways/{slug}
 *
 * Usage:
 *   node scripts/verify-ai-gateway.mjs --url "$AI_GATEWAY_BASE_URL"
 *
 * Env:
 *   CLOUDFLARE_API_TOKEN   (required) — token with AI Gateway read access
 *   CLOUDFLARE_ACCOUNT_ID  (optional) — falls back to the account parsed from --url
 */

process.exitCode = await main();

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.url) return fail('Missing required --url argument (the AI_GATEWAY_BASE_URL)');

  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) return fail('CLOUDFLARE_API_TOKEN is required to verify the AI Gateway');

  const parsed = parseGatewayUrl(args.url);
  if (!parsed) return fail(`Could not parse account/gateway from --url: ${args.url}`);

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || parsed.account;
  const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/gateways/${parsed.gateway}`;

  let res;
  try {
    res = await fetch(apiUrl, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return fail(`AI Gateway check request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (res.status === 200) {
    console.log(JSON.stringify({
      ok: true,
      gateway: parsed.gateway,
      account: accountId,
      checkedAt: new Date().toISOString(),
    }));
    return 0;
  }

  if (res.status === 404) {
    return fail(
      `AI Gateway "${parsed.gateway}" does not exist on account ${accountId}.\n` +
      `  Every @latimer-woods-tech/llm call routes through this gateway; a missing\n` +
      `  gateway means silent fallback (no LLM output). Fix one of:\n` +
      `    • point AI_GATEWAY_BASE_URL at an existing gateway, or\n` +
      `    • create the gateway: Cloudflare dashboard → AI Gateway → Create.`,
    );
  }

  // 403 = token lacks AI Gateway read; don't hard-fail a deploy on a perms gap
  // we can't fix here — warn and pass so a scoping issue doesn't block shipping.
  if (res.status === 403) {
    console.warn(`::warning::verify-ai-gateway: token cannot read AI Gateway (403); skipping check for "${parsed.gateway}"`);
    return 0;
  }

  const body = await res.text().catch(() => '');
  return fail(`Unexpected status ${res.status} checking AI Gateway "${parsed.gateway}": ${body.slice(0, 200)}`);
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** Parse `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}[/...]`. */
function parseGatewayUrl(raw) {
  try {
    const u = new URL(raw);
    const parts = u.pathname.split('/').filter(Boolean); // ['v1', account, gateway, ...]
    const v1 = parts.indexOf('v1');
    if (v1 === -1 || parts.length < v1 + 3) return null;
    return { account: parts[v1 + 1], gateway: parts[v1 + 2] };
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = 'true';
      }
    }
  }
  return out;
}

/** Print a GH-Actions error annotation and return exit code 1. */
function fail(message) {
  console.error(`::error::verify-ai-gateway: ${message}`);
  return 1;
}
