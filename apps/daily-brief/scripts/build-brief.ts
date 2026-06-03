#!/usr/bin/env tsx
/**
 * Daily Brief build script — runs in GitHub Actions (Node.js, no time limit).
 *
 * Usage:
 *   npx tsx scripts/build-brief.ts --slot morning --date 2026-06-01
 *
 * Required env vars (sourced from GCP Secret Manager by the workflow):
 *   ANTHROPIC_API_KEY, GROQ_API_KEY, GROK_API_KEY, VERTEX_ACCESS_TOKEN,
 *   VERTEX_PROJECT, VERTEX_LOCATION, AI_GATEWAY_BASE_URL,
 *   ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID,
 *   GITHUB_TOKEN, GITHUB_ORG,
 *   STRIPE_SECRET_KEY (optional), POSTHOG_API_KEY, POSTHOG_PROJECT_ID (optional),
 *   SENTRY_AUTH_TOKEN, SENTRY_ORG (optional),
 *   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, R2_BUCKET_NAME,
 *   PUBLIC_BASE_URL
 *
 * Writes to R2:
 *   briefs/{date}-{slot}.html
 *   briefs/{date}-{slot}-narration.mp3
 *   briefs/{date}-{slot}-meta.json
 */

import { parseArgs } from 'node:util';
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fetchWeather } from '../src/sections/weather.js';
import { fetchNewsSection } from '../src/sections/news.js';
import { fetchGitHubActivity } from '../src/sections/github.js';
import { fetchWorkerHealth } from '../src/sections/health.js';
import { fetchWisdomSection } from '../src/sections/wisdom.js';
import { fetchStripeMrr } from '../src/sections/stripe.js';
import { fetchPostHogSnapshot } from '../src/sections/posthog.js';
import { fetchSentryErrors } from '../src/sections/sentry.js';
import { generateInsights } from '../src/sections/insights.js';
import { buildEmailHtml } from '../src/render/email.js';
import type { BriefSlot, LlmEnv } from '../src/sections/insights.js';
import type { BriefMeta } from '../src/brief.js';

// ─── Args ────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    slot: { type: 'string' },
    date: { type: 'string' },
  },
});

const slot = (values.slot ?? 'morning') as BriefSlot;
const dateKey = values.date ?? new Date().toISOString().slice(0, 10);

if (slot !== 'morning' && slot !== 'evening') {
  console.error('--slot must be morning or evening');
  process.exit(1);
}

console.log(`[build-brief] slot=${slot} date=${dateKey}`);

// ─── Env helpers ─────────────────────────────────────────────────────────────

function required(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
  return v;
}
function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

const llmEnv: LlmEnv = {
  AI_GATEWAY_BASE_URL: optional('AI_GATEWAY_BASE_URL') ?? '',
  ANTHROPIC_API_KEY:   required('ANTHROPIC_API_KEY'),
  GROQ_API_KEY:        required('GROQ_API_KEY'),
  GROK_API_KEY:        optional('GROK_API_KEY'),
  VERTEX_ACCESS_TOKEN: required('VERTEX_ACCESS_TOKEN'),
  VERTEX_PROJECT:      required('VERTEX_PROJECT'),
  VERTEX_LOCATION:     required('VERTEX_LOCATION'),
};

const publicBaseUrl = required('PUBLIC_BASE_URL').replace(/\/$/, '');
const r2Bucket      = required('R2_BUCKET_NAME');
const dateLabel     = new Date(dateKey + 'T12:00:00-04:00').toLocaleDateString('en-US', {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York',
});

// ─── R2 upload via wrangler CLI ───────────────────────────────────────────────

function r2Put(key: string, filePath: string, contentType: string): void {
  execSync(
    `npx wrangler r2 object put "${r2Bucket}/${key}" --file "${filePath}" --content-type "${contentType}" --remote`,
    { stdio: 'inherit' },
  );
}

function r2PutString(key: string, content: string, contentType: string): void {
  const tmp = join(tmpdir(), `brief-${Date.now()}.tmp`);
  writeFileSync(tmp, content, 'utf-8');
  try { r2Put(key, tmp, contentType); } finally { unlinkSync(tmp); }
}

// ─── Data fetch ───────────────────────────────────────────────────────────────

console.log('[build-brief] fetching data sources...');

const [weather, news, activity, health, wisdom, stripeMrr, postHog, sentry] = await Promise.allSettled([
  fetchWeather(),
  fetchNewsSection(),
  fetchGitHubActivity(required('GITHUB_TOKEN'), required('GITHUB_ORG')),
  fetchWorkerHealth(),
  fetchWisdomSection(llmEnv),
  optional('STRIPE_SECRET_KEY')
    ? fetchStripeMrr(optional('STRIPE_SECRET_KEY')!)
    : Promise.reject('Stripe not configured'),
  optional('POSTHOG_API_KEY') && optional('POSTHOG_PROJECT_ID')
    ? fetchPostHogSnapshot(optional('POSTHOG_API_KEY')!, optional('POSTHOG_PROJECT_ID')!)
    : Promise.reject('PostHog not configured'),
  optional('SENTRY_AUTH_TOKEN') && optional('SENTRY_ORG')
    ? fetchSentryErrors(optional('SENTRY_AUTH_TOKEN')!, optional('SENTRY_ORG')!)
    : Promise.reject('Sentry not configured'),
]);

