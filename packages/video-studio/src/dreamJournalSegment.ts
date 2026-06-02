// dreamJournalSegment — the `'dreamJournal'` SegmentRenderer (I1 Slice 3)
// Fresh per render (D3). selfprime authors narration from the user's real journal entries (D6).

import type {
  SegmentContext,
  SegmentRenderer,
  SegmentResult,
  VideoSource,
} from '@latimer-woods-tech/video';
import { dreamJournalToBodyScenes } from './sourceScenes.js';

/**
 * Source data for the `'dreamJournal'` segment: a headline + detail (and optional
 * narration/colour) that selfprime resolves from the user's real journal entries (D6).
 */
export interface DreamJournalSegmentData {
  headline: string;
  detail: string;
  narrationText?: string;
  typeColor?: string;
}

function isDreamJournalSourceData(value: unknown): value is DreamJournalSegmentData {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['headline'] === 'string' && typeof v['detail'] === 'string';
}

/**
 * {@link SegmentRenderer} for the `'dreamJournal'` source. Rejects unless `source`
 * is `'dreamJournal'` and `ctx.sourceData` is a valid {@link DreamJournalSegmentData};
 * otherwise returns render props + narration. Never cacheable — fresh per render (D3).
 */
export const renderDreamJournalSegment: SegmentRenderer = (
  source: VideoSource,
  ctx: SegmentContext,
): Promise<SegmentResult> => {
  if (source !== 'dreamJournal') {
    return Promise.reject(new Error(`renderDreamJournalSegment only handles 'dreamJournal', got '${source}'`));
  }
  if (!isDreamJournalSourceData(ctx.sourceData)) {
    return Promise.reject(new Error('dreamJournal segment requires ctx.sourceData = { headline, detail } resolved by selfprime'));
  }
  const data = ctx.sourceData;
  return Promise.resolve({
    props: { headline: data.headline, detail: data.detail, typeColor: data.typeColor, bodyScenes: dreamJournalToBodyScenes(data) } as Record<string, unknown>,
    narrationText: data.narrationText ?? '',
    cacheable: false,
  });
};
