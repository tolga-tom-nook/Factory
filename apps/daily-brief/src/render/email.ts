/**
 * Email HTML renderer for the daily brief.
 * Produces a rich, dark-mode-friendly email with sections for weather,
 * news, GitHub activity, worker health, PM insights, and an audio player.
 */

import type { WeatherData } from '../sections/weather';
import type { NewsSection } from '../sections/news';
import type { GitHubActivity } from '../sections/github';
import type { HealthRollup } from '../sections/health';
import type { BriefInsights } from '../sections/insights';
import type { WisdomSection } from '../sections/wisdom';
import type { StripeMrrData } from '../sections/stripe';
import type { PostHogSnapshot } from '../sections/posthog';
import type { SentryErrorData } from '../sections/sentry';

interface SectionFailures {
  weather: boolean;
  news: boolean;
  github: boolean;
  health: boolean;
}

interface EmailInput {
  dateLabel: string;
  weather: WeatherData | null;
  news: NewsSection | null;
  activity: GitHubActivity | null;
  health: HealthRollup | null;
  insights: BriefInsights;
  audioUrl: string | null;
  wisdom: WisdomSection | null;
  stripeMrr: StripeMrrData | null;
  postHog: PostHogSnapshot | null;
  sentry: SentryErrorData | null;
  /** Branded "view in browser" link for the archived HTML brief. */
  webViewUrl?: string;
  /** Which always-on core sections errored, for explicit "couldn't load" cards. */
  failures?: SectionFailures;
}

const COLORS = {
  bg: '#0f0f13',
  card: '#1a1a24',
  border: '#2e2e44',
  accent: '#7c6af7',
  accentLight: '#a99ef8',
  text: '#e8e8f0',
  muted: '#8888aa',
  green: '#4ade80',
  yellow: '#facc15',
  red: '#f87171',
  blue: '#60a5fa',
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeHref(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return escapeHtml(url.toString());
    }
  } catch {
    // Invalid links should degrade to a harmless placeholder.
  }

  return '#';
}

function section(title: string, emoji: string, body: string): string {
  return `
    <div style="
      background:${COLORS.card};
      border:1px solid ${COLORS.border};
      border-radius:12px;
      padding:24px 28px;
      margin-bottom:20px;
    ">
      <h2 style="
        margin:0 0 16px 0;
        font-size:13px;
        font-weight:600;
        letter-spacing:0.12em;
        text-transform:uppercase;
        color:${COLORS.accentLight};
      ">${emoji}&nbsp;&nbsp;${escapeHtml(title)}</h2>
      ${body}
    </div>`;
}

/** Compact "couldn't load" card so a failed core section is visible, not silently dropped. */
function unavailableSection(title: string, emoji: string): string {
  return section(
    title,
    emoji,
    `<div style="font-size:13px;color:${COLORS.muted};display:flex;align-items:center;gap:8px">
      <span style="color:${COLORS.yellow}">&#9888;</span>
      Couldn't load this section today — the upstream source didn't respond. It'll be back in tomorrow's brief.
    </div>`,
  );
}

function pill(text: string, color: string): string {
  return `<span style="
    display:inline-block;
    padding:2px 10px;
    border-radius:100px;
    font-size:11px;
    font-weight:600;
    background:${color}22;
    color:${color};
    border:1px solid ${color}44;
    margin-right:6px;
  ">${escapeHtml(text)}</span>`;
}

function row(label: string, value: string): string {
  return `<div style="
    display:flex;
    justify-content:space-between;
    padding:7px 0;
    border-bottom:1px solid ${COLORS.border};
    font-size:13px;
  ">
    <span style="color:${COLORS.muted}">${escapeHtml(label)}</span>
    <span style="color:${COLORS.text};font-weight:500">${value}</span>
  </div>`;
}

