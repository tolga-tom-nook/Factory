import { describe, expect, it } from 'vitest';
import { buildEmailHtml } from './email';
import type { BriefInsights } from '../sections/insights';

describe('buildEmailHtml', () => {
  it('escapes dynamic text and neutralizes unsafe links', () => {
    const insights: BriefInsights = {
      narration: '<script>alert("narration")</script>\nLine two',
      textSummary: 'summary',
      todaysFocus: ['Ship <b>safe</b> output'],
      timePerspectives: {
        day: 'Today <tag>',
        week: 'Week & beyond',
        month: 'Month "quote"',
        year: "Year 'apostrophe'",
      },
      winOfTheDay: 'Closed <all> the loops',
    };

    const html = buildEmailHtml({
      dateLabel: 'Friday <May>',
      weather: null,
      news: null,
      activity: null,
      health: null,
      insights,
      audioUrl: 'javascript:alert(1)',
      wisdom: null,
      stripeMrr: null,
      postHog: null,
      sentry: null,
    });

    expect(html).toContain('Friday &lt;May&gt;');
    expect(html).toContain('&lt;script&gt;alert(&quot;narration&quot;)&lt;/script&gt;<br/>Line two');
    expect(html).toContain('Closed &lt;all&gt; the loops');
    expect(html).toContain('Ship &lt;b&gt;safe&lt;/b&gt; output');
    expect(html).toContain('href="#"');
    expect(html).not.toContain('javascript:alert(1)');
    expect(html).not.toContain('<script>alert("narration")</script>');
  });

  const baseInsights: BriefInsights = {
    narration: 'All good.',
    textSummary: 'All good.',
    todaysFocus: [],
    timePerspectives: { day: '', week: '', month: '', year: '' },
    winOfTheDay: 'Shipped the thing',
  };

  function render(overrides: Partial<Parameters<typeof buildEmailHtml>[0]>): string {
    return buildEmailHtml({
      dateLabel: 'Monday, June 1, 2026',
      weather: null,
      news: null,
      activity: null,
      health: null,
      insights: baseInsights,
      audioUrl: null,
      wisdom: null,
      stripeMrr: null,
      postHog: null,
      sentry: null,
      ...overrides,
    });
  }

  it('renders a "couldn\'t load" card for failed core sections', () => {
    const html = render({ failures: { weather: true, news: true, github: false, health: false } });
    expect(html).toContain("Couldn't load this section today");
    // Failed sections render a card; sections that simply have no data do not.
    expect(html).toContain('Weather');
    expect(html).toContain('News');
  });

  it('omits a section entirely when it has no data and did not fail', () => {
    const html = render({ failures: { weather: false, news: false, github: false, health: false } });
    expect(html).not.toContain("Couldn't load this section today");
  });

  it('includes a safe "View in browser" link and preheader when provided', () => {
    const html = render({ webViewUrl: 'https://daily-brief.adrper79.workers.dev/brief/2026-06-01' });
    expect(html).toContain('href="https://daily-brief.adrper79.workers.dev/brief/2026-06-01"');
    expect(html).toContain('View in browser');
    // Preheader carries the win-of-the-day snippet.
    expect(html).toContain('Shipped the thing');
  });

  it('neutralizes an unsafe web-view link', () => {
    const html = render({ webViewUrl: 'javascript:alert(1)' });
    expect(html).not.toContain('javascript:alert(1)');
  });
});