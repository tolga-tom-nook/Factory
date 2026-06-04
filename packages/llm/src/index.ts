import {
  InternalError,
  RateLimitError,
  ValidationError,
  toErrorResponse,
  type FactoryResponse,
} from '@latimer-woods-tech/errors';
import type { Logger } from '@latimer-woods-tech/logger';

/**
 * A tool the model may call. `parameters` is a JSON Schema object describing
 * the tool's input. Provider-agnostic; normalized per provider at request time.
 */
export interface LLMTool {
  name: string;
  description?: string;
  /** JSON Schema for the tool's input arguments. */
  parameters: Record<string, unknown>;
}

/**
 * A tool invocation requested by the model, normalized across providers.
 */
export interface LLMToolCall {
  /** Provider-assigned call id; echo it back in the matching tool_result. */
  id: string;
  name: string;
  /** Parsed argument object the model passed to the tool. */
  arguments: Record<string, unknown>;
}

/**
 * Structured content block for tool-calling conversations. The field shapes
 * mirror the Anthropic Messages wire format so they pass through unchanged.
 */
export type LLMContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

/**
 * Single chat message exchanged with an LLM provider.
 *
 * `content` is a plain string in the common case. For tool-calling
 * conversations it may be an array of {@link LLMContentBlock}s (e.g. an
 * assistant turn carrying `tool_use` blocks, or a user turn carrying
 * `tool_result` blocks). Providers that don't support tool-calling receive
 * the text projection of the content (see `contentToText`).
 */
export interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | LLMContentBlock[];
}

/**
 * Flattens message content to plain text for providers/paths that only handle
 * strings. `tool_use` blocks contribute nothing; `tool_result` blocks
 * contribute their textual content.
 */
function contentToText(content: string | LLMContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? b.content : ''))
    .join('');
}

/**
 * Resolves the system prompt: explicit `opts.system` wins, else the first
 * `system` message, flattened to text. Returns `undefined` when neither is set.
 */
function systemText(opts: LLMOptions, messages: LLMMessage[]): string | undefined {
  if (opts.system !== undefined) return opts.system;
  const c = messages.find((m) => m.role === 'system')?.content;
  return c === undefined ? undefined : contentToText(c);
}

/**
 * Quality tier selected by the caller. Routing is workload-split:
 *  - `fast`      → Grok 4.3 with Anthropic Haiku fallback (routine drafts/small jobs)
 *  - `balanced`  → Anthropic Sonnet (default)
 *  - `smart`     → Anthropic Opus OR Gemini 2.5 Pro if input is long-context (>150k tokens estimated)
 *  - `verifier`  → Groq Llama (cheap second opinion; only used from verifier code path)
 *  - `workbench` → DeepSeek Chat with Groq fallback (boring, reviewable, non-sensitive batch work)
 */
export type LLMTier = 'fast' | 'balanced' | 'smart' | 'verifier' | 'workbench';

/**
 * Options that influence LLM completion behaviour.
 */
export interface LLMOptions {
  /** Quality tier; see {@link LLMTier}. Defaults to `balanced`. */
  tier?: LLMTier;
  /** Explicit model override. Takes precedence over tier. */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  system?: string;
  /** Token budget above which we force long-context routing (Gemini). */
  longContextThreshold?: number;
  /** Per-call cancellation signal. Aborts the in-flight provider request. */
  signal?: AbortSignal;
  /** Optional run identifier stamped on ledger rows + logs. */
  runId?: string;
  /** Optional project identifier stamped on ledger rows + logs. */
  project?: string;
  /** Optional actor identifier (supervisor / worker / human). */
  actor?: string;
  /** Optional workload label used in logs and cost-policy call sites. */
  workload?: string;
  /** Grok reasoning effort. Defaults to `none` for cost-controlled fast/draft calls. */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  /** Anthropic prompt-cache control. Defaults to `true` for `system` prompts ≥ 1024 tokens. */
  promptCache?: boolean;
  /**
   * Maximum estimated cost in USD for this completion.
   * This cap is enforced after the provider returns because it uses actual
   * response token counts to compute the final cost.
   * If the post-call estimated cost exceeds this cap, `complete` returns a
   * {@link RateLimitError} with code `LLM_COST_CAP_EXCEEDED` and
   * `completionStream` throws the same error.
   * Pricing is based on {@link MODEL_PRICE_PER_1M}; unknown models default to
   * Opus rates (conservative upper bound).
   */
  maxCostUsd?: number;
  /**
   * Org-level daily cost cap in USD. Requires `env.LLM_COST_KV` to be set.
   * When today's cumulative spend read from KV is >= this value, `complete`
   * returns a {@link RateLimitError} with code `LLM_DAILY_CAP_EXCEEDED`
   * without making any provider call. After a successful call the daily
   * accumulator is updated in KV (TTL: 48 h).
   */
  dailyCapUsd?: number;
  /**
   * Org-level monthly cost cap in USD. Requires `env.LLM_COST_KV` to be set.
   * Same enforcement pattern as {@link dailyCapUsd} but keyed by YYYY-MM.
   * KV TTL: 40 days.
   */
  monthlyCapUsd?: number;
  /**
   * Metering context. When supplied and `deps.onRecord` is set, a {@link LLMRecordRow}
   * is emitted after every successful completion. Errors are swallowed.
   */
  ledger?: LLMRecordContext;
  /**
   * Tools the model may call. When present, routing **fails closed** to
   * tool-capable providers — failover never falls back to a provider that
   * can't honour the tool schema. See {@link LLMResult.toolCalls}.
   */
  tools?: LLMTool[];
  /**
   * Tool-selection policy. `'auto'` (default when `tools` is set) lets the
   * model decide; `'none'` forbids tool use; `{ name }` forces a specific tool.
   */
  toolChoice?: 'auto' | 'none' | { name: string };
}

/**
 * Provider that produced an LLM response.
 */
export type LLMProvider = 'anthropic' | 'gemini' | 'groq' | 'grok' | 'deepseek';

/**
 * Result returned by a successful completion.
 */
export interface LLMResult {
  content: string;
  provider: LLMProvider;
  model: string;
  tier: LLMTier;
  tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  latency: number;
  /** Number of attempts before success (1 = primary succeeded). */
  attempts: number;
  /** Monotonic request id from AI Gateway, if present in headers. */
  gatewayRequestId?: string;
  /**
   * Why generation stopped, normalized across providers. `'tool_use'` means
   * the model is requesting one or more tool calls (see {@link toolCalls}).
   */
  stopReason?: 'end' | 'tool_use' | 'max_tokens' | 'other';
  /**
   * Tool calls the model requested, normalized across providers. Present
   * (non-empty) when `stopReason === 'tool_use'`.
   */
  toolCalls?: LLMToolCall[];
}

