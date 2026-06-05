/**
 * Mock LLM factory for deterministic agent loop tests.
 *
 * Produces a `fetch` implementation compatible with `@latimer-woods-tech/llm`'s
 * `complete()` function. Each call returns the next scripted response from a
 * queue, enabling precise control over tool-call sequences, stop conditions,
 * and token counts without hitting a real provider.
 *
 * @example
 * ```ts
 * import { MockLLM } from '@latimer-woods-tech/testing';
 *
 * const llm = new MockLLM()
 *   .thenText('Fetching record…')
 *   .thenToolUse([{ id: 'tc_1', name: 'lookup', arguments: { id: 'u1' } }])
 *   .thenText('User u1 is on the pro plan.');
 *
 * const result = await runLoop(messages, { env, registry, deps: { fetch: llm.fetch } });
 * expect(result.content).toBe('User u1 is on the pro plan.');
 * expect(llm.calls).toHaveLength(3);
 * ```
 */

// ─── Minimal type mirrors (no @lwt/llm dep — stays zero-dep) ──────────────

interface MockToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface MockTurn {
  type: 'text' | 'tool_use';
  text?: string;
  toolCalls?: MockToolCall[];
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
}

function buildAnthropicBody(turn: MockTurn): string {
  const model = turn.model ?? 'claude-sonnet-4-20250514';
  if (turn.type === 'text') {
    return JSON.stringify({
      content: [{ type: 'text', text: turn.text ?? '' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: turn.inputTokens ?? 10, output_tokens: turn.outputTokens ?? 5 },
      model,
    });
  }
  return JSON.stringify({
    content: (turn.toolCalls ?? []).map((tc) => ({
      type: 'tool_use',
      id: tc.id,
      name: tc.name,
      input: tc.arguments,
    })),
    stop_reason: 'tool_use',
    usage: { input_tokens: turn.inputTokens ?? 15, output_tokens: turn.outputTokens ?? 8 },
    model,
  });
}

// ─── MockLLM class ─────────────────────────────────────────────────────────

/**
 * Scripted LLM mock. Each `.thenX()` call queues one response.
 * Calls beyond the queue return the last queued response (safe fallback).
 */
export class MockLLM {
  private queue: MockTurn[] = [];
  /** All fetch call arguments, in order. Useful for asserting what was sent. */
  readonly calls: Array<{ url: string; body: unknown }> = [];

  /** Queue a plain-text response (stopReason = 'end'). */
  thenText(text: string, opts: { inputTokens?: number; outputTokens?: number; model?: string } = {}): this {
    this.queue.push({ type: 'text', text, ...opts });
    return this;
  }

  /** Queue a tool-use response (stopReason = 'tool_use'). */
  thenToolUse(toolCalls: MockToolCall[], opts: { inputTokens?: number; outputTokens?: number; model?: string } = {}): this {
    this.queue.push({ type: 'tool_use', toolCalls, ...opts });
    return this;
  }

  /** Queue a 500 error response (simulates provider failure / fallback). */
  thenError(status = 500, body = 'Internal Server Error'): this {
    // Store as a special marker — fetch returns a non-ok Response.
    this.queue.push({ type: 'text', text: `__error__:${status}:${body}` });
    return this;
  }

  /** The mock fetch function to pass as `deps.fetch` to `complete()` / `runLoop()`. */
  get fetch(): (url: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
    return (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      let body: unknown = undefined;
      try { body = JSON.parse((init?.body as string) ?? '{}'); } catch { /* ignore */ }
      this.calls.push({ url: urlStr, body });

      // Pop the next turn; if this is the last one, keep it for replay.
      const turn: MockTurn = this.queue.length > 1
        ? this.queue.shift()!
        : (this.queue[0] ?? { type: 'text', text: '' });

      // Error sentinel
      if (typeof turn.text === 'string' && turn.text.startsWith('__error__:')) {
        const [, statusStr, ...bodyParts] = turn.text.split(':');
        return Promise.resolve(new Response(bodyParts.join(':'), { status: Number(statusStr) }));
      }

      return Promise.resolve(new Response(buildAnthropicBody(turn), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cf-aig-request-id': `mock-${this.calls.length}` },
      }));
    };
  }

  /** Remaining queued turns (for assertions). */
  get remaining(): number {
    return this.queue.length;
  }

  /** Reset calls and queue. */
  reset(): void {
    this.calls.length = 0;
    this.queue.length = 0;
  }
}
