/**
 * News section — Google News RSS.
 *
 * Replaces NewsAPI.org, whose free "Developer" plan rejects requests from
 * server/production environments (HTTP 426) and so never worked from a
 * Cloudflare Worker. Google News RSS needs no API key, has no
 * production-origin restriction, and is reachable from Workers.
 *
 * The feed returns XML; Workers have no DOM parser, so we extract items with
 * narrow regexes over the well-formed, predictable RSS structure.
 */

export interface NewsArticle {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  description: string | null;
}

export interface NewsSection {
  industry: NewsArticle[];
  local: NewsArticle[];
}

const RSS_BASE = 'https://news.google.com/rss/search';

function decodeEntities(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
    .trim();
}

/** Pull the inner text of the first `<tag>…</tag>`, unwrapping any CDATA. */
function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m?.[1]) return '';
  const cdata = m[1].match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return decodeEntities(cdata?.[1] ?? m[1]);
}

/**
 * Parse a Google News RSS document into articles.
 *
 * Google News titles arrive as "Headline - Source Name"; the `<source>`
 * element carries the canonical publisher, so we prefer it and strip the
 * trailing " - Source" suffix from the title when present.
 */
export function parseGoogleNewsRss(xml: string, limit: number): NewsArticle[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  const articles: NewsArticle[] = [];

  for (const item of items) {
    const rawTitle = tag(item, 'title');
    const link = tag(item, 'link');
    if (!rawTitle || !link) continue;

    const source = tag(item, 'source');
    let title = rawTitle;
    if (source && title.endsWith(` - ${source}`)) {
      title = title.slice(0, -(source.length + 3)).trim();
    } else {
      // Fall back to splitting on the last " - " separator.
      const idx = title.lastIndexOf(' - ');
      if (idx > 0) title = title.slice(0, idx).trim();
    }

    const pubDate = tag(item, 'pubDate');
    articles.push({
      title,
      source: source || 'Google News',
      url: link,
      publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
      description: null,
    });

    if (articles.length >= limit) break;
  }

  return articles;
}

async function fetchFeed(query: string, limit: number): Promise<NewsArticle[]> {
  const url = `${RSS_BASE}?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'daily-brief/1.0' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Google News RSS ${res.status}`);
  const xml = await res.text();
  return parseGoogleNewsRss(xml, limit);
}

/**
 * Fetch industry/tech headlines plus local Gwinnett County news.
 * No API key required.
 */
export async function fetchNewsSection(): Promise<NewsSection> {
  const [industryRes, localRes] = await Promise.allSettled([
    fetchFeed('technology OR software OR startup OR "web development" when:1d', 6),
    fetchFeed('"Gwinnett County" OR "Dacula GA" OR "Lawrenceville GA" OR "Buford GA" when:3d', 5),
  ]);

  const industry = industryRes.status === 'fulfilled' ? industryRes.value.slice(0, 5) : [];
  const local = localRes.status === 'fulfilled' ? localRes.value.slice(0, 4) : [];

  // If both feeds failed, surface the failure so the brief shows a clear
  // "couldn't load" state rather than a silent empty section.
  if (industryRes.status === 'rejected' && localRes.status === 'rejected') {
    throw new Error('Both news feeds failed');
  }

  return { industry, local };
}
