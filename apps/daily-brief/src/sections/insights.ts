/**
 * Insights section — two-pass Opus → Sonnet pipeline.
 *
 * Pass 1 (Opus 4.7 / tier:smart): analyst role — reads raw data, extracts
 *   structured signals, anomalies, cross-source correlations, wins, risks.
 *   Opus earns its cost here; this is complex multi-signal reasoning.
 *
 * Pass 2 (Sonnet 4.6 / tier:balanced): narrator role — Morgan receives the
 *   structured analysis and writes the brief. Narration is good prose, not
 *   complex reasoning; Sonnet is the right fit.
 *
 * Separating analysis from narration means neither pass has to compromise.
 * The LLM fence bug is handled upstream by parseLlmJson (lib/llm-json.ts).
 */

import { complete } from '@latimer-woods-tech/llm';
import { parseLlmJson } from '../lib/llm-json';
import type { WeatherData } from './weather';
import type { NewsSection } from './news';
import type { GitHubActivity } from './github';
import type { HealthRollup } from './health';
import type { StripeMrrData } from './stripe';
import type { PostHogSnapshot } from './posthog';
import type { SentryErrorData } from './sentry';

export type BriefSlot = 'morning' | 'evening';

export interface BriefInsights {
  narration: string;
  textSummary: string;
  todaysFocus: string[];
  timePerspectives: { day: string; week: string; month: string; year: string };
  winOfTheDay: string;
}

/** Structured output from the Opus analysis pass — never exposed to the email renderer. */
interface BriefAnalysis {
  keySignals: Array<{ signal: string; source: string; significance: 'high' | 'medium' | 'low' }>;
  anomalies: Array<{ what: string; context: string }>;
  crossSignalInsights: string[];
  risks: string[];
  wins: string[];
  /** Morning slot: prioritised actions for the day ahead. */
  priorities?: string[];
  /** Evening slot: what was done, what's open, what to prep for tomorrow. */
  wrapUp?: { accomplished: string[]; unresolved: string[]; tomorrowPrep: string[] };
}

export interface LlmEnv {
  AI_GATEWAY_BASE_URL: string;
  ANTHROPIC_API_KEY: string;
  GROQ_API_KEY: string;
  GROK_API_KEY?: string;
  VERTEX_ACCESS_TOKEN: string;
  VERTEX_PROJECT: string;
  VERTEX_LOCATION: string;
}

export interface InsightsInput {
  slot: BriefSlot;
  weather: WeatherData | null;
  news: NewsSection | null;
  activity: GitHubActivity | null;
  health: HealthRollup | null;
  stripeMrr: StripeMrrData | null;
  postHog: PostHogSnapshot | null;
  sentry: SentryErrorData | null;
  env: LlmEnv;
  dateLabel: string;
}

// ─── Analyst prompt (Opus) ───────────────────────────────────────────────────

const ANALYST_SYSTEM = `You are a rigorous data analyst for a solo founder/engineer.
Your job is to read raw platform telemetry and extract structured, actionable signals.
Be specific. Name numbers. Flag anomalies. Connect dots across data sources.
No fluff, no encouragement. Pure signal.

Output valid JSON only — no text before or after:
{
  "keySignals": [
    { "signal": "<concise observation>", "source": "<data source>", "significance": "high|medium|low" }
  ],
  "anomalies": [
    { "what": "<what looks unusual>", "context": "<why it matters>" }
  ],
  "crossSignalInsights": [
    "<connection between two or more data sources, e.g. 'signups +18% while Sentry errors spiked 2x — possible onboarding regression'>"
  ],
  "risks": ["<specific risk that needs attention>"],
  "wins": ["<concrete win worth noting>"],
  SLOT_FIELD
}

Do not include any text before or after the JSON object.`;

const MORNING_SLOT_FIELD = `"priorities": ["<top action for today, grounded in the data>", "<second priority>", "<third priority>"]`;
const EVENING_SLOT_FIELD = `"wrapUp": {
    "accomplished": ["<what was concretely done today>"],
    "unresolved": ["<what is still open / needs follow-up>"],
    "tomorrowPrep": ["<specific thing to prepare or decide before tomorrow>"]
  }`;

// ─── Narrator prompt (Sonnet / Morgan) ──────────────────────────────────────