function buildWeatherSection(w: WeatherData): string {
  const alertsHtml =
    w.alerts.length > 0
      ? `<div style="
          background:#f8717122;
          border:1px solid #f8717144;
          border-radius:8px;
          padding:12px 16px;
          margin-top:14px;
          font-size:13px;
          color:${COLORS.red};
        ">
          ⚠️ <strong>Active Alerts:</strong><br/>
          ${w.alerts.map((a) => `${a.event} (${a.severity})`).join('<br/>')}
        </div>`
      : '';

  const body = `
    <div style="display:flex;gap:20px;flex-wrap:wrap">
      <div style="flex:1;min-width:180px">
        <div style="font-size:42px;font-weight:700;color:${COLORS.text};line-height:1">${w.current.tempF}°F</div>
        <div style="font-size:14px;color:${COLORS.muted};margin-top:4px">${escapeHtml(w.current.conditionLabel)}</div>
        <div style="font-size:12px;color:${COLORS.muted};margin-top:2px">Feels like ${w.current.feelsLikeF}°F · ${w.current.windMph} mph · ${w.current.humidity}% humidity</div>
      </div>
      <div style="flex:1;min-width:180px">
        ${row('Today', `${w.today.highF}° / ${w.today.lowF}° — ${escapeHtml(w.today.conditionLabel)}`)}
        ${row('Tomorrow', `${w.tomorrow.highF}° / ${w.tomorrow.lowF}° — ${escapeHtml(w.tomorrow.conditionLabel)}`)}
        ${w.today.precipInches > 0 ? row('Precip today', `${w.today.precipInches}"`) : ''}
      </div>
    </div>
    ${alertsHtml}`;

  return section(`Weather — ${w.location}`, '🌤️', body);
}

function buildNewsSection(news: NewsSection): string {
  const industryHtml =
    news.industry.length > 0
      ? `<div style="margin-bottom:18px">
          <div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:${COLORS.muted};margin-bottom:10px">Industry &amp; Tech</div>
          ${news.industry
            .map(
              (a) => `<div style="padding:10px 0;border-bottom:1px solid ${COLORS.border}">
                <a href="${safeHref(a.url)}" style="color:${COLORS.text};text-decoration:none;font-size:13px;font-weight:500;line-height:1.4">${escapeHtml(a.title)}</a>
                <div style="font-size:11px;color:${COLORS.muted};margin-top:3px">${escapeHtml(a.source)} · ${new Date(a.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
              </div>`,
            )
            .join('')}
        </div>`
      : '';

  const localHtml =
    news.local.length > 0
      ? `<div>
          <div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:${COLORS.muted};margin-bottom:10px">Local — Gwinnett County</div>
          ${news.local
            .map(
              (a) => `<div style="padding:10px 0;border-bottom:1px solid ${COLORS.border}">
                <a href="${safeHref(a.url)}" style="color:${COLORS.text};text-decoration:none;font-size:13px;font-weight:500;line-height:1.4">${escapeHtml(a.title)}</a>
                <div style="font-size:11px;color:${COLORS.muted};margin-top:3px">${escapeHtml(a.source)} · ${new Date(a.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
              </div>`,
            )
            .join('')}
        </div>`
      : '<div style="color:' + COLORS.muted + ';font-size:13px">No local news found today.</div>';

  return section('News', '📰', industryHtml + localHtml);
}

function buildGithubSection(a: GitHubActivity): string {
  const statsRow = `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px">
    ${[
      { label: 'Commits (24h)', val: String(a.recentCommits.length), color: COLORS.green },
      { label: 'PRs merged (24h)', val: String(a.recentPRs.filter((p) => p.state === 'merged').length), color: COLORS.blue },
      { label: 'Issues closed (24h)', val: String(a.closedIssues.length), color: COLORS.accent },
      { label: 'PRs merged (30d)', val: String(a.monthlyMergedPRs), color: COLORS.accentLight },
      { label: 'Commits (YTD)', val: String(a.yearlyCommitCount), color: COLORS.yellow },
    ]
      .map(
        ({ label, val, color }) => `<div style="
          background:${color}15;
          border:1px solid ${color}33;
          border-radius:10px;
          padding:12px 16px;
          text-align:center;
          min-width:100px;
        ">
          <div style="font-size:22px;font-weight:700;color:${color}">${val}</div>
          <div style="font-size:11px;color:${COLORS.muted};margin-top:3px">${label}</div>
        </div>`,
      )
      .join('')}
  </div>`;

  const commitsHtml =
    a.recentCommits.length > 0
      ? `<div style="margin-bottom:14px">
          <div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:${COLORS.muted};margin-bottom:8px">Recent Commits</div>
          ${a.recentCommits
            .slice(0, 6)
            .map(
              (c) => `<div style="padding:7px 0;border-bottom:1px solid ${COLORS.border};font-size:13px">
                <span style="font-family:monospace;font-size:11px;color:${COLORS.accent};margin-right:8px">${escapeHtml(c.sha)}</span>
                <a href="${safeHref(c.url)}" style="color:${COLORS.text};text-decoration:none">${escapeHtml(c.message.slice(0, 80))}</a>
                <span style="color:${COLORS.muted};font-size:11px"> · ${escapeHtml(c.repo)}</span>
              </div>`,
            )
            .join('')}
        </div>`
      : '';

  const renovateHtml =
    a.renovatePRs.length > 0
      ? `<div style="
          background:#facc1510;
          border:1px solid #facc1533;
          border-radius:8px;
          padding:12px 16px;
          margin-top:12px;
        ">
          <div style="font-size:12px;color:${COLORS.yellow};font-weight:600;margin-bottom:6px">🔄 Renovate PRs Waiting for Review (${a.renovatePRs.length})</div>
          ${a.renovatePRs
            .map(
              (p) => `<div style="font-size:12px;color:${COLORS.muted};padding:3px 0">
                <a href="${safeHref(p.url)}" style="color:${COLORS.yellow};text-decoration:none">${escapeHtml(p.title)}</a>
                <span> · ${escapeHtml(p.repo)}</span>
              </div>`,
            )
            .join('')}
        </div>`
      : '';

  const activeReposHtml =
    a.activeRepos.length > 0
      ? `<div style="margin-top:14px">
          <div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:${COLORS.muted};margin-bottom:8px">Most Active This Week</div>
          ${a.activeRepos
            .map((r) => pill(r, COLORS.accent) + `<span style="font-size:12px;color:${COLORS.muted}"> ${a.weeklyCommitsByRepo[r] ?? 0} commits</span>&nbsp;`)
            .join('')}
        </div>`
      : '';

  return section('GitHub Pulse', '💻', statsRow + commitsHtml + renovateHtml + activeReposHtml);
}

function buildHealthSection(h: HealthRollup): string {
  const overallColor =
    h.downCount > 0 ? COLORS.red : h.degradedCount > 0 ? COLORS.yellow : COLORS.green;
  const overallLabel = h.downCount > 0 ? 'Issues Detected' : h.degradedCount > 0 ? 'Degraded' : 'All Systems Healthy';

  const body = `
    <div style="margin-bottom:16px">
      ${pill(overallLabel, overallColor)}
      <span style="font-size:12px;color:${COLORS.muted};margin-left:8px">${h.healthyCount}/${h.statuses.length} workers healthy</span>
    </div>
    ${h.statuses
      .map(
        (s) => `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid ${COLORS.border};font-size:13px">
          <span style="color:${COLORS.text}">${s.name}</span>
          <span>
            ${pill(s.status, s.status === 'healthy' ? COLORS.green : s.status === 'degraded' ? COLORS.yellow : COLORS.red)}
            ${s.latencyMs !== null ? `<span style="font-size:11px;color:${COLORS.muted}">${s.latencyMs}ms</span>` : ''}
          </span>
        </div>`,
      )
      .join('')}`;

  return section('Worker Health', '🚦', body);
}

function buildInsightsSection(insights: BriefInsights, audioUrl: string | null): string {
  const audioHtml = audioUrl
    ? `<div style="
        background:${COLORS.accent}15;
        border:1px solid ${COLORS.accent}44;
        border-radius:10px;
        padding:16px 20px;
        margin-bottom:20px;
        text-align:center;
      ">
        <div style="font-size:12px;color:${COLORS.accentLight};margin-bottom:10px;letter-spacing:0.1em;text-transform:uppercase">🎧 Listen to Today's Brief</div>
        <a href="${safeHref(audioUrl)}" style="
          display:inline-block;
          background:${COLORS.accent};
          color:white;
          text-decoration:none;
          padding:10px 24px;
          border-radius:100px;
          font-size:13px;
          font-weight:600;
        ">▶ Play Narration</a>
      </div>`
    : '';

  const winHtml = insights.winOfTheDay
    ? `<div style="
        background:#4ade8015;
        border:1px solid #4ade8044;
        border-radius:10px;
        padding:14px 18px;
        margin-bottom:18px;
        font-size:14px;
        color:${COLORS.green};
        font-weight:500;
      ">🏆 ${escapeHtml(insights.winOfTheDay)}</div>`
    : '';

  const narrationHtml = `<div style="
    font-size:14px;
    line-height:1.75;
    color:${COLORS.text};
    white-space:pre-wrap;
    margin-bottom:20px;
  ">${escapeHtml(insights.narration).replace(/\n/g, '<br/>')}</div>`;

  const horizonsHtml = `
    <div style="margin-bottom:20px">
      <div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:${COLORS.muted};margin-bottom:12px">Time Horizons</div>
      ${[
        { label: '24 Hours', val: insights.timePerspectives.day, color: COLORS.blue },
        { label: 'This Week', val: insights.timePerspectives.week, color: COLORS.accent },
        { label: 'This Month', val: insights.timePerspectives.month, color: COLORS.accentLight },
        { label: 'This Year', val: insights.timePerspectives.year, color: COLORS.yellow },
      ]
        .filter((h) => h.val)
        .map(
          ({ label, val, color }) => `<div style="padding:10px 0;border-bottom:1px solid ${COLORS.border}">
            <span style="font-size:11px;font-weight:600;color:${color}">${label}</span>
            <div style="font-size:13px;color:${COLORS.text};margin-top:4px;line-height:1.5">${escapeHtml(val)}</div>
          </div>`,
        )
        .join('')}
    </div>`;

  const focusHtml =
    insights.todaysFocus.length > 0
      ? `<div>
          <div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:${COLORS.muted};margin-bottom:10px">Today's Focus</div>
          ${insights.todaysFocus
            .map(
              (focus, index) => `<div style="display:flex;align-items:flex-start;gap:12px;padding:10px 0;border-bottom:1px solid ${COLORS.border}">
                <span style="
                  display:inline-flex;align-items:center;justify-content:center;
                  width:22px;height:22px;border-radius:50%;
                  background:${COLORS.accent};color:white;
                  font-size:11px;font-weight:700;flex-shrink:0;
                ">${index + 1}</span>
                <span style="font-size:13px;color:${COLORS.text};line-height:1.5">${escapeHtml(focus)}</span>
              </div>`,
            )
            .join('')}
        </div>`
      : '';

  return section(
    "Morgan's Take — PM Perspective",
    '🤓',
    audioHtml + winHtml + narrationHtml + horizonsHtml + focusHtml,
  );
}

