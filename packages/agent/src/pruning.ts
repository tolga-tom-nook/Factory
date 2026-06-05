/**
 * Rolling-window context pruning for the Agent Runtime.
 *
 * Long-running sessions accumulate an unbounded `messages` array that will
 * eventually overflow the model's context window and inflate cost. This module
 * provides a stateless sliding-window function that slices the history before
 * each `complete()` call while preserving provider validity.
 *
 * ## Tool-pair safety invariant
 * Anthropic's API returns HTTP 400 if a `tool_result` block appears in the
 * message history without a matching preceding `tool_use` block. A naive
 * head-of-window slice can orphan these pairs if it starts mid-exchange. This
 * module detects and heals that condition by advancing the window start forward
 * until the slice begins at a clean boundary (a plain text `assistant` message
 * or a plain text `user` message).
 *
 * ## Future work
 * Token-count-based windowing and LLM-assisted summarisation of evicted turns
 * are planned but not required for V1. Message-count windowing is sufficient
 * until a session reliably exceeds the provider's context limit.
 */

import type { LLMMessage } from '@latimer-woods-tech/llm';

/**
 * Options controlling the rolling-window pruning behaviour.
 *
 * @example
 * ```ts
 * pruneMessages(messages, { maxMessages: 20, keepFirstUser: true });
 * ```
 */
export interface PruneOptions {
  /**
   * Maximum number of messages to send to the LLM. Includes the anchored
   * first-user message when `keepFirstUser` is true.
   * @default 40
   */
  maxMessages?: number;
  /**
   * When true (default) the very first `user` message in the original history
   * is prepended to the pruned window. This preserves the original task
   * description across many turns so the model does not lose its goal.
   * @default true
   */
  keepFirstUser?: boolean;
}

/**
 * Returns true when a message carries exclusively `tool_result` content blocks
 * — i.e. it is the `user` turn that returns results back to the model after a
 * `tool_use` assistant turn.
 */
function isToolResultMessage(msg: LLMMessage): boolean {
  if (typeof msg.content === 'string') return false;
  const blocks = msg.content;
  return blocks.length > 0 && blocks.every((b) => b.type === 'tool_result');
}

/**
 * Returns true when a message carries at least one `tool_use` content block —
 * i.e. it is an `assistant` turn that requested tool execution.
 *
 * This helper is only called from {@link advanceToCleanBoundary} on messages
 * that are already confirmed to have array content (the caller always checks
 * `isToolResultMessage` first, which gates on array content, ensuring the
 * predecessor passed here will never carry a raw string).
 */
function hasToolUseBlock(msg: LLMMessage): boolean {
  return Array.isArray(msg.content) && msg.content.some((b) => b.type === 'tool_use');
}

/**
 * Advance `startIdx` forward until the slice `[startIdx, messages.length)`
 * begins at a clean provider boundary.
 *
 * A `tool_result`-only user message is orphaned when its paired `tool_use`
 * assistant message is NOT present at `startIdx - 1` within the window.
 * Since we are building `messages[startIdx..]`, a preceding message at
 * `startIdx - 1` must be inside the window (`>= startIdx`) or be the message
 * immediately before the window. The rule is: the `tool_use` that pairs with
 * `messages[startIdx]` (a `tool_result`) must appear at exactly `startIdx - 1`
 * AND must be within the slice (i.e., the slice starts at or before it).
 *
 * Because we are advancing `idx` from `startIdx`, the invariant simplifies to:
 * if `messages[idx]` is a `tool_result`-only user message and `messages[idx-1]`
 * is NOT a `tool_use` assistant message *within the window* (i.e., `idx-1 >= startIdx`
 * does not hold — we are at the very start, so `idx-1 < idx`, meaning the
 * tool_use was evicted), skip `idx` forward.
 *
 * Concretely: at each candidate `idx`, check whether `idx - 1 >= startIdx` and
 * whether `messages[idx-1]` has a `tool_use` block. If either condition fails
 * while `messages[idx]` is a tool_result turn, it is orphaned — advance.
 */
