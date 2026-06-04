import { describe, it, expect } from 'vitest';
import { MODEL_PRICE_PER_1M } from '@latimer-woods-tech/llm';
import { PRICING_CENTS_PER_MTOK } from './index.js';

/**
 * Single-source-of-truth guard. `@latimer-woods-tech/llm` MODEL_PRICE_PER_1M
 * (USD per 1M tokens) is canonical; llm-meter's cents table must be exactly that
 * table x100. This test fails CI if a rate is changed in one place but not the
 * other, or if llm-meter prices a model the canonical table doesn't know — the
 * exact class of drift that produced the gemini $5-vs-$10 and missing-model bugs.
 */
const toCents = (usd: number): number => Math.round(usd * 100);

describe('pricing-sync: llm-meter cents == @latimer-woods-tech/llm USD x100', () => {
  const entries = Object.entries(PRICING_CENTS_PER_MTOK);

  it('has at least the actively-routed models', () => {
    expect(entries.length).toBeGreaterThanOrEqual(8);
  });

  for (const [model, cents] of entries) {
    it(`${model} matches the canonical @latimer-woods-tech/llm rate`, () => {
      const usd = MODEL_PRICE_PER_1M[model];
      expect(usd, `${model} must exist in canonical MODEL_PRICE_PER_1M`).toBeDefined();
      expect(cents.input).toBe(toCents(usd!.input));
      expect(cents.output).toBe(toCents(usd!.output));
      expect(cents.cachedInput ?? 0).toBe(toCents(usd!.cacheRead));
    });
  }
});