function buildWisdomSection(w: WisdomSection): string {
  const wisdomLinesHtml = w.wisdomLines
    .map(
      (line) =>
        `<div style="padding:12px 0;border-bottom:1px solid ${COLORS.border};font-size:14px;line-height:1.7;color:${COLORS.text};font-style:italic">&ldquo;${escapeHtml(line)}&rdquo;</div>`,
    )
    .join('');

  const wotd = w.wordOfTheDay;
  const wotdHtml = `
    <div style="background:${COLORS.accent}18;border:1px solid ${COLORS.accent}44;border-radius:10px;padding:18px 20px;margin-top:20px">
      <div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:${COLORS.accentLight};margin-bottom:4px">Word of the Day</div>
      <div style="font-size:22px;font-weight:700;color:${COLORS.text};margin-bottom:2px">${escapeHtml(wotd.word)}</div>
      <div style="font-size:12px;color:${COLORS.muted};margin-bottom:10px">${escapeHtml(wotd.pronunciation)} &middot; <em>${escapeHtml(wotd.partOfSpeech)}</em></div>
      <div style="font-size:13px;color:${COLORS.text};margin-bottom:8px;line-height:1.5">${escapeHtml(wotd.definition)}</div>
      <div style="font-size:12px;color:${COLORS.muted};font-style:italic">&ldquo;${escapeHtml(wotd.usageExample)}&rdquo;</div>
      ${wotd.whyItMatters ? `<div style="font-size:12px;color:${COLORS.accentLight};margin-top:8px;font-weight:500">Why it matters: ${escapeHtml(wotd.whyItMatters)}</div>` : ''}
    </div>`;

  const body = `
    <div style="font-size:18px;font-weight:700;color:${COLORS.accentLight};text-align:center;padding:16px 0 20px;border-bottom:1px solid ${COLORS.border};margin-bottom:20px;font-style:italic;line-height:1.6">${escapeHtml(w.mantra)}</div>
    ${wisdomLinesHtml}
    ${wotdHtml}`;

  return section('Morning Wisdom &amp; Intention', '🌅', body);
}

