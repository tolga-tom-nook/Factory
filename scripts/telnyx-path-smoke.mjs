#!/usr/bin/env node

const TELNYX_API_BASE = 'https://api.telnyx.com';

const config = {
  mode: process.env.SMOKE_MODE || 'path',
  telnyxApiKey: process.env.TELNYX_API_KEY || '',
  fromNumber: process.env.TELNYX_FROM_NUMBER || '+15045204977',
  recipient: process.env.TELNYX_LIVE_TEST_TO || '',
  messagingProfileId: process.env.TELNYX_MESSAGING_PROFILE_ID || '40019cb4-6429-4a83-90ae-19c7447e85ab',
  brandId: process.env.TELNYX_10DLC_BRAND_ID || '4b20019d-e5f8-5861-84ed-4d758d66ffda',
  campaignId: process.env.TELNYX_10DLC_CAMPAIGN_ID || '4b30019e-5c75-0540-96d2-9d680f1fe344',
  tcrCampaignId: process.env.TELNYX_TCR_CAMPAIGN_ID || 'CN8R8WX',
  healthUrl: process.env.INBOUND_ORACLE_HEALTH_URL || 'https://inbound-oracle.latwoodtech.work/health',
};

function fail(message, details = {}) {
  console.error(JSON.stringify({ ok: false, message, ...details }, null, 2));
  process.exit(1);
}

function requireEnv(name, value) {
  if (!value) fail(`Missing required environment variable: ${name}`);
}

function normalizePhone(phone) {
  return String(phone || '').replace(/[^+0-9]/g, '');
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${config.telnyxApiKey}`,
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    fail(`Request failed: ${res.status} ${res.statusText}`, { url, body });
  }
  return body;
}

async function checkInboundOracleHealth() {
  const res = await fetch(config.healthUrl, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok !== true) {
    fail('Inbound oracle health check failed', { status: res.status, body });
  }
  return { service: body.service, env: body.env };
}

async function checkTelnyxNumber() {
  const url = `${TELNYX_API_BASE}/v2/phone_numbers?filter%5Bphone_number%5D=${encodeURIComponent(config.fromNumber)}&page%5Bsize%5D=5`;
  const body = await requestJson(url);
  const record = body.data?.find((item) => normalizePhone(item.phone_number) === normalizePhone(config.fromNumber));
  if (!record) fail('Telnyx sending number was not found', { fromNumber: config.fromNumber });
  if (record.status !== 'active') fail('Telnyx sending number is not active', { status: record.status });
  if (record.messaging_profile_id !== config.messagingProfileId) {
    fail('Telnyx sending number is not attached to the expected messaging profile', {
      expected: config.messagingProfileId,
      actual: record.messaging_profile_id,
    });
  }
  return { id: record.id, phoneNumber: record.phone_number, status: record.status, messagingProfileId: record.messaging_profile_id };
}

async function checkMessagingProfile() {
  const body = await requestJson(`${TELNYX_API_BASE}/v2/messaging_profiles/${config.messagingProfileId}`);
  const profile = body.data;
  if (!profile) fail('Telnyx messaging profile was not found', { messagingProfileId: config.messagingProfileId });
  if (profile.enabled !== true) fail('Telnyx messaging profile is disabled', { enabled: profile.enabled });
  return { id: profile.id, name: profile.name, enabled: profile.enabled };
}

async function checkCampaignAssignment() {
  const url = `${TELNYX_API_BASE}/10dlc/campaign?brandId=${encodeURIComponent(config.brandId)}&page%5Bsize%5D=20`;
  const body = await requestJson(url);
  const campaign = body.records?.find((item) => item.campaignId === config.campaignId || item.tcrCampaignId === config.tcrCampaignId);
  if (!campaign) fail('Expected 10DLC campaign was not found', { campaignId: config.campaignId, tcrCampaignId: config.tcrCampaignId });
  if (campaign.status !== 'ACTIVE') fail('10DLC campaign is not active', { status: campaign.status });
  if ((campaign.assignedPhoneNumbersCount || 0) < 1) {
    fail('10DLC campaign has no assigned phone numbers', { assignedPhoneNumbersCount: campaign.assignedPhoneNumbersCount });
  }
  return {
    campaignId: campaign.campaignId,
    tcrCampaignId: campaign.tcrCampaignId,
    status: campaign.status,
    assignedPhoneNumbersCount: campaign.assignedPhoneNumbersCount,
  };
}

async function runPathSmoke() {
  requireEnv('TELNYX_API_KEY', config.telnyxApiKey);
  const [health, number, profile, campaign] = await Promise.all([
    checkInboundOracleHealth(),
    checkTelnyxNumber(),
    checkMessagingProfile(),
    checkCampaignAssignment(),
  ]);
  console.log(JSON.stringify({ ok: true, mode: 'path', charged: false, health, number, profile, campaign }, null, 2));
}

async function sendLiveSms() {
  requireEnv('TELNYX_API_KEY', config.telnyxApiKey);
  requireEnv('TELNYX_LIVE_TEST_TO', config.recipient);

  const text = `Latimer Woods Telnyx smoke test ${new Date().toISOString()}. Reply STOP to opt out.`;
  const body = await requestJson(`${TELNYX_API_BASE}/v2/messages`, {
    method: 'POST',
    body: JSON.stringify({ from: config.fromNumber, to: config.recipient, text }),
  });

  const message = body.data;
  if (!message?.id) fail('Telnyx did not return a message id', { body });
  if (message.errors?.length) fail('Telnyx accepted the request with errors', { errors: message.errors });
  if (message.tcr_campaign_id !== config.tcrCampaignId) {
    fail('Live SMS was not stamped with the expected TCR campaign id', {
      expected: config.tcrCampaignId,
      actual: message.tcr_campaign_id,
    });
  }

  const deadline = Date.now() + 120_000;
  let lastRecord = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    const records = await requestJson(`${TELNYX_API_BASE}/v2/detail_records?filter%5Brecord_type%5D=messaging&filter%5Bdate_range%5D=today&filter%5Bdirection%5D=outbound&page%5Bsize%5D=50`);
    lastRecord = records.data?.find((record) => record.id === message.id) || lastRecord;
    if (!lastRecord) continue;
    if (lastRecord.status === 'delivered') {
      console.log(JSON.stringify({
        ok: true,
        mode: 'live-sms',
        charged: true,
        messageId: message.id,
        status: lastRecord.status,
        cost: lastRecord.cost,
        errors: lastRecord.errors || [],
        tcrCampaignId: lastRecord.tcr_campaign_id,
      }, null, 2));
      return;
    }
    if (lastRecord.status === 'failed') {
      fail('Live SMS failed', { messageId: message.id, record: lastRecord });
    }
  }

  fail('Timed out waiting for live SMS delivery record', { messageId: message.id, lastRecord });
}

if (config.mode === 'path') {
  await runPathSmoke();
} else if (config.mode === 'live-sms') {
  await sendLiveSms();
} else {
  fail('Unknown SMOKE_MODE', { mode: config.mode, allowed: ['path', 'live-sms'] });
}