/**
 * Environment bindings required by {@link complete}.
 *
 * `AI_GATEWAY_BASE_URL` is REQUIRED in 0.3.0. All provider calls flow through the
 * Cloudflare AI Gateway for unified logging, rate limiting, and cost telemetry.
 * In test/dev the caller may pass a custom fetch impl that short-circuits this.
 */
export interface LLMEnv {
  AI_GATEWAY_BASE_URL: string;
  ANTHROPIC_API_KEY: string;
  GROQ_API_KEY: string;
  /** Optional — only required for `{ tier: 'workbench' }` or `deepseek-*` model overrides. */
  DEEPSEEK_API_KEY?: string;
  /** Optional — only required when caller passes `{ model: 'grok-*' }` override. */
  GROK_API_KEY?: string;
  /**
   * Google Cloud short-lived access token with `aiplatform.endpoints.predict`.
   * Callers mint this via the JWT-bearer flow (service account → token exchange);
   * see `docs/runbooks/rotate-gcp-sa.md`. Token must be valid for ≥ 5 minutes.
   */
  VERTEX_ACCESS_TOKEN: string;
  VERTEX_PROJECT: string;
  VERTEX_LOCATION: string;
  /**
   * Optional KV store for org-level daily/monthly cost tracking and enforcement.
   * When provided alongside {@link LLMOptions.dailyCapUsd} or {@link LLMOptions.monthlyCapUsd},
   * `complete` will block calls that would exceed the declared cap.
   * Any KV-like store satisfying `get`/`put` works (e.g. Cloudflare KV, in-memory stub).
   */
  LLM_COST_KV?: CostKvStore;
}

/**
 * Minimal KV store interface for org-level LLM cost tracking.
 * Cloudflare KV satisfies this. An in-memory stub is sufficient for tests.
 */
export interface CostKvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/**
 * Caller-supplied context stamped on every metering row.
 * Mirrors the `LLMRecordContext` in `@latimer-woods-tech/llm-meter`; kept inline
 * to avoid a circular dependency (llm-meter imports llm).
 */
export interface LLMRecordContext {
  project: string;
  actor: string;
  runId?: string;
  workload?: string;
  tenantId?: string;
}

/**
 * Row shape passed to the optional {@link LLMDeps.onRecord} callback.
 * Callers can wire this directly to `recordCall` from `@latimer-woods-tech/llm-meter`.
 */
export interface LLMRecordRow extends LLMRecordContext {
  model: string;
  provider: LLMProvider;
  tier: LLMTier;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
  costUsd: number;
  yyyyMm: string;
}

/**
 * Optional dependencies for {@link complete}.
 */
export interface LLMDeps {
  fetch?: typeof fetch;
  logger?: Logger;
  now?: () => number;
  /**
   * Optional metering callback. Called after every successful completion.
   * Errors are swallowed so metering never blocks the caller.
   * Wire to `recordCall` from `@latimer-woods-tech/llm-meter`.
   */
  onRecord?: (row: LLMRecordRow) => Promise<void>;
}

// Model catalogue — keep in sync with docs/architecture/FACTORY_V1.md § LLM substrate.
const MODELS = {
  anthropic: {
    fast: 'claude-haiku-4-20250514',
    balanced: 'claude-sonnet-4-6',
    smart: 'claude-opus-4-7',
  },
  gemini: {
    smart: 'gemini-2.5-pro',
  },
  groq: {
    verifier: 'llama-4-maverick',
  },
  grok: {
    fast: 'grok-4.3',
  },
  deepseek: {
    workbench: 'deepseek-chat',
  },
} as const;

const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_LONG_CONTEXT_THRESHOLD = 150_000; // tokens

// ─── Per-provider exponential backoff constants ────────────────────────────
/** Base delay in ms for the first retry. */
const BACKOFF_BASE_MS = 500;
/** Maximum backoff cap in ms. */
const BACKOFF_CAP_MS = 8_000;
/** Max random jitter added to each backoff delay, in ms. */
const BACKOFF_JITTER_MAX_MS = 250;
/** Maximum number of attempts per provider (1 initial + 2 retries). */
const PER_PROVIDER_MAX_ATTEMPTS = 3;

// ─── Per-provider cooldown state (module-level) ────────────────────────────
/**
 * Tracks when a provider's cooldown period expires.
 * Keyed by {@link LLMProvider}; value is the `Date.now()` epoch ms at which
 * the cooldown expires. Absent key means "not cooling down".
 */
const providerCooldownUntil: Map<LLMProvider, number> = new Map();

/** Cooldown duration in ms after a provider exhausts all retries. */
const PROVIDER_COOLDOWN_MS = 30_000;

/**
 * Returns `true` if the provider is currently in its cooldown window.
 * Uses the injected `now` function (or `Date.now`) for testability.
 */
function isProviderCoolingDown(provider: LLMProvider, now: () => number = Date.now): boolean {
  const until = providerCooldownUntil.get(provider);
  if (until === undefined) return false;
  return now() < until;
}

/** Returns `YYYY-MM-DD` from a Unix timestamp (ms). Used for daily KV cost keys. */
function isoDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Record actual call spend in org-level daily/monthly KV buckets.
 * This is intentionally best-effort: Cloudflare KV does not provide an atomic
 * compare-and-swap, so concurrent requests can race and undercount spend.
 */
async function recordOrgCostUsage(
  kv: CostKvStore,
  todayKey: string,
  monthKey: string,
  costUsd: number,
  opts: LLMOptions,
): Promise<void> {
  if (opts.dailyCapUsd !== undefined) {
    const raw = await kv.get(todayKey).catch(() => null);
    const spent = parseFloat(raw ?? '0');
    await kv.put(todayKey, String(spent + costUsd), { expirationTtl: 172_800 /* 48 h */ }).catch(() => undefined);
  }
  if (opts.monthlyCapUsd !== undefined) {
    const raw = await kv.get(monthKey).catch(() => null);
    const spent = parseFloat(raw ?? '0');
    await kv.put(monthKey, String(spent + costUsd), { expirationTtl: 3_456_000 /* 40 d */ }).catch(() => undefined);
  }
}

/**
 * USD cost per 1 million tokens for each model.
 * Source: Anthropic / Google / xAI pricing pages as of 2026-05.
 * Keep these model names in sync with the default routing constants in
 * {@link MODELS}; unknown models fall back to Opus rates (conservative upper bound).
 *
 * CANONICAL pricing source for the platform. `@latimer-woods-tech/llm-meter`
 * derives its cents-denominated rates from this table and a drift-guard test
 * there fails CI if they diverge — make all rate changes here.
 */