function buildStripeSection(s: StripeMrrData): string {
  const dc = s.deltaDirection === 'up' ? COLORS.green : s.deltaDirection === 'down' ? COLORS.red : COLORS.muted;
  const di = s.deltaDirection === 'up' ? '&#8593;' : s.deltaDirection === 'down' ? '&#8595;' : '&mdash;';

  const body = `
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:18px">
      <div style="flex:1;min-width:150px;text-align:center;padding:16px;background:${COLORS.green}15;border:1px solid ${COLORS.green}33;border-radius:10px">
        <div style="font-size:28px;font-weight:700;color:${COLORS.green}">${s.mrrFormatted}</div>
        <div style="font-size:11px;color:${COLORS.muted};margin-top:4px">Monthly Recurring Revenue</div>
      </div>
      <div style="flex:1;min-width:150px;text-align:center;padding:16px;background:${dc}15;border:1px solid ${dc}33;border-radius:10px">
        <div style="font-size:28px;font-weight:700;color:${dc}">${di} ${s.deltaFormatted}</div>
        <div style="font-size:11px;color:${COLORS.muted};margin-top:4px">vs yesterday</div>
      </div>
    </div>
    ${row('Active Subscriptions', s.activeSubscriptions.toLocaleString())}
    ${row('New Today', `+${s.newSubscriptionsToday}`)}
    ${row('Cancelled Today', s.cancelledToday > 0 ? `&minus;${s.cancelledToday}` : '0')}
    ${s.trialCount > 0 ? row('In Trial', String(s.trialCount)) : ''}`;

  return section('Revenue Pulse', '&#x1F4B3;', body);
}

