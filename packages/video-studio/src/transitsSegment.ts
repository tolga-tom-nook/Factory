// transitsSegment — the `'transits'` SegmentRenderer (I1 Slice 3, doc §7)
// Fresh per render (D3). selfprime authors narration from real transit data (D6).

import type {
  SegmentContext,
  SegmentRenderer,
  SegmentResult,
  VideoSource,
} from '@latimer-woods-tech/video';
import { transitsToBodyScenes } from './sourceScenes.js';

/**
 * Source data for the `'transits'` segment: a headline + detail (and optional
 * narration/colour) that selfprime resolves from the user's real transit data (D6).
 */
export interface TransitsSegmentData {
  headline: string;
  detail: string;
  narrationText?: string;
  typeColor?: string;
}

function isTransitsSourceData(value: unknown): value is TransitsSegmentData {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['headline'] === 'string' && typeof v['detail'] === 'string';
}

/**
 * {@link SegmentRenderer} for the `'transits'` source. Rejects unless `source`
 * is `'transits'` and `ctx.sourceData` is a valid {@link TransitsSegmentData};
 * otherwise returns render props + narration. Never cacheable — fresh per render (D3).
 */
export const renderTransitsSegment: SegmentRenderer = (
  source: VideoSource,
  ctx: SegmentContext,
): Promise<SegmentResult> => {
  if (source !== 'transits') {
    return Promise.reject(new Error(`renderTransitsSegment only handles 'transits', got '${source}'`));
  }
  if (!isTransitsSourceData(ctx.sourceData)) {
    return Promise.reject(new Error('transits segment requires ctx.sourceData = { headline, detail } resolved by selfprime'));
  }
  const data = ctx.sourceData;
  return Promise.resolve({
    props: { headline: data.headline, detail: data.detail, typeColor: data.typeColor, bodyScenes: transitsToBodyScenes(data) } as Record<string, unknown>,
    narrationText: data.narrationText ?? '',
    cacheable: false,
  });
};