export const MODEL_PRICE_PER_1M: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  // Anthropic Haiku 4
  'claude-haiku-4-20250514': { input: 0.80, output: 4.00, cacheRead: 0.08, cacheWrite: 1.00 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00, cacheRead: 0.08, cacheWrite: 1.00 },
  // Anthropic Sonnet 4
  'claude-sonnet-4-20250514': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  // Anthropic Opus 4
  'claude-opus-4-20250514': { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
  'claude-opus-4-7': { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
  // Gemini 2.5 Pro
  'gemini-2.5-pro': { input: 1.25, output: 10.00, cacheRead: 0.31, cacheWrite: 4.50 },
  // Groq Llama 4 Maverick
  'llama-4-maverick': { input: 0.50, output: 0.77, cacheRead: 0.05, cacheWrite: 0.50 },
  // Grok 4.3
  'grok-4.3': { input: 1.25, output: 2.50, cacheRead: 0.00, cacheWrite: 0.00 },
  // DeepSeek API pricing as of 2026-05: cache-write conservatively uses cache-miss input pricing.
  'deepseek-chat': { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0.27 },
  'deepseek-reasoner': { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 },
  // Deprecated aliases retained for historical ledger rows.
  'grok-4-fast': { input: 1.25, output: 2.50, cacheRead: 0.00, cacheWrite: 0.00 },
  'grok-3-mini-latest': { input: 1.25, output: 2.50, cacheRead: 0.00, cacheWrite: 0.00 },
};

/** Fallback pricing used for unrecognised models (Opus rates — conservative upper bound). */
const PRICE_FALLBACK = MODEL_PRICE_PER_1M['claude-opus-4-7']!;

/**
 * Estimates the USD cost of a single LLM completion from token counts.
 * Returns 0 for zero-token results. Uses {@link MODEL_PRICE_PER_1M} with
 * {@link PRICE_FALLBACK} for unknown models.
 */
function estimateCostUsd(
  tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
  model: string,
): number {
  const price = MODEL_PRICE_PER_1M[model] ?? PRICE_FALLBACK;
  return (
    (tokens.input * price.input +
      tokens.output * price.output +
      (tokens.cacheRead ?? 0) * price.cacheRead +
      (tokens.cacheWrite ?? 0) * price.cacheWrite) /
    1_000_000
  );
}

/** Returns `YYYY-MM` from a Unix timestamp (ms). Used for monthly KV cost keys. */
function isoMonth(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

/**
 * Marks a provider as cooling down for {@link PROVIDER_COOLDOWN_MS} milliseconds.
 */
function markProviderCoolingDown(provider: LLMProvider, now: () => number = Date.now): void {
  providerCooldownUntil.set(provider, now() + PROVIDER_COOLDOWN_MS);
}

/**
 * Clears the cooldown state for a provider after a successful call.
 */
function clearProviderCooldown(provider: LLMProvider): void {
  providerCooldownUntil.delete(provider);
}

// ─── Legacy backoff constant (kept for the existing callWithBackoff signature) ─
const BASE_BACKOFF_MS = 250;

interface ProviderError {
  provider: LLMProvider;
  status: number;
  retryable: boolean;
  message: string;
}

/**
 * Returns `true` for status codes that should trigger a retry.
 * Only 429 and 5xx (transient server errors) qualify; other 4xx are terminal.
 */
function isRetryableForBackoff(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function estimateTokens(messages: LLMMessage[], system?: string): number {
  // Cheap estimator: ~4 chars/token. Good enough for threshold routing.
  let chars = system?.length ?? 0;
  for (const m of messages) chars += contentToText(m.content).length;
  return Math.ceil(chars / 4);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Computes the exponential backoff delay for a given attempt with jitter.
 *
 * Formula: `Math.min(base * 2^attempt + jitter, cap)`
 * where `jitter` is a random value in `[0, BACKOFF_JITTER_MAX_MS)`.
 *
 * @param attempt - Zero-based attempt index (0 = first retry after initial failure).
 */
function computeBackoffMs(attempt: number): number {
  const jitter = Math.floor(Math.random() * BACKOFF_JITTER_MAX_MS);
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt) + jitter, BACKOFF_CAP_MS);
}

// ─── Provider request builders ─────────────────────────────────────────────

function buildAnthropicRequest(
  model: string,
  messages: LLMMessage[],
  opts: LLMOptions,
  env: LLMEnv,
  streaming = false,
): { url: string; headers: Record<string, string>; body: string } {
  const sys = systemText(opts, messages);
  const filtered = messages.filter((m) => m.role !== 'system');
  const body: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
    messages: filtered.map((m) => ({ role: m.role, content: m.content })),
  };
  if (streaming) {
    body.stream = true;
  }
  if (sys) {
    const cache = opts.promptCache ?? sys.length >= 4096;
    body.system = cache
      ? [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }]
      : sys;
  }
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.parameters,
    }));
    const tc = opts.toolChoice ?? 'auto';
    body.tool_choice =
      tc === 'auto'
        ? { type: 'auto' }
        : tc === 'none'
          ? { type: 'none' }
          : { type: 'tool', name: tc.name };
  }
  return {
    url: `${env.AI_GATEWAY_BASE_URL}/anthropic/v1/messages`,
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
    },
    body: JSON.stringify(body),
  };
}

function buildGeminiRequest(
  model: string,
  messages: LLMMessage[],
  opts: LLMOptions,
  env: LLMEnv,
): { url: string; headers: Record<string, string>; body: string } {
  const sys = systemText(opts, messages);
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: contentToText(m.content) }],
    }));
  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      maxOutputTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
    },
  };
  if (sys) {
    body.systemInstruction = { parts: [{ text: sys }] };
  }
  const path = `v1/projects/${env.VERTEX_PROJECT}/locations/${env.VERTEX_LOCATION}/publishers/google/models/${model}:generateContent`;
  return {
    url: `${env.AI_GATEWAY_BASE_URL}/google-vertex-ai/${path}`,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.VERTEX_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  };
}

// ─── OpenAI-style (Grok / DeepSeek / Groq) tool-calling helpers ──────────────

/**
 * Converts provider-agnostic messages to OpenAI chat-completions format,
 * translating the Anthropic-shaped tool blocks: `tool_use` → an assistant
 * message with `tool_calls`; `tool_result` → a standalone `tool` message keyed
 * by `tool_call_id`. Plain-string content passes through unchanged.
 */
function toOpenAiMessages(messages: LLMMessage[], sys: string | undefined): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (sys) out.push({ role: 'system', content: sys });
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    let text = '';
    const toolCalls: Array<Record<string, unknown>> = [];
    const results: Array<{ tool_use_id: string; content: string }> = [];
    for (const b of m.content) {
      if (b.type === 'text') text += b.text;
      else if (b.type === 'tool_use')
        toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } });
      else if (b.type === 'tool_result') results.push({ tool_use_id: b.tool_use_id, content: b.content });
    }
    if (results.length > 0) {
      for (const r of results) out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: r.content });
      if (text) out.push({ role: 'user', content: text });
    } else if (toolCalls.length > 0) {
      out.push({ role: 'assistant', content: text || null, tool_calls: toolCalls });
    } else {
      out.push({ role: m.role, content: text });
    }
  }
  return out;
}