function buildPostHogSection(ph: PostHogSnapshot): string {
  const tc = ph.dailyActiveUsersTrend === 'up' ? COLORS.green : ph.dailyActiveUsersTrend === 'down' ? COLORS.red : COLORS.muted;
  const ti = ph.dailyActiveUsersTrend === 'up' ? '&#8593;' : ph.dailyActiveUsersTrend === 'down' ? '&#8595;' : '&rarr;';

  const statsHtml = `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">
    ${[
      { label: 'DAU', val: String(ph.dailyActiveUsers), sub: `${ti} vs 7d avg`, color: tc },
      { label: 'Sessions', val: String(ph.sessions24h), sub: '24h', color: COLORS.blue },
      { label: 'Signups', val: String(ph.signups24h), sub: '24h', color: COLORS.green },
      { label: 'Pageviews', val: ph.pageviews24h.toLocaleString(), sub: '24h', color: COLORS.accent },
    ]
      .map(
        ({ label, val, sub, color }) =>
          `<div style="flex:1;min-width:100px;text-align:center;padding:12px 8px;background:${color}15;border:1px solid ${color}33;border-radius:10px">
            <div style="font-size:22px;font-weight:700;color:${color}">${val}</div>
            <div style="font-size:11px;color:${COLORS.muted};margin-top:2px">${escapeHtml(label)}</div>
            <div style="font-size:10px;color:${COLORS.muted}">${escapeHtml(sub)}</div>
          </div>`,
      )
      .join('')}
  </div>`;

  const topEventsHtml =
    ph.topEvents.length > 0
      ? `<div>
          <div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:${COLORS.muted};margin-bottom:8px">Top Events (24h)</div>
          ${ph.topEvents
            .map(
              (event) => `<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid ${COLORS.border};font-size:13px">
                <span style="color:${COLORS.text};font-family:monospace;font-size:12px">${escapeHtml(event.event)}</span>
                <span style="color:${COLORS.accentLight};font-weight:600">${event.count.toLocaleString()}</span>
              </div>`,
            )
            .join('')}
        </div>`
      : '';

  return section('Product Analytics', '&#x1F4CA;', statsHtml + topEventsHtml);
}

function buildSentrySection(s: SentryErrorData): string {
  const sc = s.spikeDetected ? COLORS.red : COLORS.green;
  const sl = s.spikeDetected
    ? `&#9888; Spike detected: ${s.spikePercent > 0 ? `+${s.spikePercent}%` : ''} above 7-day average`
    : '&#10003; Error rates are normal';

  const projectsHtml = s.projects.length
    ? s.projects
        .map((project) => {
          const pc = project.trend === 'spike' ? COLORS.red : project.trend === 'quiet' ? COLORS.muted : COLORS.green;
          const topHtml = project.topIssues
            .map(
              (issue) => `<div style="font-size:11px;color:${COLORS.muted};padding:2px 0">
                  <a href="${safeHref(issue.url)}" style="color:${COLORS.muted};text-decoration:none">${escapeHtml(issue.title.slice(0, 72))}</a>
                  <span style="color:${pc}"> &times;${issue.count}</span>
                </div>`,
            )
            .join('');
          return `<div style="padding:10px 0;border-bottom:1px solid ${COLORS.border}">
            <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
              <span style="color:${COLORS.text};font-family:monospace">${escapeHtml(project.projectSlug)}</span>
              <span>${pill(project.trend, pc)}<span style="font-size:12px;color:${COLORS.muted}">${project.errors24h} err / 7d avg ${project.errors7dAvg}</span></span>
            </div>
            ${topHtml}
          </div>`;
        })
        .join('')
    : `<div style="color:${COLORS.muted};font-size:13px">No project data.</div>`;

  const body = `
    <div style="padding:12px 16px;border-radius:8px;background:${sc}15;border:1px solid ${sc}44;margin-bottom:16px;font-size:13px;color:${sc};font-weight:600">${sl}</div>
    ${row('Total Errors (24h)', s.totalErrors24h.toLocaleString())}
    ${row('7-Day Average', s.totalErrors7dAvg.toLocaleString())}
    <div style="margin-top:16px">
      <div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:${COLORS.muted};margin-bottom:8px">By Project</div>
      ${projectsHtml}
    </div>`;

  return section('Error Monitoring', '&#x1F534;', body);
}

