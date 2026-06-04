/**
 * Reasoning loop — the core of the Agent Runtime.
 *
 * Drives a multi-turn LLM conversation with tool-calling:
 *  1. Call `complete({ tools: registry.llmTools(tier) })`
 *  2. If `stopReason === 'tool_use'` → execute each requested tool, append
 *     `tool_result` blocks, loop back to step 1.
 *  3. If `stopReason === 'end'`, max turns reached, or total budget exceeded
 *     → return the accumulated `AgentResult`.
 *
 * Budget is enforced per-turn (`opts.maxCostUsdPerTurn`) and in aggregate
 * (`opts.maxTotalCostUsd`). The loop is fully synchronous from the caller's
 * perspective: tool invocations are awaited in order before the next LLM turn.
 */

import {
  complete,
  type LLMContentBlock,
  type LLMEnv,
  type LLMMessage,
  type LLMOptions,
  type LLMResult,
  type LLMTool,
  type LLMToolCall,
} from '@latimer-woods-tech/llm';
import { type Tool, type ToolRegistry } from './registry.js';

/** Outcome of a single tool invocation within a loop turn. */
export interface ToolCallReceipt {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result: { ok: true; result: unknown } | { ok: false; error: string };
  durationMs: number;
}

/** Turn = one LLM call + zero-or-more tool executions. */
export interface AgentTurn {
  turn: number;
  llmResult: LLMResult;
  receipts: ToolCallReceipt[];
  costUsd: number;
}

/** Reason the loop stopped. */
export type StopReason =
  | 'end'          // model produced a final text response
  | 'max_turns'    // loop ceiling reached
  | 'budget'       // cumulative cost exceeded maxTotalCostUsd
  | 'tool_error';  // a tool returned ok:false and opts.stopOnToolError is true

/** Final result returned to the caller. */
export interface AgentResult {
  content: string;
  stopReason: StopReason;
  turns: AgentTurn[];
  totalCostUsd: number;
  totalTurns: number;
}

export interface AgentLoopOptions {
  /** LLM environment bindings (AI Gateway + provider keys). */
  env: LLMEnv;
  /** Tool registry scoped to the session. */
  registry: ToolRegistry;
  /** Trust tier controlling which tools are offered to the model. */
  tier?: 'green' | 'yellow' | 'red';
  /** Maximum number of LLM turns before the loop stops. Default 10. */
  maxTurns?: number;
  /** Hard per-turn cost cap in USD passed to `complete()`. Default $0.10. */
  maxCostUsdPerTurn?: number;
  /** Hard total cost cap in USD across all turns. Default $1.00. */
  maxTotalCostUsd?: number;
  /** Stop the loop when any tool invocation returns `ok: false`. Default false. */
  stopOnToolError?: boolean;
  /** LLM options forwarded to `complete()` (tier, model, system, etc.). */
  llmOpts?: Omit<LLMOptions, 'tools' | 'toolChoice' | 'maxCostUsd'>;
  /** Optional injectable deps for testing (fetch, now). */
  deps?: Parameters<typeof complete>[3];
}

/**
 * Estimate the cost of an `LLMResult` in USD.
 * Uses `@lwt/llm`'s public formula: (input + cacheRead + output) tokens × per-MTok rate.
 * We accept `NaN`/`undefined` gracefully — cost tracking is best-effort and must
 * never block a turn.
 */
function estimateTurnCost(r: LLMResult): number {
  // llm package exposes estimateCostUsd only via the result's token field;
  // we approximate using the tokens already computed and attached to LLMResult.
  // A 0-cost result is safe: it just delays budget enforcement by one turn.
  const { input = 0, output = 0, cacheRead = 0 } = r.tokens;
  // Sonnet (default balanced tier) as a conservative fallback: $3/$15/$0.30 per MTok.
  // The real cost is captured by @lwt/llm-meter if wired; this estimate gates looping only.
  const rateIn = 3.0;
  const rateOut = 15.0;
  const rateCacheRead = 0.3;
  const billableIn = Math.max(0, input - cacheRead);
  return (billableIn * rateIn + cacheRead * rateCacheRead + output * rateOut) / 1_000_000;
}

/** Converts a Tool to the LLMTool shape (drops the `invoke` fn). */
function toLLMTool(t: Tool): LLMTool {
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters ?? { type: 'object', properties: {} },
  };
}

/**
 * Execute a single tool call and return a structured receipt.
 * Tool errors are captured (never thrown) so the loop decides whether to stop.
 */