for (const [name, result] of Object.entries({ weather, news, activity, health, wisdom })) {
  if ((result as PromiseSettledResult<unknown>).status === 'rejected') {
    console.warn(`[build-brief] section "${name}" failed:`, (result as PromiseRejectedResult).reason);
  }
}

const safeWeather   = weather.status   === 'fulfilled' ? weather.value   : null;
const safeNews      = news.status      === 'fulfilled' ? news.value      : null;
const safeActivity  = activity.status  === 'fulfilled' ? activity.value  : null;
const safeHealth    = health.status    === 'fulfilled' ? health.value    : null;
const safeWisdom    = wisdom.status    === 'fulfilled' ? wisdom.value    : null;
const safeStripeMrr = stripeMrr.status === 'fulfilled' ? stripeMrr.value : null;
const safePostHog   = postHog.status   === 'fulfilled' ? postHog.value   : null;
const safeSentry    = sentry.status    === 'fulfilled' ? sentry.value    : null;

const failures = {
  weather: weather.status === 'rejected',
  news:    news.status    === 'rejected',
  github:  activity.status === 'rejected',
  health:  health.status  === 'rejected',
};

// ─── Two-pass LLM ─────────────────────────────────────────────────────────────

console.log('[build-brief] running Opus analysis + Sonnet narration...');

const insights = await generateInsights({
  slot,
  weather: safeWeather,
  news: safeNews,
  activity: safeActivity,
  health: safeHealth,
  stripeMrr: safeStripeMrr,
  postHog: safePostHog,
  sentry: safeSentry,
  env: llmEnv,
  dateLabel,
});

// ─── TTS ─────────────────────────────────────────────────────────────────────

console.log('[build-brief] synthesizing narration audio...');

const audioKey = `briefs/${dateKey}-${slot}-narration.mp3`;
const audioUrl = `${publicBaseUrl}/audio/${dateKey}-${slot}.mp3`;
let ttsSucceeded = false;

try {
  const ttsRes = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + required('ELEVENLABS_VOICE_ID'), {
    method: 'POST',
    headers: {
      'xi-api-key': required('ELEVENLABS_API_KEY'),
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text: insights.narration.slice(0, 4400),
      model_id: 'eleven_turbo_v2_5',
      voice_settings: { stability: 0.55, similarity_boost: 0.75 },
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!ttsRes.ok) throw new Error(`ElevenLabs ${ttsRes.status}`);

  const audioTmp = join(tmpdir(), `brief-audio-${Date.now()}.mp3`);
  const arrayBuf = await ttsRes.arrayBuffer();
  writeFileSync(audioTmp, new Uint8Array(arrayBuf));
  r2Put(audioKey, audioTmp, 'audio/mpeg');
  unlinkSync(audioTmp);
  ttsSucceeded = true;
  console.log('[build-brief] audio uploaded:', audioKey);
} catch (err) {
  console.error('[build-brief] TTS failed (brief will still send without audio):', err);
}

// ─── HTML render ─────────────────────────────────────────────────────────────

const webViewUrl = `${publicBaseUrl}/brief/${dateKey}/${slot}`;

const html = buildEmailHtml({
  dateLabel,
  weather: safeWeather,
  news: safeNews,
  activity: safeActivity,
  health: safeHealth,
  insights,
  audioUrl: ttsSucceeded ? audioUrl : null,
  wisdom: safeWisdom,
  stripeMrr: safeStripeMrr,
  postHog: safePostHog,
  sentry: safeSentry,
  webViewUrl,
  failures,
});

const htmlKey = `briefs/${dateKey}-${slot}.html`;
r2PutString(htmlKey, html, 'text/html; charset=utf-8');
console.log('[build-brief] HTML uploaded:', htmlKey);

// ─── Metadata (read by the Worker send cron) ──────────────────────────────────

const slotLabel = slot === 'morning' ? 'Morning Brief' : 'Evening Brief';
const subjectHook = insights.winOfTheDay?.trim();
const subject = subjectHook
  ? `${slotLabel} — ${subjectHook.slice(0, 60)}${subjectHook.length > 60 ? '…' : ''}`
  : `${slotLabel} — ${dateLabel}`;

const meta: BriefMeta = {
  slot,
  dateKey,
  subject,
  textSummary: insights.textSummary,
  builtAt: new Date().toISOString(),
  audioUrl: ttsSucceeded ? audioUrl : null,
  webViewUrl,
};

const metaKey = `briefs/${dateKey}-${slot}-meta.json`;
r2PutString(metaKey, JSON.stringify(meta, null, 2), 'application/json');
console.log('[build-brief] meta uploaded:', metaKey);

console.log(`[build-brief] ✓ ${slot} brief for ${dateKey} built successfully`);
