/**
 * Guardrails — defensive wrappers around agent input and tool output.
 *
 * Two attack surfaces in a tool-calling loop:
 *
 *  1. **Prompt injection in user input** — a crafted user message that attempts
 *     to override system instructions or impersonate the assistant.
 *  2. **Prompt injection via tool results** — a malicious tool response that
 *     plants instructions the model treats as system-level (the "indirect
 *     injection" class, e.g. "<SYSTEM> ignore previous instructions").
 *
 * Guardrails here are intentionally conservative: they reject or strip
 * suspicious patterns rather than trying to "understand" intent. False
 * positives are safer than missed injections in a tool-calling context.
 *
 * All functions are **pure** (no I/O) and operate on strings, so they can be
 * tested exhaustively without mocking. They throw `GuardrailError` on
 * violations; callers decide whether to surface the error to the user or
 * silently skip the message.
 */

import { ValidationError } from '@latimer-woods-tech/errors';

// ─── Error type ────────────────────────────────────────────────────────────

/** Thrown when a guardrail rejects content. Always a 400-class response. */
export class GuardrailError extends ValidationError {
  /** Which guardrail fired. */
  readonly rule: string;

  constructor(rule: string, detail?: string) {
    super(`guardrail:${rule}${detail ? ` — ${detail}` : ''}`);
    this.rule = rule;
  }
}

// ─── Injection patterns ───────────────────────────────────────────────────

/**
 * Patterns that indicate a prompt-injection attempt. The list is intentionally
 * tight — only patterns with very low false-positive rates are included. The
 * spec calls out "tool-result quarantine" explicitly; these patterns target
 * content that could coerce model behaviour from within a tool response.
 */
const INJECTION_PATTERNS: ReadonlyArray<{ rule: string; pattern: RegExp }> = [
  // Classic "ignore previous instructions" variants
  { rule: 'ignore_instructions', pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i },
  // System-prompt overrides via delimiters
  { rule: 'system_delimiter', pattern: /<\s*(?:SYSTEM|SYS|INST|HUMAN|AI|ASSISTANT|USER)\s*>/i },
  // Jailbreak prefix patterns
  { rule: 'jailbreak_prefix', pattern: /\[(?:DAN|JAILBREAK|OVERRIDE|SUDO|ROOT|ADMIN)\]/i },
  // "You are now X" persona overrides (high-signal in tool results)
  { rule: 'persona_override', pattern: /you\s+are\s+now\s+(?:a|an|the)\s+(?:helpful|evil|unrestricted|jailbroken)/i },
  // Instruction injection via fake separators
  { rule: 'fake_separator', pattern: /^[-=]{20,}\s*(END|STOP|IGNORE|NEW)\s*[-=]{10,}$/im },
];

// ─── Length limits ─────────────────────────────────────────────────────────

/** Maximum acceptable user message length in characters. */
export const MAX_USER_MESSAGE_CHARS = 32_000;

/** Maximum acceptable tool result payload in characters. */
export const MAX_TOOL_RESULT_CHARS = 64_000;

// ─── Core checks ──────────────────────────────────────────────────────────

/**
 * Checks a string for prompt-injection patterns.
 * Returns the matching rule name, or `null` if clean.
 */
export function detectInjection(text: string): string | null {
  for (const { rule, pattern } of INJECTION_PATTERNS) {
    if (pattern.test(text)) return rule;
  }
  return null;
}

/**
 * Validates a user message before it enters the agent loop.
 * Throws {@link GuardrailError} on violation.
 */
export function assertCleanUserMessage(content: string): void {
  if (content.length > MAX_USER_MESSAGE_CHARS) {
    throw new GuardrailError('user_message_too_long', `${content.length} chars > ${MAX_USER_MESSAGE_CHARS}`);
  }
  const hit = detectInjection(content);
  if (hit !== null) {
    throw new GuardrailError(hit, 'injection pattern in user message');
  }
}

/**
 * Validates a tool result before it is appended to the conversation.
 * Throws {@link GuardrailError} on violation; callers should convert the
 * result to an `is_error: true` tool_result block rather than propagating the
 * exception to the user.
 *
 * Quarantine model (from the spec): tool results are **untrusted data**, not
 * instructions. They may contain user-controlled content (e.g. a document
 * fetched from a URL the user provided). Injection patterns in a tool result
 * are treated as a hostile tool, not a model failure.
 */
export function assertCleanToolResult(toolName: string, result: string): void {
  if (result.length > MAX_TOOL_RESULT_CHARS) {
    throw new GuardrailError('tool_result_too_long', `${toolName}: ${result.length} chars > ${MAX_TOOL_RESULT_CHARS}`);
  }
  const hit = detectInjection(result);
  if (hit !== null) {
    throw new GuardrailError(hit, `injection pattern in ${toolName} result`);
  }
}

/**
 * Truncates a tool result to `MAX_TOOL_RESULT_CHARS` with a trailing marker,
 * rather than throwing. Use when the caller prefers a degraded result over an
 * error (e.g. a large web page fetch that just needs to be trimmed).
 */
export function truncateToolResult(result: string, limit = MAX_TOOL_RESULT_CHARS): string {
  if (result.length <= limit) return result;
  return `${result.slice(0, limit - 80)}\n[truncated: result exceeded ${limit} chars]`;
}