async function executeToolCall(
  call: LLMToolCall,
  registry: ToolRegistry,
): Promise<ToolCallReceipt> {
  const start = Date.now();
  const tool = registry.get(call.name);
  if (!tool) {
    return {
      id: call.id,
      name: call.name,
      arguments: call.arguments,
      result: { ok: false, error: `Tool not found: ${call.name}` },
      durationMs: 0,
    };
  }
  try {
    const result = await tool.invoke(call.arguments);
    return { id: call.id, name: call.name, arguments: call.arguments, result, durationMs: Date.now() - start };
  } catch (e) {
    return {
      id: call.id,
      name: call.name,
      arguments: call.arguments,
      result: { ok: false, error: e instanceof Error ? e.message : String(e) },
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Converts tool-call receipts to `tool_result` content blocks so they can be
 * appended to the message history for the next LLM turn.
 */
function receiptsToResultBlocks(receipts: ToolCallReceipt[]): LLMContentBlock[] {
  return receipts.map((r) => ({
    type: 'tool_result' as const,
    tool_use_id: r.id,
    content: r.result.ok
      ? typeof r.result.result === 'string'
        ? r.result.result
        : JSON.stringify(r.result.result)
      : `Error: ${r.result.error}`,
    is_error: !r.result.ok,
  }));
}

/**
 * Runs the agent reasoning loop.
 *
 * @example
 * ```ts
 * const result = await runLoop(
 *   [{ role: 'user', content: 'Which users are on the free tier?' }],
 *   { env, registry, tier: 'green', maxTurns: 6 },
 * );
 * console.log(result.content, result.totalCostUsd);
 * ```
 */
export async function runLoop(
  initialMessages: LLMMessage[],
  opts: AgentLoopOptions,
): Promise<AgentResult> {
  const maxTurns = opts.maxTurns ?? 10;
  const maxCostUsdPerTurn = opts.maxCostUsdPerTurn ?? 0.10;
  const maxTotalCostUsd = opts.maxTotalCostUsd ?? 1.00;
  const stopOnToolError = opts.stopOnToolError ?? false;

  const exposedTools = opts.registry.llmTools(opts.tier).map(toLLMTool);
  const messages: LLMMessage[] = [...initialMessages];
  const turns: AgentTurn[] = [];
  let totalCostUsd = 0;
  let lastContent = '';

  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await complete(
      messages,
      opts.env,
      {
        ...opts.llmOpts,
        tools: exposedTools.length > 0 ? exposedTools : undefined,
        maxCostUsd: maxCostUsdPerTurn,
      },
      opts.deps,
    );

    if (res.error !== null || res.data === null) {
      // LLM failure — return what we have with the last content.
      return {
        content: lastContent,
        stopReason: 'end',
        turns,
        totalCostUsd,
        totalTurns: turn,
      };
    }

    const llmResult = res.data;
    lastContent = llmResult.content || lastContent;
    const turnCost = estimateTurnCost(llmResult);
    totalCostUsd += turnCost;

    // Append assistant turn to history (with tool_use blocks if present).
    const assistantContent: LLMContentBlock[] | string =
      llmResult.toolCalls && llmResult.toolCalls.length > 0
        ? [
            ...(llmResult.content ? [{ type: 'text' as const, text: llmResult.content }] : []),
            ...llmResult.toolCalls.map((tc) => ({
              type: 'tool_use' as const,
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            })),
          ]
        : llmResult.content;
    messages.push({ role: 'assistant', content: assistantContent });

    // Execute tool calls and append results.
    let receipts: ToolCallReceipt[] = [];
    if (llmResult.stopReason === 'tool_use' && llmResult.toolCalls && llmResult.toolCalls.length > 0) {
      receipts = await Promise.all(
        llmResult.toolCalls.map((tc) => executeToolCall(tc, opts.registry)),
      );
      messages.push({ role: 'user', content: receiptsToResultBlocks(receipts) });
    }

    turns.push({ turn, llmResult, receipts, costUsd: turnCost });

    // --- Stop conditions ---
    if (llmResult.stopReason === 'end' || llmResult.stopReason === 'max_tokens') {
      return { content: lastContent, stopReason: 'end', turns, totalCostUsd, totalTurns: turn + 1 };
    }
    if (totalCostUsd >= maxTotalCostUsd) {
      return { content: lastContent, stopReason: 'budget', turns, totalCostUsd, totalTurns: turn + 1 };
    }
    if (stopOnToolError && receipts.some((r) => !r.result.ok)) {
      return { content: lastContent, stopReason: 'tool_error', turns, totalCostUsd, totalTurns: turn + 1 };
    }
  }

  return { content: lastContent, stopReason: 'max_turns', turns, totalCostUsd, totalTurns: maxTurns };
}
