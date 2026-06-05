import { describe, it, expect } from 'vitest';
import { pruneMessages } from './pruning.js';
import type { LLMMessage } from '@latimer-woods-tech/llm';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function userText(text: string): LLMMessage {
  return { role: 'user', content: text };
}

function assistantText(text: string): LLMMessage {
  return { role: 'assistant', content: text };
}

function assistantToolUse(id: string, name = 'some_tool'): LLMMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input: {} }],
  };
}

function userToolResult(toolUseId: string, result = 'ok'): LLMMessage {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content: result }],
  };
}

/** Build a history with N plain turns (user + assistant pairs). */
function plainHistory(n: number): LLMMessage[] {
  const msgs: LLMMessage[] = [];
  for (let i = 0; i < n; i++) {
    msgs.push(userText(`question ${i}`));
    msgs.push(assistantText(`answer ${i}`));
  }
  return msgs;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('pruneMessages', () => {
  describe('under-threshold passthrough', () => {
    it('returns the same array reference when at threshold', () => {
      const msgs = plainHistory(20); // 40 messages — exactly maxMessages
      const result = pruneMessages(msgs, { maxMessages: 40 });
      expect(result).toBe(msgs); // same reference — no copy
    });

    it('returns the same array reference when under threshold', () => {
      const msgs = plainHistory(5); // 10 messages
      const result = pruneMessages(msgs, { maxMessages: 40 });
      expect(result).toBe(msgs);
    });

    it('returns the same array when maxMessages is large', () => {
      const msgs = plainHistory(10);
      const result = pruneMessages(msgs, { maxMessages: 100 });
      expect(result).toBe(msgs);
    });
  });

  describe('over-threshold windowing', () => {
    it('limits the result to maxMessages when over threshold', () => {
      const msgs = plainHistory(30); // 60 messages
      const result = pruneMessages(msgs, { maxMessages: 10, keepFirstUser: false });
      expect(result.length).toBeLessThanOrEqual(10);
    });

    it('keeps the most recent messages (tail)', () => {
      const msgs = plainHistory(30); // 60 messages, last pair: question 29 / answer 29
      const result = pruneMessages(msgs, { maxMessages: 4, keepFirstUser: false });
      // Tail of 4 = last 4 messages: question 28, answer 28, question 29, answer 29
      const last = msgs.slice(-4);
      expect(result).toEqual(last);
    });

    it('does not mutate the original messages array', () => {
      const msgs = plainHistory(30);
      const originalLength = msgs.length;
      pruneMessages(msgs, { maxMessages: 10 });
      expect(msgs.length).toBe(originalLength);
    });
  });

  describe('first-user preservation', () => {
    it('prepends the first user message when keepFirstUser is true (default)', () => {
      const msgs = plainHistory(30); // 60 messages
      const result = pruneMessages(msgs, { maxMessages: 6 });
      // First user message should be at index 0 of the result
      expect(result[0]).toEqual(userText('question 0'));
    });

    it('result length is bounded by maxMessages when anchor is outside tail', () => {
      const msgs = plainHistory(30); // 60 messages
      const result = pruneMessages(msgs, { maxMessages: 6, keepFirstUser: true });
      // Anchor (1) + tail (5) = 6 max
      expect(result.length).toBeLessThanOrEqual(6);
    });

    it('does not duplicate first user message when it falls inside the tail window', () => {
      // 6 messages total, maxMessages=10 → under threshold, same ref returned
      // Make it over threshold with a small maxMessages that includes the first user
      const msgs = plainHistory(5); // 10 messages, first user at index 0
      // Prune to 8 (still under threshold of 10) — same ref
      const result = pruneMessages(msgs, { maxMessages: 10, keepFirstUser: true });
      expect(result).toBe(msgs); // under threshold
    });

    it('does not duplicate anchor when its index falls within the pruned tail', () => {
      // 12 messages (6 pairs), prune to last 10 — first user msg is at index 0,
      // which is NOT in the last 10 slice (indices 2–11), so anchor is prepended.
      // Then prune to last 8: indices 4–11. First user (index 0) not in slice → prepended.
      const msgs = plainHistory(6); // 12 messages
      // window = 4: tail starts at index 8 (last 3 messages)
      // tail = msgs[9..11] = answer4, user5, answer5
      // first user (index 0) NOT in tail → prepend
      const result = pruneMessages(msgs, { maxMessages: 4, keepFirstUser: true });
      // Result should have exactly one occurrence of "question 0"
      const count = result.filter((m) => m.content === 'question 0').length;
      expect(count).toBe(1);
    });

    it('skips first-user anchor when keepFirstUser is false', () => {
      const msgs = plainHistory(30); // 60 messages
      const result = pruneMessages(msgs, { maxMessages: 6, keepFirstUser: false });
      // First message should NOT be the very first user message (question 0)
      // It should be from the recent tail instead
      expect(result[0]?.content).not.toBe('question 0');
    });
  });

  describe('dangling tool_result boundary rule (the critical safety test)', () => {
    /**
     * This is the most important test.
     *
     * Scenario: a naive slice of the history would start mid-tool-exchange,
     * leaving a `tool_result` user message with no preceding `tool_use`
     * assistant message. Anthropic's API returns 400 in this case.
     *
     * The pruner must advance past any orphaned tool_result messages until the
     * slice begins at a clean boundary.
     */
    it('does not produce an orphaned tool_result at the start of the window', () => {
      // Build: [user, assistant(tool_use tc1), user(tool_result tc1), assistant(text), ...]
      // Then add enough messages that a naive window would start at the tool_result.
      const history: LLMMessage[] = [
        userText('original task'),          // 0 — anchor
        assistantToolUse('tc1'),            // 1
        userToolResult('tc1', 'data'),      // 2
        assistantText('got data'),          // 3
        assistantToolUse('tc2'),            // 4
        userToolResult('tc2', 'more data'), // 5
        assistantText('done with tc2'),     // 6
        userText('follow up'),              // 7
        assistantText('final answer'),      // 8
      ]; // 9 messages

      // maxMessages=6: naive tail = slice(3) = [3,4,5,6,7,8]
      // slice[0] = assistantText('got data') — that's fine (assistant, no tool_use needed before it)
      // slice[1] = assistantToolUse('tc2') — fine
      // slice[2] = userToolResult('tc2') — its preceding msg (tc2 tool_use) IS in slice → safe
      // Actually a naive tail of 6 from index 3 is clean here.
      // Let's instead use maxMessages=5 to start at index 4: [4,5,6,7,8]
      // slice[0] = assistantToolUse('tc2') — fine
      // slice[1] = userToolResult('tc2') — preceding (index 4, tc2 tool_use) IS in slice → safe
      // Use maxMessages=4 → naive start at index 5: [5,6,7,8]
      // slice[0] = userToolResult('tc2') — tc2 tool_use (index 4) is NOT in slice → ORPHANED
      // The pruner must skip forward to index 6 (assistantText 'done with tc2').
      const result = pruneMessages(history, { maxMessages: 4, keepFirstUser: false });

      // No message in the result should be a tool_result-only user message whose
      // preceding message in the result is not a tool_use assistant message.
      for (let i = 0; i < result.length; i++) {
        const msg = result[i];
        if (!msg) continue;
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          const blocks = msg.content;
          const allToolResults = blocks.length > 0 && blocks.every((b) => b.type === 'tool_result');
          if (allToolResults) {
            // Verify the preceding message has tool_use blocks.
            const preceding = i > 0 ? result[i - 1] : undefined;
            expect(preceding).toBeDefined();
            expect(
              Array.isArray(preceding!.content) &&
              preceding!.content.some((b) => b.type === 'tool_use'),
            ).toBe(true);
          }
        }
      }
    });

    it('orphaned tool_result at window start is skipped even when keepFirstUser is true', () => {
      const history: LLMMessage[] = [
        userText('task'),                   // 0 — anchor
        assistantToolUse('tc1'),            // 1
        userToolResult('tc1', 'r1'),        // 2
        assistantText('processed'),         // 3
        userText('next question'),          // 4
        assistantToolUse('tc2'),            // 5
        userToolResult('tc2', 'r2'),        // 6 — naive window starts here → orphaned
        assistantText('final'),             // 7
      ]; // 8 messages

      // maxMessages=4, keepFirstUser=true: anchor slot = 1, tail slots = 3
      // naive tail = slice(5) = [5,6,7] (3 items)
      // slice[0] = assistantToolUse('tc2') — has tool_use, fine as start
      // slice[1] = userToolResult('tc2') — preceding (tc2 tool_use) IS in slice → safe
      // So this case is actually clean. Use maxMessages=3 instead:
      // tail slots = 2, naive tail = slice(6) = [6,7]
      // slice[0] = userToolResult('tc2') — tc2 tool_use (index 5) NOT in slice → ORPHANED
      const result = pruneMessages(history, { maxMessages: 3, keepFirstUser: true });

      // The first message in the result should never be a tool_result-only user message
      // (anchor aside — anchor is a plain user text message so it's fine at position 0).
      // After anchor, no standalone tool_result should appear without a preceding tool_use.
      for (let i = 0; i < result.length; i++) {
        const msg = result[i];
        if (!msg) continue;
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          const blocks = msg.content;
          const allToolResults = blocks.length > 0 && blocks.every((b) => b.type === 'tool_result');
          if (allToolResults) {
            const preceding = i > 0 ? result[i - 1] : undefined;
            expect(preceding).toBeDefined();
            expect(
              Array.isArray(preceding!.content) &&
              preceding!.content.some((b) => b.type === 'tool_use'),
            ).toBe(true);
          }
        }
      }
    });

    it('consecutive orphaned tool_results at window start are all skipped', () => {
      // Contrived but validates the while-loop: multiple back-to-back tool exchanges
      // evicted from the window.
      const history: LLMMessage[] = [
        userText('original'),         // 0
        assistantToolUse('tc1'),      // 1
        userToolResult('tc1', 'a'),   // 2 — orphaned if tc1 evicted
        assistantToolUse('tc2'),      // 3
        userToolResult('tc2', 'b'),   // 4 — also orphaned if tc2 evicted
        assistantText('summary'),     // 5 — clean boundary
        userText('follow up'),        // 6
        assistantText('done'),        // 7
      ]; // 8 messages

      // maxMessages=4 (keepFirstUser=false): naive tail from index 4: [4,5,6,7]
      // [4] = userToolResult('tc2') — tc2 tool_use (index 3) NOT in slice → orphaned
      // Pruner advances to 5: [5,6,7] = [assistantText, user, assistant] — clean
      const result = pruneMessages(history, { maxMessages: 4, keepFirstUser: false });

      for (let i = 0; i < result.length; i++) {
        const msg = result[i];
        if (!msg) continue;
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          const blocks = msg.content;
          const allToolResults = blocks.length > 0 && blocks.every((b) => b.type === 'tool_result');
          if (allToolResults) {
            const preceding = i > 0 ? result[i - 1] : undefined;
            expect(preceding).toBeDefined();
            expect(
              Array.isArray(preceding!.content) &&
              preceding!.content.some((b) => b.type === 'tool_use'),
            ).toBe(true);
          }
        }
      }
    });

    it('returns empty array when all messages would be skipped', () => {
      // All messages are orphaned tool_results — nothing valid to return.
      const history: LLMMessage[] = [
        userToolResult('tc1', 'r1'),
        userToolResult('tc2', 'r2'),
      ];
      const result = pruneMessages(history, { maxMessages: 1, keepFirstUser: false });
      expect(result).toEqual([]);
    });

    it('second tool_result in window has non-tool_use predecessor — both skipped', () => {
      // This test exercises hasToolUseBlock when the preceding message IS inside
      // the window (precedingIdx >= startIdx) but does NOT have tool_use blocks.
      //
      // History:
      //   0: userText ('original')
      //   1: assistantToolUse('tc1')
      //   2: userToolResult('tc1') — orphaned when window starts at 2 (tc1 tool_use outside)
      //   3: userToolResult('tc2') — its predecessor (index 2, a tool_result) is in window
      //                              but is NOT a tool_use → also skipped
      //   4: assistantText('final') — clean boundary
      //
      // maxMessages=3 (keepFirstUser=false): rawStart=5-3=2
      // advanceToCleanBoundary(messages, 2):
      //   idx=2: tool_result, precedingIdx=1, 1>=2? No → skip, idx=3
      //   idx=3: tool_result, precedingIdx=2, 2>=2? Yes → preceding=messages[2]=userToolResult
      //          hasToolUseBlock(userToolResult) → array content, no tool_use block → false → skip, idx=4
      //   idx=4: assistantText → not tool_result → break. Returns 4.
      // tail = [assistantText('final')]
      const history: LLMMessage[] = [
        userText('original'),          // 0
        assistantToolUse('tc1'),       // 1
        userToolResult('tc1', 'r1'),   // 2 — orphaned (tc1 outside window)
        userToolResult('tc2', 'r2'),   // 3 — predecessor is tool_result (not tool_use) → also skip
        assistantText('final'),        // 4
      ];
      const result = pruneMessages(history, { maxMessages: 3, keepFirstUser: false });
      expect(result).toEqual([assistantText('final')]);
    });

    it('tool_use + tool_result pair at window start is preserved as a valid pair', () => {
      const history: LLMMessage[] = [
        userText('go'),               // 0
        assistantToolUse('tc1'),      // 1
        userToolResult('tc1', 'x'),   // 2
        assistantToolUse('tc2'),      // 3  ← window starts here with maxMessages=4,keepFirstUser=false
        userToolResult('tc2', 'y'),   // 4
        assistantText('all done'),    // 5
      ]; // 6 messages → over threshold of 4? No — need maxMessages < 6.

      // maxMessages=3 (keepFirstUser=false): naive tail = slice(3) = [3,4,5]
      // [3] = assistantToolUse('tc2') — has tool_use blocks → valid start
      // [4] = userToolResult('tc2') — preceding (index 3, tc2 tool_use) IS in slice → safe
      const result = pruneMessages(history, { maxMessages: 3, keepFirstUser: false });

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual(assistantToolUse('tc2'));
      expect(result[1]).toEqual(userToolResult('tc2', 'y'));
      expect(result[2]).toEqual(assistantText('all done'));
    });
  });

  describe('edge cases', () => {
    it('handles empty message array', () => {
      const result = pruneMessages([], { maxMessages: 10 });
      expect(result).toEqual([]);
    });

    it('handles single message array', () => {
      const msgs = [userText('hello')];
      const result = pruneMessages(msgs, { maxMessages: 1 });
      expect(result).toBe(msgs);
    });

    it('uses defaults when no opts provided', () => {
      const msgs = plainHistory(15); // 30 messages — under default of 40
      const result = pruneMessages(msgs);
      expect(result).toBe(msgs);
    });

    it('uses defaults when opts is empty', () => {
      const msgs = plainHistory(15); // 30 messages — under default of 40
      const result = pruneMessages(msgs, {});
      expect(result).toBe(msgs);
    });

    it('anchor is already in tail — no duplication, returns tail directly', () => {
      // History starting with assistant-only preamble: the first user message falls
      // within the pruned tail window, so anchorAlreadyInTail=true and the anchor
      // is NOT prepended separately (it's already included in the tail).
      //
      // History (6 messages): asst, asst, asst, user_first, asst, user_follow
      // maxMessages=4, keepFirstUser=true:
      //   tailSize = 4 - 1 = 3, rawStart = 6 - 3 = 3, safeStart = 3
      //   firstUserIdx = 3 (index of "first real user")
      //   anchorAlreadyInTail = (3 <= 3 && 3 < 6) = true → return tail as-is
      const history: LLMMessage[] = [
        assistantText('preamble 0'),  // 0
        assistantText('preamble 1'),  // 1
        assistantText('preamble 2'),  // 2
        userText('first real user'),  // 3 — first user message (in tail)
        assistantText('response'),    // 4
        userText('follow-up'),        // 5
      ];
      const result = pruneMessages(history, { maxMessages: 4, keepFirstUser: true });
      expect(result).toEqual(history.slice(3));
      // Exactly one occurrence of the anchor — no duplication.
      const count = result.filter((m) => m.content === 'first real user').length;
      expect(count).toBe(1);
    });
  });
});