export function buildEmailHtml(input: EmailInput): string {
  const failures = input.failures ?? { weather: false, news: false, github: false, health: false };

  const wisdomHtml = input.wisdom ? buildWisdomSection(input.wisdom) : '';
  const weatherHtml = input.weather
    ? buildWeatherSection(input.weather)
    : failures.weather ? unavailableSection('Weather', '🌤️') : '';
  const newsHtml = input.news
    ? buildNewsSection(input.news)
    : failures.news ? unavailableSection('News', '📰') : '';
  const githubHtml = input.activity
    ? buildGithubSection(input.activity)
    : failures.github ? unavailableSection('GitHub Pulse', '💻') : '';
  const healthHtml = input.health
    ? buildHealthSection(input.health)
    : failures.health ? unavailableSection('Worker Health', '🚦') : '';
  const stripeHtml = input.stripeMrr ? buildStripeSection(input.stripeMrr) : '';
  const postHogHtml = input.postHog ? buildPostHogSection(input.postHog) : '';
  const sentryHtml = input.sentry ? buildSentrySection(input.sentry) : '';
  const insightsHtml = buildInsightsSection(input.insights, input.audioUrl);

  // Hidden preheader — the snippet inboxes show next to the subject line.
  const preheaderText = input.insights.winOfTheDay?.trim() || input.insights.textSummary?.trim() || '';
  const preheader = preheaderText
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0">${escapeHtml(preheaderText)}</div>`
    : '';

  const webViewHtml = input.webViewUrl
    ? `<div style="text-align:center;margin-bottom:16px">
        <a href="${safeHref(input.webViewUrl)}" style="font-size:11px;color:${COLORS.muted};text-decoration:underline">View in browser</a>
      </div>`
    : '';

  const webViewFooter = input.webViewUrl
    ? `<div style="margin-top:4px"><a href="${safeHref(input.webViewUrl)}" style="color:${COLORS.muted};text-decoration:underline">View this brief in your browser</a></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta name="color-scheme" content="dark"/>
  <title>Daily Brief — ${escapeHtml(input.dateLabel)}</title>
</head>
<body style="
  margin:0;padding:0;
  background:${COLORS.bg};
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,Arial,sans-serif;
  color:${COLORS.text};
  -webkit-font-smoothing:antialiased;
">
  ${preheader}
  <div style="max-width:680px;margin:0 auto;padding:32px 16px 48px">

    ${webViewHtml}

    <!-- Header -->
    <div style="text-align:center;margin-bottom:32px">
      <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:${COLORS.muted};margin-bottom:8px">Daily Brief</div>
      <h1 style="margin:0;font-size:24px;font-weight:700;color:${COLORS.text}">${escapeHtml(input.dateLabel)}</h1>
      <div style="width:40px;height:2px;background:${COLORS.accent};margin:12px auto 0"></div>
    </div>

    ${wisdomHtml}
    ${weatherHtml}
    ${insightsHtml}
    ${stripeHtml}
    ${postHogHtml}
    ${githubHtml}
    ${healthHtml}
    ${sentryHtml}
    ${newsHtml}

    <!-- Footer -->
    <div style="text-align:center;margin-top:32px;font-size:11px;color:${COLORS.muted}">
      <div>Sent by Factory Daily Brief · Cloudflare Workers</div>
      <div style="margin-top:4px">Built by the one and only you.</div>
      ${webViewFooter}
    </div>
  </div>
</body>
</html>`;
}