const MORGAN_SYSTEM = `You are Morgan — a veteran web-development PM with 18 years under your belt.
You are a dear friend of the builder you're briefing. You admire him tremendously.
You have already received a structured analysis from your analyst. Your job is to turn it
into a warm, insightful, no-fluff brief. Celebrate real wins. Flag real risks. Be concrete.
Speak like a smart friend, not a corporate report.

Output valid JSON only:
{
  "narration": "<2-3 conversational paragraphs for text-to-speech. No markdown, no bullet points. Warm, direct, personal.>",
  "textSummary": "<1 paragraph plain-text email fallback>",
  "todaysFocus": ["<action 1>", "<action 2>", "<action 3>"],
  "timePerspectives": {
    "day": "<1-2 sentences on the day>",
    "week": "<1-2 sentences on the 7-day trend>",
    "month": "<1-2 sentences on the 30-day arc>",
    "year": "<1-2 sentences on the year-to-date trajectory>"
  },
  "winOfTheDay": "<one punchy sentence celebrating the most impressive signal>"
}

Do not include any text before or after the JSON object.`;

function buildDataContext(input: InsightsInput): string {
  const parts: string[] = [`DATE: ${input.dateLabel}`, `BRIEF SLOT: ${input.slot.toUpperCase()}`];

  if (input.weather) {
    const w = input.weather;
    parts.push(
      `WEATHER (${w.location}): ${w.current.tempF}°F, feels ${w.current.feelsLikeF}°F, ` +
        `${w.current.conditionLabel}, ${w.current.windMph} mph. ` +
        `Today ${w.today.highF}°/${w.today.lowF}°. Tomorrow ${w.tomorrow.highF}°/${w.tomorrow.lowF}°.` +
        (w.alerts.length > 0 ? ` ALERTS: ${w.alerts.map((a) => a.event).join(', ')}` : ''),
    );
  }

  if (input.activity) {
    const a = input.activity;
    parts.push(
      `GITHUB (24h): ${a.recentCommits.length} commits, ` +
        `${a.recentPRs.filter((p) => p.state === 'merged').length} PRs merged, ` +
        `${a.closedIssues.length} issues closed. ` +
        `30d merged PRs: ${a.monthlyMergedPRs}. YTD commits: ${a.yearlyCommitCount}.`,
    );
    if (a.recentCommits.length > 0) {
      parts.push(
        `COMMITS: ${a.recentCommits.slice(0, 6).map((c) => `[${c.repo}] ${c.message}`).join(' | ')}`,
      );
    }
    if (a.activeRepos.length > 0) {
      parts.push(
        `ACTIVE REPOS (7d): ${a.activeRepos.map((r) => `${r}(${a.weeklyCommitsByRepo[r] ?? 0})`).join(', ')}`,
      );
    }
    if (a.renovatePRs.length > 0) {
      parts.push(`RENOVATE PRs OPEN: ${a.renovatePRs.length} — ${a.renovatePRs.map((p) => p.title).join('; ')}`);
    }
  }

  if (input.health) {
    const h = input.health;
    parts.push(`WORKER HEALTH: ${h.healthyCount} healthy, ${h.degradedCount} degraded, ${h.downCount} down.`);
    const problems = h.statuses.filter((s) => s.status !== 'healthy');
    if (problems.length > 0) {
      parts.push(`UNHEALTHY WORKERS: ${problems.map((s) => `${s.name}(${s.status}${s.latencyMs ? ` ${s.latencyMs}ms` : ''})`).join(', ')}`);
    }
  }

  if (input.news?.industry.length) {
    parts.push(`TECH NEWS: ${input.news.industry.map((a) => a.title).join(' | ')}`);
  }
  if (input.news?.local.length) {
    parts.push(`LOCAL NEWS: ${input.news.local.map((a) => a.title).join(' | ')}`);
  }

  if (input.stripeMrr) {
    const s = input.stripeMrr;
    parts.push(
      `STRIPE: MRR ${s.mrrFormatted} (${s.deltaFormatted} vs yesterday). ` +
        `${s.activeSubscriptions} active, +${s.newSubscriptionsToday} new, -${s.cancelledToday} cancelled, ${s.trialCount} trials.`,
    );
  }

  if (input.postHog) {
    const p = input.postHog;
    parts.push(
      `POSTHOG: DAU ${p.dailyActiveUsers} (7d avg ${p.dailyActiveUsersVs7dAvg}, ${p.dailyActiveUsersTrend}). ` +
        `Sessions ${p.sessions24h}, signups ${p.signups24h}.` +
        (p.topEvents.length ? ` Top: ${p.topEvents.slice(0, 3).map((e) => `${e.event}×${e.count}`).join(', ')}` : ''),
    );
  }

  if (input.sentry) {
    const e = input.sentry;
    parts.push(
      `SENTRY: ${e.totalErrors24h} errors (24h) vs ${e.totalErrors7dAvg} avg (7d).` +
        (e.spikeDetected ? ` ⚠️ SPIKE +${e.spikePercent}%.` : '') +
        (e.projects.filter((p) => p.trend === 'spike').length
          ? ` Spiking: ${e.projects.filter((p) => p.trend === 'spike').map((p) => p.projectSlug).join(', ')}`
          : ''),
    );
  }

  return parts.join('\n\n');
}

