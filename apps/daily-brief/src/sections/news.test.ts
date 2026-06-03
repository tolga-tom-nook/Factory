import { describe, expect, it } from 'vitest';
import { parseGoogleNewsRss } from './news';

const SAMPLE = `<?xml version="1.0"?><rss><channel>
  <item>
    <title>Big New Framework Ships v2 - The Verge</title>
    <link>https://news.google.com/rss/articles/aaa</link>
    <pubDate>Mon, 01 Jun 2026 09:00:00 GMT</pubDate>
    <source url="https://theverge.com">The Verge</source>
  </item>
  <item>
    <title><![CDATA[Gwinnett County opens new tech hub - AJC]]></title>
    <link>https://news.google.com/rss/articles/bbb</link>
    <pubDate>Sun, 31 May 2026 12:00:00 GMT</pubDate>
    <source url="https://ajc.com">AJC</source>
  </item>
</channel></rss>`;

describe('parseGoogleNewsRss', () => {
  it('extracts title, link, source and strips the " - Source" suffix', () => {
    const articles = parseGoogleNewsRss(SAMPLE, 10);
    expect(articles).toHaveLength(2);
    expect(articles[0]).toMatchObject({
      title: 'Big New Framework Ships v2',
      source: 'The Verge',
      url: 'https://news.google.com/rss/articles/aaa',
    });
    expect(new Date(articles[0]!.publishedAt).getUTCFullYear()).toBe(2026);
  });

  it('unwraps CDATA titles', () => {
    const articles = parseGoogleNewsRss(SAMPLE, 10);
    expect(articles[1]!.title).toBe('Gwinnett County opens new tech hub');
    expect(articles[1]!.source).toBe('AJC');
  });

  it('honors the limit', () => {
    expect(parseGoogleNewsRss(SAMPLE, 1)).toHaveLength(1);
  });

  it('returns an empty array for a feed with no items', () => {
    expect(parseGoogleNewsRss('<rss><channel></channel></rss>', 5)).toEqual([]);
  });
});
