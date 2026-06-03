/**
 * Cloudflare Worker for the daily-brief service.
 *
 * Responsibilities:
 *   1. Build crons (6 AM / 6 PM ET) — dispatch workflow_dispatch to GHA.
 *      All heavy work (data fetch, Opus analysis, Sonnet narration, TTS) runs
 *      in GitHub Actions with no time constraints.
 *   2. Send crons (6:30 AM / 6:30 PM ET) — read the pre-built brief from R2
 *      and send it via Resend. ~30-line operation, well within cron budget.
 *   3. HTTP routes — /health, /audio/{date}-{slot}.mp3, /brief/{date}/{slot},
 *      /brief/latest/{slot}, and /trigger for manual testing.
 *
 * Secrets (wrangler secret put):
 *   ANTHROPIC_API_KEY, GROQ_API_KEY, GROK_API_KEY, VERTEX_ACCESS_TOKEN,
 *   ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, RESEND_API_KEY, GITHUB_TOKEN,
 *   TRIGGER_TOKEN
 *
 * Vars (wrangler.jsonc):
 *   GITHUB_ORG, GITHUB_REPO, ZIP_CODE, RECIPIENTS, PUBLIC_BASE_URL,
 *   RESEND_FROM_ADDRESS, RESEND_FROM_NAME,
 *   AI_GATEWAY_BASE_URL, VERTEX_PROJECT, VERTEX_LOCATION
 */

import { dispatchBriefBuild, sendBriefForSlot, getBriefDateKey } from './brief';
import type { BriefSlot } from './sections/insights';

export interface Env {
  AUDIO_BUCKET: R2Bucket;

  // Email
  RESEND_API_KEY: string;
  RESEND_FROM_ADDRESS: string;
  RESEND_FROM_NAME: string;

  // GitHub — workflow_dispatch to render-daily-brief.yml
  GITHUB_TOKEN: string;
  GITHUB_ORG: string;
  GITHUB_REPO: string;

  // Config
  ZIP_CODE: string;
  RECIPIENTS: string;
  PUBLIC_BASE_URL?: string;

  // Manual trigger auth
  TRIGGER_TOKEN?: string;

}

// Cron strings exactly as declared in wrangler.jsonc.
const CRON_BUILD_MORNING = '0 10 * * *';
const CRON_SEND_MORNING  = '30 10 * * *';
const CRON_BUILD_EVENING = '0 22 * * *';
const CRON_SEND_EVENING  = '30 22 * * *';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', service: 'daily-brief', ts: Date.now() });
    }

    // Self-hosted audio — GET /audio/{date}-{slot}.mp3
    const audioMatch = url.pathname.match(/^\/audio\/(\d{4}-\d{2}-\d{2})-(morning|evening)\.mp3$/);
    if (audioMatch && request.method === 'GET') {
      const obj = await env.AUDIO_BUCKET.get(`briefs/${audioMatch[1]}-${audioMatch[2]}-narration.mp3`);
      if (!obj) return new Response('Not found', { status: 404 });
      return new Response(obj.body, {
        headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' },
      });
    }

    // Web view — GET /brief/{date}/{slot} or /brief/latest/{slot}
    const briefMatch = url.pathname.match(/^\/brief\/(latest|\d{4}-\d{2}-\d{2})\/(morning|evening)$/);
    if (briefMatch && request.method === 'GET') {
      const dateKey = briefMatch[1] === 'latest' ? getBriefDateKey(new Date()) : briefMatch[1];
      const obj = await env.AUDIO_BUCKET.get(`briefs/${dateKey}-${briefMatch[2]}.html`);
      if (!obj) return new Response('Brief not found', { status: 404 });
      return new Response(obj.body, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
      });
    }

    // Manual trigger — POST /trigger?slot=morning|evening
    if (url.pathname === '/trigger' && request.method === 'POST') {
      if (env.TRIGGER_TOKEN) {
        if (request.headers.get('authorization') !== `Bearer ${env.TRIGGER_TOKEN}`) {
          return Response.json({ status: 'unauthorized' }, { status: 401 });
        }
      }
      const slot = (url.searchParams.get('slot') ?? 'morning') as BriefSlot;
      if (slot !== 'morning' && slot !== 'evening') {
        return Response.json({ status: 'bad_request', message: 'slot must be morning or evening' }, { status: 400 });
      }
      ctx.waitUntil(
        dispatchBriefBuild(slot, env).catch((e) =>
          console.error('[daily-brief] trigger dispatch error:', e),
        ),
      );
      return Response.json({ status: 'dispatched', slot, message: 'Build triggered in GitHub Actions' });
    }

    // Manual send — POST /send?slot=morning|evening (bypasses cron for testing)
    if (url.pathname === '/send' && request.method === 'POST') {
      if (env.TRIGGER_TOKEN) {
        if (request.headers.get('authorization') !== `Bearer ${env.TRIGGER_TOKEN}`) {
          return Response.json({ status: 'unauthorized' }, { status: 401 });
        }
      }
      const slot = (url.searchParams.get('slot') ?? 'morning') as BriefSlot;
      if (slot !== 'morning' && slot !== 'evening') {
        return Response.json({ status: 'bad_request', message: 'slot must be morning or evening' }, { status: 400 });
      }
      ctx.waitUntil(
        sendBriefForSlot(slot, env).catch((e) =>
          console.error('[daily-brief] send error:', e),
        ),
      );
      return Response.json({ status: 'sending', slot });
    }

    return new Response('daily-brief worker', { status: 200 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const cron = controller.cron;

    if (cron === CRON_BUILD_MORNING) {
      ctx.waitUntil(dispatchBriefBuild('morning', env));
    } else if (cron === CRON_BUILD_EVENING) {
      ctx.waitUntil(dispatchBriefBuild('evening', env));
    } else if (cron === CRON_SEND_MORNING) {
      ctx.waitUntil(sendBriefForSlot('morning', env));
    } else if (cron === CRON_SEND_EVENING) {
      ctx.waitUntil(sendBriefForSlot('evening', env));
    } else {
      console.warn(`[daily-brief] unknown cron: ${cron}`);
    }
  },
} satisfies ExportedHandler<Env>;