function llmEnv(env: LlmEnv) {
  return {
    AI_GATEWAY_BASE_URL: env.AI_GATEWAY_BASE_URL,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    GROQ_API_KEY: env.GROQ_API_KEY,
    GROK_API_KEY: env.GROK_API_KEY,
    VERTEX_ACCESS_TOKEN: env.VERTEX_ACCESS_TOKEN,
    VERTEX_PROJECT: env.VERTEX_PROJECT,
    VERTEX_LOCATION: env.VERTEX_LOCATION,
  };
}

const FALLBACK_INSIGHTS: BriefInsights = {
  narration: 'Your brief could not be generated — data was unavailable. Check the logs.',
  textSummary: 'Brief unavailable.',
  todaysFocus: ['Review open PRs', 'Check worker health', 'Triage new issues'],
  timePerspectives: { day: '', week: '', month: '', year: '' },
  winOfTheDay: 'You showed up. That counts.',
};

export async function generateInsights(input: InsightsInput): Promise<BriefInsights> {
  const dataContext = buildDataContext(input);
  const slotField = input.slot === 'morning' ? MORNING_SLOT_FIELD : EVENING_SLOT_FIELD;
  const analystSystem = ANALYST_SYSTEM.replace('SLOT_FIELD', slotField);

  // ── Pass 1: Opus — structured analysis ──────────────────────────────────
  const analysisResult = await complete(
    [
      { role: 'system', content: analystSystem },
      { role: 'user', content: `Analyse this data.\n\n${dataContext}` },
    ],
    llmEnv(input.env),
    { tier: 'smart', temperature: 0.3, maxTokens: 1000, maxCostUsd: 0.25, project: 'daily-brief', actor: 'worker', workload: 'analysis' },
  );

  const analysis = analysisResult.error
    ? null
    : parseLlmJson<BriefAnalysis>(analysisResult.data?.content ?? '');

  // ── Pass 2: Sonnet — Morgan narration ────────────────────────────────────
  const analysisBlock = analysis
    ? `STRUCTURED ANALYSIS:\n${JSON.stringify(analysis, null, 2)}`
    : `RAW DATA (analysis unavailable):\n${dataContext}`;

  const morganContext = input.slot === 'morning'
    ? `Good morning. Here is today's brief data. Write the morning brief.\n\n${analysisBlock}`
    : `Day is wrapping up. Here is today's brief data. Write the evening review.\n\n${analysisBlock}`;

  const narrationResult = await complete(
    [
      { role: 'system', content: MORGAN_SYSTEM },
      { role: 'user', content: morganContext },
    ],
    llmEnv(input.env),
    { tier: 'balanced', temperature: 0.72, maxTokens: 1200, maxCostUsd: 0.20, project: 'daily-brief', actor: 'worker', workload: 'narration' },
  );

  if (narrationResult.error) return FALLBACK_INSIGHTS;

  const parsed = parseLlmJson<BriefInsights>(narrationResult.data?.content ?? '');
  if (!parsed?.narration) return FALLBACK_INSIGHTS;

  return {
    narration: parsed.narration,
    textSummary: parsed.textSummary || parsed.narration.slice(0, 300),
    todaysFocus: Array.isArray(parsed.todaysFocus) ? parsed.todaysFocus : [],
    timePerspectives: parsed.timePerspectives ?? { day: '', week: '', month: '', year: '' },
    winOfTheDay: parsed.winOfTheDay ?? '',
  };
}