/** Builds the OpenAI `tools` array from {@link LLMOptions.tools}, or undefined. */
function openAiTools(opts: LLMOptions): Array<Record<string, unknown>> | undefined {
  if (!opts.tools || opts.tools.length === 0) return undefined;
  return opts.tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description ?? '', parameters: t.parameters },
  }));
}

/** Maps {@link LLMOptions.toolChoice} to the OpenAI `tool_choice` value. */
function openAiToolChoice(tc: LLMOptions['toolChoice']): unknown {
  if (tc === undefined) return undefined;
  if (tc === 'auto' || tc === 'none') return tc;
  return { type: 'function', function: { name: tc.name } };
}

function buildGroqRequest(
  model: string,
  messages: LLMMessage[],
  opts: LLMOptions,
  env: LLMEnv,
): { url: string; headers: Record<string, string>; body: string } {
  const sys = systemText(opts, messages);
  const merged: LLMMessage[] = [];
  if (sys) merged.push({ role: 'system', content: sys });
  for (const m of messages) if (m.role !== 'system') merged.push({ role: m.role, content: contentToText(m.content) });
  return {
    url: `${env.AI_GATEWAY_BASE_URL}/groq/openai/v1/chat/completions`,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
      messages: merged,
    }),
  };
}

function buildGrokRequest(
  model: string,
  messages: LLMMessage[],
  opts: LLMOptions,
  env: LLMEnv,
): { url: string; headers: Record<string, string>; body: string } {
  if (!env.GROK_API_KEY) {
    throw new ValidationError('GROK_API_KEY required for grok-* model override');
  }
  const sys = systemText(opts, messages);
  const body: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
    messages: toOpenAiMessages(messages, sys),
  };
  const tools = openAiTools(opts);
  if (tools) {
    body.tools = tools;
    const tc = openAiToolChoice(opts.toolChoice ?? 'auto');
    if (tc !== undefined) body.tool_choice = tc;
  }
  if (model === MODELS.grok.fast) {
    body.reasoning_effort = opts.reasoningEffort ?? 'none';
  }
  return {
    url: `${env.AI_GATEWAY_BASE_URL}/grok/v1/chat/completions`,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.GROK_API_KEY}`,
    },
    body: JSON.stringify(body),
  };
}

function buildDeepSeekRequest(
  model: string,
  messages: LLMMessage[],
  opts: LLMOptions,
  env: LLMEnv,
): { url: string; headers: Record<string, string>; body: string } {
  if (!env.DEEPSEEK_API_KEY) {
    throw new ValidationError('DEEPSEEK_API_KEY required for workbench tier or deepseek-* model override');
  }
  const sys = systemText(opts, messages);
  const body: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
    messages: toOpenAiMessages(messages, sys),
  };
  const tools = openAiTools(opts);
  if (tools) {
    body.tools = tools;
    const tc = openAiToolChoice(opts.toolChoice ?? 'auto');
    if (tc !== undefined) body.tool_choice = tc;
  }
  return {
    url: `${env.AI_GATEWAY_BASE_URL}/deepseek/chat/completions`,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify(body),
  };
}

// ─── Response parsers ──────────────────────────────────────────────────────

interface AnthropicResponse {
  content?: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  model?: string;
}

/** Maps a provider stop reason to the normalized {@link LLMResult.stopReason}. */
function normalizeAnthropicStop(reason: string | undefined): LLMResult['stopReason'] {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    default:
      return reason ? 'other' : undefined;
  }
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

interface GroqResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

function parseAnthropic(
  json: unknown,
): {
  content: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  model?: string;
  toolCalls?: LLMToolCall[];
  stopReason?: LLMResult['stopReason'];
} {
  const r = json as AnthropicResponse;
  const toolCalls: LLMToolCall[] = (r.content ?? [])
    .filter((c) => c.type === 'tool_use' && typeof c.id === 'string' && typeof c.name === 'string')
    .map((c) => ({ id: c.id!, name: c.name!, arguments: c.input ?? {} }));
  return {
    content: r.content?.find((c) => c.type === 'text')?.text ?? '',
    input: r.usage?.input_tokens ?? 0,
    output: r.usage?.output_tokens ?? 0,
    cacheRead: r.usage?.cache_read_input_tokens ?? 0,
    cacheWrite: r.usage?.cache_creation_input_tokens ?? 0,
    model: r.model,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    stopReason: normalizeAnthropicStop(r.stop_reason),
  };
}

function parseGemini(json: unknown): { content: string; input: number; output: number } {
  const r = json as GeminiResponse;
  const text =
    r.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  return {
    content: text,
    input: r.usageMetadata?.promptTokenCount ?? 0,
    output: r.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

function parseGroq(json: unknown): { content: string; input: number; output: number; model?: string } {
  const r = json as GroqResponse;
  return {
    content: r.choices?.[0]?.message?.content ?? '',
    input: r.usage?.prompt_tokens ?? 0,
    output: r.usage?.completion_tokens ?? 0,
    model: r.model,
  };
}

interface OpenAiResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

/** Maps an OpenAI `finish_reason` to the normalized {@link LLMResult.stopReason}. */
function normalizeOpenAiStop(reason: string | undefined): LLMResult['stopReason'] {
  switch (reason) {
    case 'stop':
      return 'end';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    default:
      return reason ? 'other' : undefined;
  }
}

/** Best-effort parse of an OpenAI tool-call arguments string; `{}` on failure. */
function parseToolArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Parses an OpenAI chat-completions response (Grok, DeepSeek), extracting
 * normalized tool calls and a stop reason in addition to text + tokens.
 */
function parseOpenAi(json: unknown): {
  content: string;
  input: number;
  output: number;
  model?: string;
  toolCalls?: LLMToolCall[];
  stopReason?: LLMResult['stopReason'];
} {
  const r = json as OpenAiResponse;
  const choice = r.choices?.[0];
  const toolCalls: LLMToolCall[] = (choice?.message?.tool_calls ?? [])
    .filter((c) => typeof c.function?.name === 'string')
    .map((c, i) => ({
      id: c.id ?? `call_${i}`,
      name: c.function!.name!,
      arguments: parseToolArgs(c.function?.arguments),
    }));
  return {
    content: choice?.message?.content ?? '',
    input: r.usage?.prompt_tokens ?? 0,
    output: r.usage?.completion_tokens ?? 0,
    model: r.model,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    stopReason: normalizeOpenAiStop(choice?.finish_reason),
  };
}

// ─── Core call with backoff ────────────────────────────────────────────────

/**
 * Calls a provider with per-provider exponential backoff.
 *
 * Retries up to {@link PER_PROVIDER_MAX_ATTEMPTS} times on 429 or transient 5xx.
 * Other 4xx codes are treated as terminal and not retried.
 * AbortError is never retried — it bubbles immediately.
 *
 * @param provider - Provider name, used for error tagging.
 * @param request - Pre-built HTTP request descriptor.
 * @param fetchImpl - Fetch implementation (injectable for tests).
 * @param signal - Optional AbortSignal for cancellation.
 * @param logger - Optional logger for per-attempt warnings.
 * @param nowFn - Optional clock injection for testability.
 * @returns Parsed JSON body, optional AI Gateway request ID, and attempt count.
 */
async function callWithBackoff(
  provider: LLMProvider,
  request: { url: string; headers: Record<string, string>; body: string },
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  logger: Logger | undefined,
  nowFn?: () => number,
): Promise<{ json: unknown; gatewayRequestId?: string; attempts: number }> {
  /**
   * Helper: mark provider cooling down and then throw the error.
   * Called whenever we determine we've exhausted all retries for the provider.
   * AbortError is never counted as a provider exhaustion — it bypasses this.
   */
  function exhaustAndThrow(err: ProviderError): never {
    markProviderCoolingDown(provider, nowFn ?? Date.now);
    throw err;
  }

  let lastErr: ProviderError | undefined;
  for (let attempt = 1; attempt <= PER_PROVIDER_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const retryable = isRetryableForBackoff(response.status);
        const err: ProviderError = {
          provider,
          status: response.status,
          retryable,
          message: `${provider} ${String(response.status)}: ${text.slice(0, 300)}`,
        };
        logger?.warn?.('llm.provider.error', { provider, status: response.status, attempt });
        if (!err.retryable || attempt === PER_PROVIDER_MAX_ATTEMPTS) {
          if (err.retryable) exhaustAndThrow(err); // retryable but exhausted
          throw err; // terminal non-retryable error — no cooldown
        }
        lastErr = err;
      } else {
        const gatewayRequestId = response.headers.get('cf-aig-request-id') ?? undefined;
        clearProviderCooldown(provider);
        return { json: await response.json(), gatewayRequestId, attempts: attempt };
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      if (typeof e === 'object' && e !== null && 'retryable' in e) {
        const err = e as ProviderError;
        if (!err.retryable || attempt === PER_PROVIDER_MAX_ATTEMPTS) {
          if (err.retryable) exhaustAndThrow(err); // retryable but exhausted
          throw err; // terminal — no cooldown
        }
        lastErr = err;
      } else {
        const err: ProviderError = {
          provider,
          status: 0,
          retryable: true,
          message: e instanceof Error ? e.message : String(e),
        };
        if (attempt === PER_PROVIDER_MAX_ATTEMPTS) exhaustAndThrow(err);
        lastErr = err;
      }
    }
    // Exponential backoff with jitter: base=500ms, cap=8000ms, jitter up to 250ms
    const backoffMs = computeBackoffMs(attempt - 1);
    await sleep(backoffMs, signal);
  }
  // Fallthrough — should not be reached, but mark cooling down defensively.
  markProviderCoolingDown(provider, nowFn ?? Date.now);
  throw lastErr ?? ({ provider, status: 0, retryable: false, message: 'exhausted' } as ProviderError);
}

function isProviderError(err: unknown): err is ProviderError {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { status?: unknown }).status === 'number' &&
    typeof (err as { message?: unknown }).message === 'string' &&
    typeof (err as { provider?: unknown }).provider === 'string'
  );
}

// ─── Routing ───────────────────────────────────────────────────────────────

interface RoutePlan {
  primary: { provider: LLMProvider; model: string };
  fallback?: { provider: LLMProvider; model: string };
}

/**
 * Providers whose request builder + response parser support tool-calling.
 * When `opts.tools` is set, routing is restricted to this set and **fails
 * closed** rather than silently calling a provider that would ignore the
 * tools. Expanded in 1b as the other providers' tool formats are normalized.
 */
const TOOL_CAPABLE_PROVIDERS = new Set<LLMProvider>(['anthropic', 'grok', 'deepseek']);

function plan(tier: LLMTier, opts: LLMOptions, tokenEstimate: number): RoutePlan {
  if (opts.model) {
    // Explicit override — best-effort provider detection.
    const m = opts.model;
    if (m.startsWith('claude')) return { primary: { provider: 'anthropic', model: m } };
    if (m.startsWith('gemini')) return { primary: { provider: 'gemini', model: m } };
    if (m.startsWith('grok')) return { primary: { provider: 'grok', model: m } };
    if (m.startsWith('deepseek')) return { primary: { provider: 'deepseek', model: m } };
    return { primary: { provider: 'groq', model: m } };
  }
  const longContext = tokenEstimate >= (opts.longContextThreshold ?? DEFAULT_LONG_CONTEXT_THRESHOLD);
  switch (tier) {
    case 'workbench':
      return {
        primary: { provider: 'deepseek', model: MODELS.deepseek.workbench },
        fallback: { provider: 'groq', model: MODELS.groq.verifier },
      };
    case 'verifier':
      return { primary: { provider: 'groq', model: MODELS.groq.verifier } };
    case 'smart':
      return longContext
        ? {
            primary: { provider: 'gemini', model: MODELS.gemini.smart },
            fallback: { provider: 'anthropic', model: MODELS.anthropic.smart },
          }
        : {
            primary: { provider: 'anthropic', model: MODELS.anthropic.smart },
            fallback: { provider: 'gemini', model: MODELS.gemini.smart },
          };
    case 'fast':
      return {
        primary: { provider: 'grok', model: MODELS.grok.fast },
        fallback: { provider: 'anthropic', model: MODELS.anthropic.fast },
      };
    case 'balanced':
    default:
      return longContext
        ? {
            primary: { provider: 'gemini', model: MODELS.gemini.smart },
            fallback: { provider: 'anthropic', model: MODELS.anthropic.balanced },
          }
        : {
            primary: { provider: 'anthropic', model: MODELS.anthropic.balanced },
            fallback: { provider: 'gemini', model: MODELS.gemini.smart },
          };
  }
}

/**
 * Build the `cf-aig-metadata` header value for the Cloudflare AI Gateway.
 *
 * Carries caller attribution (project / workload / actor / runId) so a single
 * shared gateway can be sliced per-app and per-feature in the AI Gateway
 * dashboard and logs. This replaces the per-app-gateway convention: rather than
 * one gateway per app (which has to be provisioned and silently 401s when it
 * isn't), one gateway tags every request with who made it.
 *
 * Returns `undefined` when no attribution fields are set (header omitted).
 * The CF AI Gateway accepts a JSON object of string/number/boolean values.
 */
function buildAigMetadata(opts: LLMOptions): string | undefined {
  const meta: Record<string, string> = {};
  if (opts.project) meta.project = opts.project;
  if (opts.workload) meta.workload = opts.workload;
  if (opts.actor) meta.actor = opts.actor;
  if (opts.runId) meta.runId = opts.runId;
  return Object.keys(meta).length > 0 ? JSON.stringify(meta) : undefined;
}

async function callOne(
  leg: { provider: LLMProvider; model: string },
  messages: LLMMessage[],
  opts: LLMOptions,
  env: LLMEnv,
  fetchImpl: typeof fetch,
  logger: Logger | undefined,
  nowFn?: () => number,
): Promise<{ parsed: { content: string; input: number; output: number; cacheRead?: number; cacheWrite?: number; model?: string; toolCalls?: LLMToolCall[]; stopReason?: LLMResult['stopReason'] }; gatewayRequestId?: string; attempts: number }> {
  let req: { url: string; headers: Record<string, string>; body: string };
  switch (leg.provider) {
    case 'anthropic':
      req = buildAnthropicRequest(leg.model, messages, opts, env);
      break;
    case 'gemini':
      req = buildGeminiRequest(leg.model, messages, opts, env);
      break;
    case 'groq':
      req = buildGroqRequest(leg.model, messages, opts, env);
      break;
    case 'grok':
      req = buildGrokRequest(leg.model, messages, opts, env);
      break;
    case 'deepseek':
      req = buildDeepSeekRequest(leg.model, messages, opts, env);
      break;
  }
  // Attribution for the shared AI Gateway — one gateway, sliced per-app/feature.
  const aigMetadata = buildAigMetadata(opts);
  if (aigMetadata) req.headers['cf-aig-metadata'] = aigMetadata;
  const { json, gatewayRequestId, attempts } = await callWithBackoff(
    leg.provider,
    req,
    fetchImpl,
    opts.signal,
    logger,
    nowFn,
  );
  switch (leg.provider) {
    case 'anthropic':
      return { parsed: parseAnthropic(json), gatewayRequestId, attempts };
    case 'gemini':
      return { parsed: parseGemini(json), gatewayRequestId, attempts };
    case 'groq':
      return { parsed: parseGroq(json), gatewayRequestId, attempts };
    case 'grok':
      return { parsed: parseOpenAi(json), gatewayRequestId, attempts };
    case 'deepseek':
      return { parsed: parseOpenAi(json), gatewayRequestId, attempts };
  }
}

/**
 * Run a completion through the routing plan for the requested tier.
 *
 * Routing summary (0.3.0):
 *   - `fast`     → Grok 4.3; Anthropic Haiku fallback when Grok is unavailable
 *   - `balanced` → Anthropic Sonnet; Gemini 2.5 Pro if `longContextThreshold` exceeded
 *   - `smart`    → Anthropic Opus; Gemini 2.5 Pro if long-context
 *   - `verifier` → Groq Llama 3.3 70B (no fallback — verifier is inherently cheap/best-effort)
 *   - `workbench` → DeepSeek Chat; Groq fallback for boring/reviewable internal batch jobs
 *
 * All provider traffic flows through Cloudflare AI Gateway at `AI_GATEWAY_BASE_URL`.
 *
 * Per-provider reliability guarantees (0.4.0):
 *   - Exponential backoff with jitter on 429 / 5xx (base 500ms, cap 8s, up to 2 retries).
 *   - Provider cooldown: after exhausting retries the provider is marked cooling down
 *     for 30 seconds; subsequent calls skip it and go straight to the fallback leg.
 *
 * @param messages - Ordered chat history.
 * @param env - API key + gateway bindings.
 * @param opts - Optional tier/model/parameters override.
 * @param deps - Optional fetch/logger/clock injection (for testing).
 * @returns A {@link FactoryResponse} carrying either an {@link LLMResult} or
 *   an error (`LLM_ALL_PROVIDERS_FAILED`, `LLM_RATE_LIMITED`, or `INTERNAL_ERROR`).
 */
export async function complete(
  messages: LLMMessage[],
  env: LLMEnv,
  opts: LLMOptions = {},
  deps: LLMDeps = {},
): Promise<FactoryResponse<LLMResult>> {
  if (messages.length === 0) {
    throw new ValidationError('messages must not be empty');
  }
  if (!env.AI_GATEWAY_BASE_URL) {
    throw new ValidationError('AI_GATEWAY_BASE_URL is required in 0.3.0');
  }
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const logger = deps.logger;
  const startedAt = now();

  const tier: LLMTier = opts.tier ?? 'balanced';
  const system = systemText(opts, messages);
  const tokenEstimate = estimateTokens(messages, system);
  const route = plan(tier, opts, tokenEstimate);

  // ── Org-level daily / monthly cap pre-check ──────────────────────────────
  const kv = env.LLM_COST_KV;
  const todayKey = `llm:daily-cost:${isoDate(now())}`;
  const monthKey = `llm:monthly-cost:${isoMonth(now())}`;
  if (kv) {
    if (opts.dailyCapUsd !== undefined) {
      const raw = await kv.get(todayKey).catch(() => null);
      const spent = parseFloat(raw ?? '0');
      if (spent >= opts.dailyCapUsd) {
        return toErrorResponse(
          new RateLimitError('LLM_DAILY_CAP_EXCEEDED', {
            spentUsd: spent,
            dailyCapUsd: opts.dailyCapUsd,
          }),
        );
      }
    }
    if (opts.monthlyCapUsd !== undefined) {
      const raw = await kv.get(monthKey).catch(() => null);
      const spent = parseFloat(raw ?? '0');
      if (spent >= opts.monthlyCapUsd) {
        return toErrorResponse(
          new RateLimitError('LLM_MONTHLY_CAP_EXCEEDED', {
            spentUsd: spent,
            monthlyCapUsd: opts.monthlyCapUsd,
          }),
        );
      }
    }
  }

  const attemptLog: Array<{ provider: LLMProvider; status?: number; message: string }> = [];

  let routeLegs = [route.primary, route.fallback].filter(Boolean) as Array<{ provider: LLMProvider; model: string }>;
  // Tool-calling fails closed: never fall back to a provider that can't honour
  // the tool schema. Narrow the route to tool-capable providers when tools are set.
  if (opts.tools && opts.tools.length > 0) {
    routeLegs = routeLegs.filter((l) => TOOL_CAPABLE_PROVIDERS.has(l.provider));
    if (routeLegs.length === 0) {
      throw new ValidationError(
        `tool-calling requires a tool-capable provider (${[...TOOL_CAPABLE_PROVIDERS].join(', ')}); tier '${tier}' has none — use tier fast/balanced/smart or a claude-* model override`,
      );
    }
  }
  for (const [legIndex, leg] of routeLegs.entries()) {
    // Skip providers that are currently in their cooldown window.
    if (isProviderCoolingDown(leg.provider, now)) {
      logger?.warn?.('llm.provider.coolingDown', { provider: leg.provider });
      attemptLog.push({ provider: leg.provider, message: 'skipped: cooling down' });
      continue;
    }
    if (opts.signal?.aborted) {
      return toErrorResponse(
        new InternalError('llm call aborted', { provider: leg.provider, model: leg.model }),
      );
    }
    try {
      const result = await callOne(leg, messages, opts, env, fetchImpl, logger, now);
      // A tool_use turn legitimately has no text content — only treat a
      // genuinely empty response (no text AND no tool calls) as a failure.
      if (!result.parsed.content && !(result.parsed.toolCalls && result.parsed.toolCalls.length > 0)) {
        throw { provider: leg.provider, status: 200, retryable: false, message: 'empty content' } satisfies ProviderError;
      }
      logger?.info?.('llm.complete', {
        provider: leg.provider,
        model: leg.model,
        tier,
        tokenEstimate,
        attempts: result.attempts,
        runId: opts.runId,
        project: opts.project,
        actor: opts.actor,
        workload: opts.workload,
      });
      const llmResult: LLMResult = {
        content: result.parsed.content,
        provider: leg.provider,
        model: result.parsed.model ?? leg.model,
        tier,
        tokens: {
          input: result.parsed.input,
          output: result.parsed.output,
          cacheRead: result.parsed.cacheRead,
          cacheWrite: result.parsed.cacheWrite,
        },
        latency: now() - startedAt,
        attempts: result.attempts,
        gatewayRequestId: result.gatewayRequestId,
        stopReason: result.parsed.stopReason,
        toolCalls: result.parsed.toolCalls,
      };
      const costUsd = estimateCostUsd(llmResult.tokens, llmResult.model);
      if (opts.maxCostUsd !== undefined && costUsd > opts.maxCostUsd) {
        if (kv && (opts.dailyCapUsd !== undefined || opts.monthlyCapUsd !== undefined)) {
          await recordOrgCostUsage(kv, todayKey, monthKey, costUsd, opts);
        }
        return toErrorResponse(
          new RateLimitError('LLM_COST_CAP_EXCEEDED', {
            costUsd,
            maxCostUsd: opts.maxCostUsd,
            model: llmResult.model,
            tokens: llmResult.tokens,
          }),
        );
      }
      // ── Update org-level cost accumulators in KV ─────────────────────────
      // The KV writes are best-effort. Cloudflare KV does not support atomic
      // compare-and-swap, so concurrent increments may undercount spend.
      if (kv && (opts.dailyCapUsd !== undefined || opts.monthlyCapUsd !== undefined)) {
        await recordOrgCostUsage(kv, todayKey, monthKey, costUsd, opts);
      }
      // ── Metering callback ────────────────────────────────────────────────
      if (deps.onRecord && opts.ledger) {
        const row: LLMRecordRow = {
          ...opts.ledger,
          model: llmResult.model,
          provider: llmResult.provider,
          tier: llmResult.tier,
          inputTokens: llmResult.tokens.input,
          outputTokens: llmResult.tokens.output,
          cacheReadTokens: llmResult.tokens.cacheRead ?? 0,
          cacheWriteTokens: llmResult.tokens.cacheWrite ?? 0,
          latencyMs: llmResult.latency,
          costUsd,
          yyyyMm: isoMonth(now()),
        };
        deps.onRecord(row).catch((e: unknown) => {
          logger?.warn?.('llm.onRecord.error', { message: e instanceof Error ? e.message : String(e) });
        });
      }
      return { data: llmResult, error: null };
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        return toErrorResponse(
          new InternalError('llm call aborted', { provider: leg.provider, model: leg.model }),
        );
      }
      if (isProviderError(e)) {
        attemptLog.push({ provider: e.provider, status: e.status, message: e.message });
        if (e.status === 429 && legIndex === routeLegs.length - 1) {
          return toErrorResponse(
            new RateLimitError(`llm rate limited on ${e.provider}`, { attempts: attemptLog }),
          );
        }
        logger?.warn?.('llm.leg.failed', { provider: leg.provider, status: e.status });
        continue;
      }
      attemptLog.push({ provider: leg.provider, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return toErrorResponse(
    new InternalError('LLM_ALL_PROVIDERS_FAILED', { attempts: attemptLog, tier, tokenEstimate }),
  );
}

// ─── Streaming ────────────────────────────────────────────────────────────

/**
 * Anthropic server-sent event shapes used by the streaming parser.
 * Only the fields we consume are typed; the rest are ignored.
 */
interface AnthropicStreamEvent {
  type: string;
  index?: number;
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  content_block?: { type?: string; id?: string; name?: string };
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    model?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

/**
 * Streams a completion from the primary Anthropic provider, yielding text chunks
 * as they arrive. Falls back to the non-streaming {@link complete} function when
 * the provider does not support streaming (i.e. a non-Anthropic primary is selected).
 *
 * The generator's **return value** (accessible via `gen.return()` or by consuming
 * the full iteration) is an {@link LLMResult} with the same shape as {@link complete}.
 *
 * Usage pattern:
 * ```ts
 * const gen = completionStream(messages, env, opts);
 * for await (const chunk of gen) {
 *   // stream chunk to client
 * }
 * const result = (await gen.return(undefined)).value; // LLMResult
 * ```
 *
 * @param messages - Ordered chat history.
 * @param env - API key + gateway bindings.
 * @param opts - Optional tier/model/parameters override. Accepts `deps` as nested field.
 * @returns An async generator that yields `string` chunks and returns an {@link LLMResult}.
 */
export async function* completionStream(
  messages: LLMMessage[],
  env: LLMEnv,
  opts: LLMOptions & { deps?: LLMDeps } = {},
): AsyncGenerator<string, LLMResult, unknown> {
  if (messages.length === 0) {
    throw new ValidationError('messages must not be empty');
  }
  if (!env.AI_GATEWAY_BASE_URL) {
    throw new ValidationError('AI_GATEWAY_BASE_URL is required in 0.3.0');
  }

  const deps: LLMDeps = opts.deps ?? {};
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const logger = deps.logger;
  const startedAt = now();

  const tier: LLMTier = opts.tier ?? 'balanced';
  const system = systemText(opts, messages);
  const tokenEstimate = estimateTokens(messages, system);
  const route = plan(tier, opts, tokenEstimate);
  const streamLeg =
    route.primary.provider === 'grok' && !env.GROK_API_KEY && route.fallback?.provider === 'anthropic'
      ? route.fallback
      : route.primary;

  // Only Anthropic supports streaming in the current implementation.
  // For all other primaries, fall back to non-streaming complete().
  if (streamLeg.provider !== 'anthropic') {
    const result = await complete(messages, env, opts, deps);
    if (result.error !== null || result.data === null) {
      throw new InternalError('LLM_ALL_PROVIDERS_FAILED', { error: result.error });
    }
    yield result.data.content;
    return result.data;
  }

  // Check cooldown before attempting the streaming call.
  if (isProviderCoolingDown(streamLeg.provider, now)) {
    logger?.warn?.('llm.provider.coolingDown', { provider: streamLeg.provider });
    // Fall back to non-streaming complete() which will handle the fallback leg.
    const result = await complete(messages, env, opts, deps);
    if (result.error !== null || result.data === null) {
      throw new InternalError('LLM_ALL_PROVIDERS_FAILED', { error: result.error });
    }
    yield result.data.content;
    return result.data;
  }

  const req = buildAnthropicRequest(streamLeg.model, messages, opts, env, true);
  // Attribution for the shared AI Gateway (matches the non-streaming path).
  const streamAigMetadata = buildAigMetadata(opts);
  if (streamAigMetadata) req.headers['cf-aig-metadata'] = streamAigMetadata;

  let response: Response;
  try {
    response = await fetchImpl(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      // Fall back to a 60 s default when the caller provides no signal — prevents
      // a hung provider connection from consuming the Worker's wall-clock budget.
      signal: opts.signal ?? AbortSignal.timeout(60_000),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new InternalError('llm call aborted', {
        provider: streamLeg.provider,
        model: streamLeg.model,
      });
    }
    throw new InternalError('llm stream fetch failed', {
      message: e instanceof Error ? e.message : String(e),
    });
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const retryable = isRetryableForBackoff(response.status);
    if (retryable && response.status === 429) {
      markProviderCoolingDown(streamLeg.provider, now);
    }
    // Fall back to non-streaming complete() which will try the fallback leg.
    const result = await complete(messages, env, opts, deps);
    if (result.error !== null || result.data === null) {
      throw new InternalError('LLM_ALL_PROVIDERS_FAILED', {
        streamError: `${streamLeg.provider} ${String(response.status)}: ${text.slice(0, 300)}`,
        error: result.error,
      });
    }
    yield result.data.content;
    return result.data;
  }

  if (!response.body) {
    throw new InternalError('llm stream response body is null', {
      provider: streamLeg.provider,
    });
  }

  // Stream SSE events from Anthropic.
  const decoder = new TextDecoder();
  let accumulatedText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let modelName: string | undefined;
  // Tool-use blocks arrive as content_block_start (id/name) then a sequence of
  // input_json_delta fragments that concatenate into the arguments JSON string.
  const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
  let streamStopReason: LLMResult['stopReason'];
  const gatewayRequestId: string | undefined = response.headers.get('cf-aig-request-id') ?? undefined;

  const reader = response.body.getReader();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE lines are delimited by '\n'. Events are separated by '\n\n'.
      const lines = buffer.split('\n');
      // Keep the last (potentially incomplete) line in the buffer.
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') break;
        let event: AnthropicStreamEvent;
        try {
          event = JSON.parse(data) as AnthropicStreamEvent;
        } catch {
          continue; // Skip malformed SSE lines.
        }

        switch (event.type) {
          case 'message_start':
            inputTokens = event.message?.usage?.input_tokens ?? 0;
            cacheRead = event.message?.usage?.cache_read_input_tokens ?? 0;
            cacheWrite = event.message?.usage?.cache_creation_input_tokens ?? 0;
            modelName = event.message?.model;
            break;
          case 'content_block_start':
            if (
              event.content_block?.type === 'tool_use' &&
              typeof event.index === 'number' &&
              typeof event.content_block.id === 'string' &&
              typeof event.content_block.name === 'string'
            ) {
              toolBlocks.set(event.index, { id: event.content_block.id, name: event.content_block.name, json: '' });
            }
            break;
          case 'content_block_delta':
            if (event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
              accumulatedText += event.delta.text;
              yield event.delta.text;
            } else if (
              event.delta?.type === 'input_json_delta' &&
              typeof event.delta.partial_json === 'string' &&
              typeof event.index === 'number'
            ) {
              const block = toolBlocks.get(event.index);
              if (block) block.json += event.delta.partial_json;
            }
            break;
          case 'message_delta':
            outputTokens = event.usage?.output_tokens ?? outputTokens;
            if (event.delta?.stop_reason) streamStopReason = normalizeAnthropicStop(event.delta.stop_reason);
            break;
          default:
            break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  clearProviderCooldown(streamLeg.provider);
  logger?.info?.('llm.completionStream', {
    provider: streamLeg.provider,
    model: streamLeg.model,
    tier,
    tokenEstimate,
    runId: opts.runId,
    project: opts.project,
    actor: opts.actor,
    workload: opts.workload,
  });

  const toolCalls: LLMToolCall[] = [...toolBlocks.values()].map((b) => ({
    id: b.id,
    name: b.name,
    arguments: parseToolArgs(b.json),
  }));

  return {
    content: accumulatedText,
    provider: streamLeg.provider,
    model: modelName ?? streamLeg.model,
    tier,
    tokens: { input: inputTokens, output: outputTokens, cacheRead, cacheWrite },
    latency: now() - startedAt,
    attempts: 1,
    gatewayRequestId,
    stopReason: streamStopReason,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

// ─── Grounding assertion ───────────────────────────────────────────────────

/**
 * Returns `true` if `response` contains at least one verbatim phrase of at
 * least 5 consecutive whitespace-delimited tokens that also appears in one of
 * the `sources` strings.
 *
 * Returns `true` unconditionally when `sources` is empty (no grounding
 * documents means grounding cannot be violated).
 *
 * This is a lightweight guard for RAG pipelines — it detects obvious
 * hallucinations where the model generates content not present in any
 * retrieved source. It is NOT a semantic similarity check.
 *
 * @param response - The LLM-generated text to inspect.
 * @param sources - Retrieved source documents to check against.
 * @returns `true` if the response is grounded, `false` if hallucination detected.
 *
 * @example
 * ```ts
 * const grounded = assertGrounding(llmAnswer, retrievedDocs);
 * if (!grounded) {
 *   // flag or re-rank the response
 * }
 * ```
 */
export function assertGrounding(response: string, sources: string[]): boolean {
  if (sources.length === 0) return true;

  const WINDOW = 5;
  const responseTokens = response.split(/\s+/).filter((t) => t.length > 0);

  if (responseTokens.length < WINDOW) return false;

  // Build a set of all 5-token ngrams from each source for O(n) lookup.
  const sourceNgrams = new Set<string>();
  for (const source of sources) {
    const tokens = source.split(/\s+/).filter((t) => t.length > 0);
    for (let i = 0; i <= tokens.length - WINDOW; i++) {
      const ngram = tokens.slice(i, i + WINDOW).join(' ');
      sourceNgrams.add(ngram);
    }
  }

  if (sourceNgrams.size === 0) return false;

  // Slide a window of WINDOW tokens over the response and check for a match.
  for (let i = 0; i <= responseTokens.length - WINDOW; i++) {
    const ngram = responseTokens.slice(i, i + WINDOW).join(' ');
    if (sourceNgrams.has(ngram)) return true;
  }

  return false;
}

// ─── Exported helpers (kept for existing consumers) ───────────────────────

export { MODELS, isProviderCoolingDown, markProviderCoolingDown, clearProviderCooldown, PROVIDER_COOLDOWN_MS };
export { BASE_BACKOFF_MS };
