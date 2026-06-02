// personalitySegment — the `'personality'` SegmentRenderer (I1 Slice 3)
// Cacheable (D3). selfprime authors narration from psychometric data (D6).

import type {
  SegmentContext,
  SegmentRenderer,
  SegmentResult,
  VideoSource,
} from '@latimer-woods-tech/video';
import { personalityToBodyScenes } from './sourceScenes.js';

/**
 * Source data for the `'personality'` segment: a headline + detail (and optional
 * narration/colour) that selfprime authors from psychometric data (D6).
 */
export interface PersonalitySegmentData {
  headline: string;
  detail: string;
  narrationText?: string;
  typeColor?: string;
}

function isPersonalitySourceData(value: unknown): value is PersonalitySegmentData {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['headline'] === 'string' && typeof v['detail'] === 'string';
}

/**
 * {@link SegmentRenderer} for the `'personality'` source. Rejects unless `source`
 * is `'personality'` and `ctx.sourceData` is a valid {@link PersonalitySegmentData};
 * otherwise returns render props + narration. Cacheable — stable across renders (D3).
 */
export const renderPersonalitySegment: SegmentRenderer = (
  source: VideoSource,
  ctx: SegmentContext,
): Promise<SegmentResult> => {
  if (source !== 'personality') {
    return Promise.reject(new Error(`renderPersonalitySegment only handles 'personality', got '${source}'`));
  }
  if (!isPersonalitySourceData(ctx.sourceData)) {
    return Promise.reject(new Error('personality segment requires ctx.sourceData = { headline, detail } resolved by selfprime'));
  }
  const data = ctx.sourceData;
  return Promise.resolve({
    props: { headline: data.headline, detail: data.detail, typeColor: data.typeColor, bodyScenes: personalityToBodyScenes(data) } as Record<string, unknown>,
    narrationText: data.narrationText ?? '',
    cacheable: true,
  });
};
