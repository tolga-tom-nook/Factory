import { describe, it, expect } from 'vitest';
import { MockLLM } from './mock-llm.js';

describe('MockLLM', () => {
  it('returns a text response for thenText', async () => {
    const llm = new MockLLM().thenText('hello');
    const res = await llm.fetch('https://gw.test/anthropic/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { content: Array<{ type: string; text: string }>; stop_reason: string };
    expect(body.stop_reason).toBe('end_turn');
    expect(body.content[0]?.text).toBe('hello');
  });

  it('returns a tool_use response for thenToolUse', async () => {
    const llm = new MockLLM().thenToolUse([{ id: 'tc_1', name: 'lookup', arguments: { id: 'u1' } }]);
    const res = await llm.fetch('https://gw.test/anthropic/v1/messages', { method: 'POST', body: '{}' });
    const body = await res.json() as { stop_reason: string; content: Array<{ type: string; id: string; name: string }> };
    expect(body.stop_reason).toBe('tool_use');
    expect(body.content[0]?.type).toBe('tool_use');
    expect(body.content[0]?.name).toBe('lookup');
  });

  it('queues multiple turns and plays them in order', async () => {
    const llm = new MockLLM()
      .thenToolUse([{ id: 'tc_1', name: 'lookup', arguments: {} }])
      .thenText('done');

    const r1 = await llm.fetch('http://x', { method: 'POST', body: '{}' });
    const b1 = await r1.json() as { stop_reason: string };
    expect(b1.stop_reason).toBe('tool_use');

    const r2 = await llm.fetch('http://x', { method: 'POST', body: '{}' });
    const b2 = await r2.json() as { stop_reason: string };
    expect(b2.stop_reason).toBe('end_turn');
  });

  it('repeats last response when queue is exhausted', async () => {
    const llm = new MockLLM().thenText('final');
    await llm.fetch('http://x', { method: 'POST', body: '{}' });
    const r2 = await llm.fetch('http://x', { method: 'POST', body: '{}' });
    const b2 = await r2.json() as { content: Array<{ text: string }> };
    expect(b2.content[0]?.text).toBe('final');
  });

  it('returns an error response for thenError', async () => {
    const llm = new MockLLM().thenError(503, 'Service Unavailable');
    const res = await llm.fetch('http://x', { method: 'POST', body: '{}' });
    expect(res.status).toBe(503);
    expect(res.ok).toBe(false);
  });

  it('tracks all calls in .calls', async () => {
    const llm = new MockLLM().thenText('a').thenText('b');
    await llm.fetch('http://x/1', { method: 'POST', body: JSON.stringify({ turn: 1 }) });
    await llm.fetch('http://x/2', { method: 'POST', body: JSON.stringify({ turn: 2 }) });
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0]?.url).toBe('http://x/1');
    expect((llm.calls[1]?.body as { turn: number }).turn).toBe(2);
  });

  it('.remaining reports queue depth', () => {
    const llm = new MockLLM().thenText('a').thenText('b');
    expect(llm.remaining).toBe(2);
  });

  it('reset clears calls and queue', async () => {
    const llm = new MockLLM().thenText('x');
    await llm.fetch('http://x', { method: 'POST', body: '{}' });
    llm.reset();
    expect(llm.calls).toHaveLength(0);
    expect(llm.remaining).toBe(0);
  });
});
