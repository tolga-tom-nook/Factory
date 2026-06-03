import { createEmailClient } from '@latimer-woods-tech/email';
import type { Env } from './index';
import type { BriefSlot } from './sections/insights';

const BRIEF_TIME_ZONE = 'America/New_York';

export type { BriefSlot };

export function getBriefDateKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BRIEF_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Metadata written to R2 by the GHA build script; read by the send cron. */
export interface BriefMeta {
  slot: BriefSlot;
  dateKey: string;
  subject: string;
  textSummary: string;
  builtAt: string;
  audioUrl: string | null;
  webViewUrl: string;
}

/**
 * Dispatch a brief build to GitHub Actions via workflow_dispatch.
 * The Worker cron calls this at 6 AM / 6 PM ET; the heavy work runs in GHA
 * with no time constraints. The send cron fires 30 minutes later.
 */
export async function dispatchBriefBuild(slot: BriefSlot, env: Env): Promise<void> {
  const dateKey = getBriefDateKey(new Date());
  const url = `https://api.github.com/repos/${env.GITHUB_ORG}/${env.GITHUB_REPO}/actions/workflows/render-daily-brief.yml/dispatches`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'daily-brief/1.0',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main', inputs: { slot, date_key: dateKey } }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub dispatch failed ${res.status}: ${body.slice(0, 200)}`);
  }

  console.log(`[daily-brief] dispatched ${slot} build for ${dateKey}`);
}

/**
 * Read the pre-built brief from R2 and send it via Resend.
 * Called by the send cron 30 minutes after the build dispatch.
 */
export async function sendBriefForSlot(slot: BriefSlot, env: Env): Promise<void> {
  const dateKey = getBriefDateKey(new Date());
  const metaKey = `briefs/${dateKey}-${slot}-meta.json`;
  const htmlKey = `briefs/${dateKey}-${slot}.html`;
  const sentKey = `briefs/${dateKey}-${slot}-sent.json`;

  // Dedup guard — never double-send the same slot.
  const alreadySent = await env.AUDIO_BUCKET.head(sentKey).catch(() => null);
  if (alreadySent !== null) {
    console.warn(`[daily-brief] ${slot} brief for ${dateKey} already sent — skipping`);
    return;
  }

  // Read metadata written by GHA build script.
  const metaObj = await env.AUDIO_BUCKET.get(metaKey);
  if (!metaObj) {
    console.error(`[daily-brief] ${slot} meta not found at ${metaKey} — GHA build may still be running`);
    return;
  }

  const meta = (await metaObj.json()) as BriefMeta;

  const htmlObj = await env.AUDIO_BUCKET.get(htmlKey);
  if (!htmlObj) {
    console.error(`[daily-brief] ${slot} HTML not found at ${htmlKey}`);
    return;
  }

  const html = await htmlObj.text();

  const recipients = env.RECIPIENTS.split(',').map((r) => r.trim()).filter(Boolean);

  const emailClient = createEmailClient({
    resendApiKey: env.RESEND_API_KEY,
    fromAddress: env.RESEND_FROM_ADDRESS,
    fromName: env.RESEND_FROM_NAME,
  });

  async function sendWithRetry(to: string): Promise<{ id: string }> {
    const opts = { to, subject: meta.subject, html, text: meta.textSummary };
    try {
      return await emailClient.sendTransactional(opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/\b4\d\d\b/.test(msg)) throw err;
      return await emailClient.sendTransactional(opts);
    }
  }

  const results = await Promise.allSettled(recipients.map(sendWithRetry));

  for (const [i, r] of results.entries()) {
    if (r.status === 'rejected') {
      const addr = recipients[i] ?? '';
      const masked = addr.includes('@') ? `***@${addr.split('@')[1]}` : `recipient[${i + 1}]`;
      console.error(`[daily-brief] send failed for ${masked}:`, r.reason);
    }
  }

  if (results.some((r) => r.status === 'fulfilled')) {
    await env.AUDIO_BUCKET.put(
      sentKey,
      JSON.stringify({ sentAt: new Date().toISOString(), recipients: recipients.length, slot }),
      { httpMetadata: { contentType: 'application/json' } },
    ).catch(() => {});
  }
}
