import { describe, expect, it } from 'vitest';
import { parseLlmJson } from './llm-json';

describe('parseLlmJson', () => {
  it('parses clean JSON', () => {
    expect(parseLlmJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips ```json code fences', () => {
    const raw = '```json\n{"mantra":"breathe"}\n```';
    expect(parseLlmJson<{ mantra: string }>(raw)).toEqual({ mantra: 'breathe' });
  });

  it('strips bare ``` fences', () => {
    expect(parseLlmJson<{ a: number }>('```\n{"a":2}\n```')).toEqual({ a: 2 });
  });

  it('extracts the object when the model adds a preamble', () => {
    const raw = 'Here is your brief:\n{"winOfTheDay":"shipped it"} — enjoy!';
    expect(parseLlmJson<{ winOfTheDay: string }>(raw)).toEqual({ winOfTheDay: 'shipped it' });
  });

  it('ignores braces inside string values when balancing', () => {
    const raw = '{"note":"use a literal { and } here","ok":true}';
    expect(parseLlmJson<{ note: string; ok: boolean }>(raw)).toEqual({
      note: 'use a literal { and } here',
      ok: true,
    });
  });

  it('returns null for empty or non-JSON input', () => {
    expect(parseLlmJson('')).toBeNull();
    expect(parseLlmJson('no json at all')).toBeNull();
  });
});