function advanceToCleanBoundary(messages: LLMMessage[], startIdx: number): number {
  let idx = startIdx;
  while (idx < messages.length) {
    const msg = messages[idx];
    if (!msg) break;
    // A tool_result-only user message is orphaned when the tool_use
    // assistant message that precedes it is NOT inside the window.
    // "Inside the window" means the predecessor is at idx-1 AND idx-1 >= startIdx
    // (i.e., the predecessor was not evicted as part of the same slicing operation).
    // After the first advance, startIdx stays fixed and idx grows, so a
    // predecessor at idx-1 where idx-1 >= startIdx is safely inside the window.
    if (isToolResultMessage(msg)) {
      const precedingIdx = idx - 1;
      const preceding = precedingIdx >= startIdx ? messages[precedingIdx] : undefined;
      if (!preceding || !hasToolUseBlock(preceding)) {
        // Orphaned tool_result — skip it.
        idx++;
        continue;
      }
    }
    break;
  }
  return idx;
}

/**
 * Prune a message history to a rolling window that is safe to send to the LLM.
 *
 * The function is **pure** (no mutation) and **stateless** — it is called on
 * every loop turn with the full accumulated history and returns the slice to
 * pass to `complete()`. The caller's `messages` array is never modified.
 *
 * ### Behaviour
 * - If `messages.length <= maxMessages` the input array is returned as-is.
 * - Otherwise, the most recent `maxMessages` messages (minus the anchor slot
 *   when `keepFirstUser` is true) are kept.
 * - If `keepFirstUser` is `true` (default) the first `user` message in the
 *   original history is prepended to the pruned tail, giving the model a stable
 *   anchor for the original task.
 * - After slicing, the window start is advanced forward past any orphaned
 *   `tool_result` messages whose matching `tool_use` was evicted — preventing
 *   Anthropic 400 errors.
 *
 * ### What this does NOT do (V1 scope)
 * - It does not estimate token counts. A message-count window is sufficient
 *   until a session reliably exceeds the provider's token limit. Token-aware
 *   windowing is a planned enhancement.
 * - It does not summarise evicted turns. LLM-assisted summarisation is a
 *   planned enhancement for sessions where task continuity across many turns
 *   matters more than keeping the raw history.
 *
 * @param messages - The full accumulated message history.
 * @param opts - Window size and anchor options.
 * @returns A pruned copy of the message array, safe to pass to `complete()`.
 */
export function pruneMessages(messages: LLMMessage[], opts: PruneOptions = {}): LLMMessage[] {
  const maxMessages = opts.maxMessages ?? 40;
  const keepFirstUser = opts.keepFirstUser ?? true;

  // Fast path: no pruning needed.
  if (messages.length <= maxMessages) return messages;

  // Find the first user message for anchoring (before we slice).
  const firstUserIdx = keepFirstUser
    ? messages.findIndex((m) => m.role === 'user')
    : -1;
  const firstUserMsg = firstUserIdx !== -1 ? messages[firstUserIdx] : undefined;

  // How many tail messages we can keep (leave one slot for the anchor when used).
  const tailSize = keepFirstUser && firstUserMsg !== undefined
    ? maxMessages - 1
    : maxMessages;

  // Compute where the raw tail starts.
  const rawStart = messages.length - tailSize;

  // Advance past any orphaned tool_result at the start of the window.
  const safeStart = advanceToCleanBoundary(messages, rawStart);

  const tail = messages.slice(safeStart);

  if (!keepFirstUser || firstUserMsg === undefined) {
    return tail;
  }

  // Prepend anchor only if it is not already the first message in the tail
  // (which happens when the first-user message itself falls within the tail).
  const anchorAlreadyInTail =
    safeStart <= firstUserIdx && firstUserIdx < messages.length;

  if (anchorAlreadyInTail) {
    return tail;
  }

  return [firstUserMsg, ...tail];
}
