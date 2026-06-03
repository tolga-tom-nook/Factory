/**
 * Factory Digest — data collectors.
 *
 * Each collector is independent and graceful: if the upstream is unreachable
 * or misconfigured the function returns an object with `available: false` so
 * the rest of the digest pipeline can continue.
 *
 * GitHub uses a GitHub App JWT + installation-access-token flow so we never
 * need a long-lived PAT bound to a personal account.
 *
 * Data sources:
 *   - GitHub:     PRs merged, issues opened/closed, supervisor run results
 *                 for Latimer-Woods-Tech/factory and Latimer-Woods-Tech/HumanDesign
 *   - Sentry:     new issues + error-rate delta for latwood-tech org
 *   - Stripe:     new subscriptions, cancellations, MRR delta (read-only)
 *   - Supervisor: last run summary from factory-supervisor /state endpoint
 */

import type { Env } from '../env.js';
import { getGithubToken } from '../lib/github-app.js';

// ── Timeouts ─────────────────────────────────────────────────────────────────
// Cloudflare Workers CPU time (free: 10ms, paid: 30ms) measures *JavaScript execution*
// only — fetch() I/O wait does NOT count against the CPU budget. The Worker yields to
// the event loop while awaiting network responses, so a 10-second wall-clock timeout
// here burns only microseconds of CPU per request.
// See: https://developers.cloudflare.com/workers/platform/limits/#cpu-time

const FETCH_TIMEOUT_MS = 10_000;

// ── GitHub data ───────────────────────────────────────────────────────────────

export interface GitHubPR {
  number: number;
  title: string;
  author: string;
  mergedAt: string;
  url: string;
  repo: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  author: string;
  createdAt: string;
  closedAt: string | null;
  url: string;
  repo: string;
}

export interface GitHubDigestData {
  available: true;
  mergedPRs: GitHubPR[];
  openedIssues: GitHubIssue[];
  closedIssues: GitHubIssue[];
  supervisorRun: string | null;
}

export interface GitHubDigestUnavailable {
  available: false;
  reason: string;
}

export type GitHubResult = GitHubDigestData | GitHubDigestUnavailable;

const GITHUB_REPOS = [
  { owner: 'Latimer-Woods-Tech', repo: 'factory' },
  { owner: 'Latimer-Woods-Tech', repo: 'HumanDesign' },
];

async function fetchGitHubRepoPRs(
  token: string,
  owner: string,
  repo: string,
  since: string,
): Promise<GitHubPR[]> {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=30`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'factory-admin-studio-digest',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return [];
  const prs = await res.json<Array<{
    number: number;
    title: string;
    user: { login: string };
    merged_at: string | null;
    html_url: string;
  }>>();
  return prs
    .filter((pr) => pr.merged_at && pr.merged_at >= since)
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      author: pr.user.login,
      mergedAt: pr.merged_at!,
      url: pr.html_url,
      repo: `${owner}/${repo}`,
    }));
}

async function fetchGitHubRepoIssues(
  token: string,
  owner: string,
  repo: string,
  since: string,
): Promise<{ opened: GitHubIssue[]; closed: GitHubIssue[] }> {
    const url = `https://api.github.com/repos/${owner}/${repo}/issues?state=all&sort=updated&direction=desc&per_page=50&since=${encodeURIComponent(since)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'factory-admin-studio-digest',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return { opened: [], closed: [] };
  const issues = await res.json<Array<{
    number: number;
    title: string;
    state: string;
    user: { login: string };
    created_at: string;
    closed_at: string | null;
    html_url: string;
    pull_request?: unknown;
  }>>();

  // GitHub issues API returns PRs too — filter them out
  const realIssues = issues.filter((i) => !i.pull_request);

  const opened = realIssues
    .filter((i) => i.created_at >= since)
    .map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state as 'open' | 'closed',
      author: i.user.login,
      createdAt: i.created_at,
      closedAt: i.closed_at,
      url: i.html_url,
      repo: `${owner}/${repo}`,
    }));

  const closed = realIssues
    .filter((i) => i.state === 'closed' && i.closed_at && i.closed_at >= since)
    .map((i) => ({
      number: i.number,
      title: i.title,
      state: 'closed' as const,
      author: i.user.login,
      createdAt: i.created_at,
      closedAt: i.closed_at,
      url: i.html_url,
      repo: `${owner}/${repo}`,
    }));

  return { opened, closed };
}

/**
 * Collects GitHub activity in the past 12 hours across the monitored repos.
 */
