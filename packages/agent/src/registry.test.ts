import { describe, it, expect } from 'vitest';
import { ToolRegistry, isLLMExposed, type Tool } from './index.js';

function tool(partial: Partial<Tool> & Pick<Tool, 'name'>): Tool {
  return {
    description: 'a tool',
    side_effects: 'none',
    required_scope: 'read',
    invoke: () => Promise.resolve({ ok: true, result: null }),
    ...partial,
  };
}

describe('ToolRegistry', () => {
  it('registers and retrieves by name', () => {
    const r = new ToolRegistry();
    const t = tool({ name: 'a.b' });
    r.register(t);
    expect(r.get('a.b')).toBe(t);
    expect(r.list()).toEqual([t]);
  });

  it('retrieves by optional id fallback', () => {
    const r = new ToolRegistry();
    const t = tool({ name: 'a.b' });
    r.register(t, 'fixture-1');
    expect(r.get('fixture-1')).toBe(t);
    expect(r.get('a.b')).toBe(t);
  });

  it('returns undefined for unknown name', () => {
    expect(new ToolRegistry().get('nope')).toBeUndefined();
  });

  describe('byTier trust filtering', () => {
    const r = new ToolRegistry();
    r.register(tool({ name: 'read', side_effects: 'read-external' }));
    r.register(tool({ name: 'none', side_effects: 'none' }));
    r.register(tool({ name: 'writeApp', side_effects: 'write-app' }));
    r.register(tool({ name: 'writeExt', side_effects: 'write-external' }));

    it('green = read-only tools', () => {
      expect(r.byTier('green').map((t) => t.name).sort()).toEqual(['none', 'read']);
    });
    it('yellow = everything except write-external', () => {
      expect(r.byTier('yellow').map((t) => t.name).sort()).toEqual(['none', 'read', 'writeApp']);
    });
    it('red = all tools', () => {
      expect(r.byTier('red')).toHaveLength(4);
    });
  });

  describe('LLM exposure', () => {
    const schema = { type: 'object', properties: { id: { type: 'string' } } };

    it('isLLMExposed: schema present ⇒ exposed by default', () => {
      expect(isLLMExposed(tool({ name: 't', parameters: schema }))).toBe(true);
    });
    it('isLLMExposed: no schema ⇒ not exposed (template-only)', () => {
      expect(isLLMExposed(tool({ name: 't' }))).toBe(false);
    });
    it('isLLMExposed: explicit opt-out wins even with a schema', () => {
      expect(isLLMExposed(tool({ name: 't', parameters: schema, exposeToLLM: false }))).toBe(false);
    });

    it('llmTools returns only schema-bearing, opted-in tools', () => {
      const r = new ToolRegistry();
      r.register(tool({ name: 'exposed', parameters: schema }));
      r.register(tool({ name: 'templateOnly' }));
      r.register(tool({ name: 'optedOut', parameters: schema, exposeToLLM: false }));
      expect(r.llmTools().map((t) => t.name)).toEqual(['exposed']);
    });

    it('llmTools intersects with a trust tier', () => {
      const r = new ToolRegistry();
      r.register(tool({ name: 'safeExposed', side_effects: 'read-external', parameters: schema }));
      r.register(tool({ name: 'dangerExposed', side_effects: 'write-external', parameters: schema }));
      expect(r.llmTools('green').map((t) => t.name)).toEqual(['safeExposed']);
    });
  });
});