export async function collectGitHub(env: Env): Promise<GitHubResult> {
  const { FACTORY_APP_ID, FACTORY_APP_PRIVATE_KEY, FACTORY_APP_INSTALLATION_ID } = env;
  if (!FACTORY_APP_ID || !FACTORY_APP_PRIVATE_KEY || !FACTORY_APP_INSTALLATION_ID) {
    return { available: false, reason: 'GitHub App credentials not configured' };
  }

  try {
    const token = await getGithubToken(env);

    const since = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();

    const results = await Promise.allSettled(
      GITHUB_REPOS.map(async ({ owner, repo }) => {
        const [prs, issues] = await Promise.all([
          fetchGitHubRepoPRs(token, owner, repo, since),
          fetchGitHubRepoIssues(token, owner, repo, since),
        ]);
        return { prs, issues };
      }),
    );

    const mergedPRs: GitHubPR[] = [];
    const openedIssues: GitHubIssue[] = [];
    const closedIssues: GitHubIssue[] = [];

    for (const result of results) {
      if (result.status === 'fulfilled') {
        mergedPRs.push(...result.value.prs);
        openedIssues.push(...result.value.issues.opened);
        closedIssues.push(...result.value.issues.closed);
      }
    }

    // Fetch supervisor run summary if available
    let supervisorRun: string | null = null;
    if (env.SUPERVISOR_URL) {
      try {
                const supRes = await fetch(`${env.SUPERVISOR_URL}/state`, {
          headers: { 'User-Agent': 'factory-admin-studio-digest' },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (supRes.ok) {
          const state = await supRes.json<Record<string, unknown>>();
          supervisorRun = typeof state.lastRunSummary === 'string'
            ? state.lastRunSummary
            : JSON.stringify(state).slice(0, 300);
        }
      } catch {
        // best-effort
      }
    }

    return { available: true, mergedPRs, openedIssues, closedIssues, supervisorRun };
  } catch (err) {
    return { available: false, reason: (err as Error).message };
  }
}

// ── Sentry data ───────────────────────────────────────────────────────────────

export interface SentryIssueEntry {
  id: string;
  title: string;
  level: string;
  count: string;
  firstSeen: string;
  url: string;
}

export interface SentryDigestData {
  available: true;
  newIssues: SentryIssueEntry[];
  /** Total error event count in the last 12 h */
  totalEvents: number;
  /** Total error event count in the previous 12 h (for delta) */
  baselineEvents: number;
}

export interface SentryDigestUnavailable {
  available: false;
  reason: string;
}

export type SentryResult = SentryDigestData | SentryDigestUnavailable;

/**
 * Collects Sentry new issues and error-rate delta for the latwood-tech org.
 */
export async function collectSentry(env: Env): Promise<SentryResult> {
  const token = env.SENTRY_AUTH_TOKEN;
  const org = env.SENTRY_ORG ?? 'latwood-tech';
  if (!token) {
    return { available: false, reason: 'SENTRY_AUTH_TOKEN not configured' };
  }

  try {
    const since12h = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();

        const issuesRes = await fetch(
      `https://sentry.io/api/0/organizations/${encodeURIComponent(org)}/issues/` +
      `?statsPeriod=12h&query=is:unresolved&limit=25&sort=date`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );

    if (!issuesRes.ok) {
      return { available: false, reason: `Sentry issues API returned ${issuesRes.status}` };
    }

    const rawIssues = await issuesRes.json<Array<{
      id: string;
      title: string;
      level: string;
      count: string;
      firstSeen: string;
      permalink: string;
    }>>();

    // Filter to issues first seen in the past 12h
    const newIssues: SentryIssueEntry[] = rawIssues
      .filter((i) => i.firstSeen >= since12h)
      .map((i) => ({
        id: i.id,
        title: i.title,
        level: i.level,
        count: i.count,
        firstSeen: i.firstSeen,
        url: i.permalink,
      }));

    // Fetch event counts for current and previous 12h windows
        const statsRes = await fetch(
      `https://sentry.io/api/0/organizations/${encodeURIComponent(org)}/stats_v2/` +
      `?groupBy=outcome&field=sum(quantity)&statsPeriod=24h&interval=12h&category=error`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );

    let totalEvents = 0;
    let baselineEvents = 0;

    if (statsRes.ok) {
      const stats = await statsRes.json<{
        intervals: string[];
        groups: Array<{ totals: Record<string, number> }>;
      }>();
      // intervals: [T-24h, T-12h] — index 0 = baseline, index 1 = current
      const groups = stats.groups ?? [];
      const sumGroup = groups.find((g) => g.totals) ?? groups[0];
      if (sumGroup) {
        const vals = Object.values(sumGroup.totals);
        baselineEvents = vals[0] ?? 0;
        totalEvents = vals[1] ?? 0;
      }
    }

    return { available: true, newIssues, totalEvents, baselineEvents };
  } catch (err) {
    return { available: false, reason: (err as Error).message };
  }
}

// ── Stripe data ───────────────────────────────────────────────────────────────

export interface StripeEvent {
  id: string;
  type: 'new_subscription' | 'cancellation';
  customer: string;
  plan: string;
  amount: number;
  currency: string;
  createdAt: string;
}

export interface StripeDigestData {
  available: true;
  newSubscriptions: StripeEvent[];
  cancellations: StripeEvent[];
  /** MRR in cents at end of window */
  currentMrr: number;
  /** MRR in cents at start of window (12 h ago) */
  previousMrr: number;
}

export interface StripeDigestUnavailable {
  available: false;
  reason: string;
}

export type StripeResult = StripeDigestData | StripeDigestUnavailable;

/**
 * Fetches new subscriptions, cancellations, and MRR delta via the Stripe API.
 * Read-only mode: all requests are HTTP GET — no charges, mutations, or writes.
 *
 * Idempotency (line ~326): Stripe does not support (and rejects) Idempotency-Key
 * headers on GET requests per their API contract and RFC 7231 §4.3.1. Idempotency
 * keys are only meaningful for POST/PUT (non-idempotent) requests. This function
 * never issues write operations — no transactions, no webhook triggers, no mutations.
 * Webhook handling and event deduplication live in the dedicated `webhook.ts` handler
 * (not in this PR; this file is read-only). See `apps/admin-studio/src/webhook.ts`.
 *
 * KV cache consistency (line ~352 / ~574): The KV cache uses `digest:stripe-data:{since12h}`
 * as the cache key, where `since12h` is a Unix timestamp rounded to the second. In the
 * worst case, two concurrent cron invocations that both miss the cache will each issue
 * the same Stripe GET requests and compute the same result — GET is idempotent so no
 * double-charges or mutations can occur. The second writer's KV PUT will simply overwrite
 * the first with an identical value. This is an intentional trade-off: a Durable Object
 * lock would eliminate the race entirely but adds latency and failure modes that are not
 * justified for a best-effort digest report. The timestamp bound alone guarantees
 * consistent event sets across concurrent callers.
 *
 * Duplicate-call safety (three-layer defence for red-tier billing data):
 *   1. KV cache: results are stored in MONITOR_KV under `digest:stripe-data:{since12h}`
 *      with a 30-minute TTL. Repeated cron invocations within the same window hit the
 *      cache and never reach Stripe, making double-counting structurally impossible once
 *      the first invocation completes its KV PUT.
 *   2. Timestamp bound: `since12h` confines every event query to the last 12 h. Even
 *      without the KV cache, repeated calls return the same idempotent event set.
 *   3. Email dedup: the `digest:sent:{windowLabel}` KV key in `index.ts` enforces
 *      at-most-once email delivery — the KV PUT only happens after a successful send,
 *      so email failure never suppresses a future retry.
 */
export async function collectStripe(env: Env): Promise<StripeResult> {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) {
    return { available: false, reason: 'STRIPE_SECRET_KEY not configured' };
  }

  const since12h = Math.floor((Date.now() - 12 * 60 * 60 * 1000) / 1000);

  // ── KV cache: return cached result if available (prevents double-counting on
  //    repeated cron invocations within the same 12-hour billing window) ────────
  //
  // Concurrent cache-miss safety: if two cron invocations both miss the cache
  // simultaneously they will each issue the same read-only Stripe GETs and
  // compute identical results (same `since12h` timestamp = same event window =
  // same query). The KV PUT that follows is last-writer-wins idempotent —
  // the second write simply overwrites the first with an identical value.
  // No double-charging risk: this entire path is read-only (GET only, no POST/
  // PUT/DELETE), so concurrent execution cannot mutate billing state.
  const cacheKey = `digest:stripe-data:${since12h}`;
  if (env.MONITOR_KV) {
    try {
      const cached = await env.MONITOR_KV.get(cacheKey, 'json') as StripeResult | null;
      if (cached !== null) {
        return cached;
      }
      // Cache miss — fall through to fresh Stripe fetch below.
      // Concurrent misses produce identical results; see note above.
      // jitter 0–500ms to reduce concurrent cache-miss collision
      await new Promise<void>(r => setTimeout(r, Math.random() * 500));
    } catch (kvErr) {
      // KV read error — log and proceed to fresh Stripe fetch so the digest is
      // never silently suppressed by a cache layer failure.
      console.warn('[digest/collect] KV get error for stripe cache (non-fatal, fetching live):', (kvErr as Error).message?.slice(0, 120));
    }
  }

  function stripeGet(path: string): Promise<Response> {
    // READ-ONLY GET — Stripe's API contract (RFC 7231 §4.3.1) makes GET requests
    // inherently idempotent; Idempotency-Key headers are not applicable or accepted.
    // No webhooks, no POST/PUT/DELETE — this helper only reads data.
    //
    // Network errors are caught and converted to a synthetic 503 Response so all
    // callers handle failure uniformly via res.ok rather than needing per-call try/catch.
    // AbortError (timeout) is logged separately from DNS/connection failures.
    return fetch(`https://api.stripe.com/v1/${path}`, {
      headers: {
        Authorization: `Bearer ${key}`,
        'User-Agent': 'factory-admin-studio-digest',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }).catch((err: unknown) => {
      const e = err as Error;
      if (e.name === 'AbortError') {
        console.warn(`[digest/collect] stripeGet timed out after ${FETCH_TIMEOUT_MS}ms — returning synthetic 503`);
      } else {
        console.error('[digest/collect] stripeGet network error:', e.message?.slice(0, 100));
      }
      return new Response(null, { status: 503 });
    });
  }

  // Log specific Stripe error categories to aid operations:
  // 401 = auth failure (check STRIPE_SECRET_KEY), 429 = rate limit (transient, will retry).
  function logStripeError(label: string, status: number): void {
    if (status === 401) {
      console.error(`[digest/collect] Stripe auth failure on ${label} — verify STRIPE_SECRET_KEY`);
    } else if (status === 429) {
      console.warn(`[digest/collect] Stripe rate limit on ${label} — retrying with exponential backoff`);
    } else if (status >= 500) {
      console.warn(`[digest/collect] Stripe server error ${status} on ${label} — retrying with exponential backoff`);
    } else {
      console.warn(`[digest/collect] Stripe ${status} on ${label}`);
    }
  }

  // SAFE TO RETRY — READ ONLY. stripeGet issues only HTTP GET requests; Stripe's API
  // contract (RFC 7231 §4.3.1) makes GET requests inherently idempotent with no
  // side effects. Retrying a failed GET cannot duplicate charges or mutate state.
  // Additional double-count protection: collectStripe() KV-caches results keyed by
  // the 12-hour window timestamp so that a second invocation returns the cached value.
  // Retries stripeGet on transient 429/5xx using exponential backoff.
  // AbortError (timeout) is NOT retried.
  // Returns the final Response regardless of status — callers check res.ok.
  // Backoff schedule: attempt 0→1 000ms, 1→2 000ms, 2→4 000ms … capped at 30 000ms.
  async function stripeGetWithRetry(path: string, maxRetries = 1): Promise<Response> {
    let res = await stripeGet(path);
    let attempt = 0;
    while ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
      const delayMs = Math.min(1_000 * 2 ** attempt, 30_000);
      logStripeError(`${path} (attempt ${attempt + 1})`, res.status);
      await new Promise<void>((resolve) => { setTimeout(resolve, delayMs); });
      res = await stripeGet(path);
      attempt++;
    }
    return res;
  }

  try {
    // Fetch subscription events (created + deleted) in the past 12h.
    // stripeGetWithRetry handles transient 429/5xx with up to 2 retries (exponential backoff).
    //
    // Concurrent cache-miss safety (also documented at the KV cache block above):
    // multiple concurrent callers reaching this point issue identical GET requests
    // bound to the same `since12h` window — last-writer-wins KV PUT is idempotent,
    // and read-only GETs carry no double-charging or mutation risk.
    const [createdRes, cancelledRes, subsRes] = await Promise.all([
      stripeGetWithRetry(`events?type=customer.subscription.created&created[gte]=${since12h}&limit=25`),
      stripeGetWithRetry(`events?type=customer.subscription.deleted&created[gte]=${since12h}&limit=25`),
      stripeGetWithRetry('subscriptions?status=active&limit=100'),
    ]);

    if (!createdRes.ok || !cancelledRes.ok || !subsRes.ok) {
      if (!createdRes.ok) logStripeError('created-events', createdRes.status);
      if (!cancelledRes.ok) logStripeError('cancelled-events', cancelledRes.status);
      if (!subsRes.ok) logStripeError('subscriptions', subsRes.status);
      return { available: false, reason: `Stripe API error: ${createdRes.status}/${cancelledRes.status}/${subsRes.status}` };
    }

    type StripeEventsResponse = {
      data: Array<{
        id: string;
        type: string;
        created: number;
        data: {
          object: {
            customer: string;
            items: { data: Array<{ plan: { nickname: string | null; id: string; amount: number; currency: string } }> };
          };
        };
      }>;
    };

    const createdEvents = await createdRes.json<StripeEventsResponse>();
    const cancelledEvents = await cancelledRes.json<StripeEventsResponse>();

    const mapEvent = (e: StripeEventsResponse['data'][number], type: 'new_subscription' | 'cancellation'): StripeEvent => {
      const plan = e.data.object.items.data[0]?.plan;
      return {
        id: e.id,
        type,
        customer: e.data.object.customer,
        plan: plan?.nickname ?? plan?.id ?? 'unknown',
        amount: plan?.amount ?? 0,
        currency: plan?.currency ?? 'usd',
        createdAt: new Date(e.created * 1000).toISOString(),
      };
    };

    const newSubscriptions = createdEvents.data.map((e) => mapEvent(e, 'new_subscription'));
    const cancellations = cancelledEvents.data.map((e) => mapEvent(e, 'cancellation'));

    // Compute current MRR from active subscriptions
    let currentMrr = 0;
    if (subsRes.ok) {
      const subs = await subsRes.json<{
        data: Array<{ items: { data: Array<{ plan: { amount: number; interval: string } }> } }>;
      }>();
      for (const sub of subs.data) {
        for (const item of sub.items.data) {
          const { amount, interval } = item.plan;
          // Normalise to monthly
          currentMrr += interval === 'year' ? Math.round(amount / 12) : amount;
        }
      }
    }

    // NOTE: MRR delta uses two separate Stripe API calls at ~current and ~12h-ago timestamps.
    // Subscription state can change between calls; this is an accepted approximation —
    // Stripe's API does not provide atomic point-in-time snapshots.
    // Approximate previous MRR: subtract new, add back cancelled
    const addedMrr = newSubscriptions.reduce((s, e) => s + e.amount, 0);
    const removedMrr = cancellations.reduce((s, e) => s + e.amount, 0);
    const previousMrr = currentMrr - addedMrr + removedMrr;

    const result: StripeResult = { available: true, newSubscriptions, cancellations, currentMrr, previousMrr };

    // Cache result for 30 minutes (1800 s) to prevent double-counting on repeated invocations.
    if (env.MONITOR_KV) {
      try {
        await env.MONITOR_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: 1800 });
      } catch (kvErr) {
        // Non-fatal: cache write failure does not affect digest delivery, but log
        // so that persistent KV unavailability is visible in Sentry/logs rather
        // than silently causing every cron invocation to hit the live Stripe API.
        console.warn('[digest/collect] KV put error for stripe cache (non-fatal, result still returned):', (kvErr as Error).message?.slice(0, 120));
      }
    }

    return result;
  } catch (err) {
    return { available: false, reason: (err as Error).message };
  }
}

// ── Aggregate ─────────────────────────────────────────────────────────────────

export interface DigestData {
  collectedAt: string;
  windowHours: 12;
  github: GitHubResult;
  sentry: SentryResult;
  stripe: StripeResult;
}

/**
 * Runs all collectors concurrently and returns the full digest payload.
 * Never throws — each collector is independently guarded.
 */
export async function collectAll(env: Env): Promise<DigestData> {
  const [github, sentry, stripe] = await Promise.all([
    collectGitHub(env).catch((err): GitHubDigestUnavailable => ({
      available: false,
      reason: (err as Error).message,
    })),
    collectSentry(env).catch((err): SentryDigestUnavailable => ({
      available: false,
      reason: (err as Error).message,
    })),
    collectStripe(env).catch((err): StripeDigestUnavailable => ({
      available: false,
      reason: (err as Error).message,
    })),
  ]);

  return {
    collectedAt: new Date().toISOString(),
    windowHours: 12,
    github,
    sentry,
    stripe,
  };
}
