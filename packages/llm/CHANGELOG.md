# Changelog

## 0.4.4 — 2026-06-03

### Added — streaming tool-calls (Phase 1c; Anthropic)

- `completionStream` now accumulates Anthropic tool-use stream events
  (`content_block_start` + `input_json_delta` fragments) into the same
  normalized `LLMResult.toolCalls`, and captures `stopReason` from the
  `message_delta`. The returned result of a streamed tool-use turn matches the
  non-streaming shape. Text deltas still stream incrementally as before.

---

## 0.4.3 — 2026-06-03

### Added — tool-calling for OpenAI-style providers (Phase 1b: Grok, DeepSeek)

- **Grok and DeepSeek now support tool-calling.** Requests carry OpenAI-format
  `tools` + `tool_choice`; responses parse `tool_calls` + `finish_reason` into
  the same normalized `LLMResult.toolCalls` / `stopReason` as Anthropic.
- Anthropic-shaped tool blocks are converted to OpenAI wire format:
  `tool_use` → an assistant message with `tool_calls`; `tool_result` → a
  standalone `tool` message keyed by `tool_call_id`.
- **`TOOL_CAPABLE_PROVIDERS`** widened to `anthropic, grok, deepseek`, so the
  `fast` (Grok→Haiku) and `workbench` (DeepSeek) tiers support tool loops while
  still failing closed for `verifier` (Groq Llama).
- Malformed tool-call argument JSON is tolerated (billed as `{}`, never throws).

### Not yet

- **Gemini** tool-calling is deferred to a focused follow-up — its
  `tool_use_id`↔function-name correlation and schema constraints need dedicated
  handling. Gemini stays out of `TOOL_CAPABLE_PROVIDERS` until then.

---

## 0.4.2 — 2026-06-03

### Added — tool-calling (Agent Runtime Phase 1a; Anthropic)

- **`LLMOptions.tools`** (`LLMTool[]`) and **`LLMOptions.toolChoice`**
  (`'auto' | 'none' | { name }`). When `tools` is set, routing **fails closed**
  to tool-capable providers — failover never silently falls back to one that
  can't honour the tool schema (1a: Anthropic only; others land in 1b).
- **`LLMResult.toolCalls`** (`LLMToolCall[]`) and **`LLMResult.stopReason`**
  (`'end' | 'tool_use' | 'max_tokens' | 'other'`), normalized across providers.
- **`LLMMessage.content`** now accepts `string | LLMContentBlock[]` — structured
  `text` / `tool_use` / `tool_result` blocks for multi-turn tool conversations.
  Backwards-compatible: existing `string` content is unchanged; providers without
  tool support receive the text projection.
- New exported types: `LLMTool`, `LLMToolCall`, `LLMContentBlock`.

### Notes

- A `tool_use` response with no text content is no longer treated as an empty
  (failed) completion.
- Anthropic `tool_use` blocks pass through unchanged (the block shapes mirror the
  Messages wire format). Other providers' tool formats are normalized in 1a's
  follow-ups (1b: Grok/DeepSeek/Gemini; 1c: streaming tool-call accumulation).

---

## 0.4.1 — 2026-06-03

### Added (no breaking changes)

- Export `MODEL_PRICE_PER_1M` — the canonical USD-per-1M-tokens rate table. This
  makes it the single source of truth for pricing across the platform;
  `@latimer-woods-tech/llm-meter` now derives its cents table from it and enforces
  parity with a drift-guard test. Make all rate changes here.

---

## 0.3.4 — 2026-05-28

### Added (no breaking changes)

- **`workbench` tier** routes to `deepseek-chat` with Groq fallback for boring,
  reviewable, non-sensitive internal batch work.
- **`DEEPSEEK_API_KEY`** added as an optional `LLMEnv` binding. It is required only
  for `tier: 'workbench'` or explicit `deepseek-*` model overrides.
- **DeepSeek pricing entries** for `deepseek-chat` and `deepseek-reasoner` so cost
  caps and ledger rows use known rates instead of the conservative Opus fallback.

### Guardrail

- `workbench` is for docs summaries, changelog drafts, issue triage, and classification.
  Do not route secrets, customer PII, billing data, production ops, or final
  customer-facing answers through DeepSeek.

---

## 0.3.3 — 2026-05-27

### Changed (no breaking changes)

- **`fast` tier now routes to Grok 4.3 (primary) → Anthropic Haiku (fallback).**
  When `GROK_API_KEY` is present in `LLMEnv`, the `fast` tier sends completions to
  `grok-4.3` first and falls back to `claude-haiku-4-20250514` if Grok is unavailable
  or returns an error. When `GROK_API_KEY` is absent, the request goes directly to
  Anthropic Haiku (same behaviour as before). Callers that already set `tier: 'fast'`
  pick up Grok routing automatically; no code change needed.

### Added

- **`LLMOptions.reasoningEffort`** — `'none' | 'low' | 'medium' | 'high'`
  (optional, defaults to `'none'`). Forwarded to the Grok `reasoning_effort` parameter
  for `grok-4.3`; ignored for all other providers.
- **`MODELS.grok.fast`** updated from `'grok-4-fast'` to `'grok-4.3'`. Old alias
  `'grok-4-fast'` retained as deprecated with updated pricing so historical ledger
  rows remain accurate.
- **Grok pricing update**: `grok-4.3` at $1.25/$2.50 per MTok (in/out).
  Old `grok-4-fast` and `grok-3-mini-latest` re-priced to the same $1.25/$2.50 rate.
- **`for (const [legIndex, leg] of routeLegs.entries())`** — renamed loop variable so
  `legIndex` is accessible for the last-leg 429 rate-limit short-circuit.

### Consumers

- To opt-in to Grok 4.3: add `GROK_API_KEY` to your `LLMEnv` binding. No other code
  change required for `tier: 'fast'` callers.
- `GROK_API_KEY` is optional. If absent, fast-tier routing is identical to 0.3.2
  (Anthropic Haiku only).

---

## 0.3.2 — 2026-05-27

### Added (no breaking changes)

- **`LLMOptions.workload`** — optional string label (`'insights'`, `'copy'`, `'lead-qualification'`, …)
  forwarded to cost-recording calls for per-workload cost attribution in dashboards.
- **Missing model pricing entries** in `MODEL_PRICE_PER_1M`:
  `claude-haiku-4-5-20251001`, `claude-sonnet-4-20250514`, `claude-opus-4-20250514`
  (aliases for variants that share pricing with their shorthand names; prevents
  `estimateCostUsd` from silently returning `$0` for these model IDs).
- **`workload` forwarded** to `recordOrgCostUsage` so per-workload breakdowns appear
  in the cost-tracking KV store.

### Consumers

- Existing callers do not need to set `workload`; it is optional and defaults to `undefined`.
- The `recordOrgCostUsage` signature is unchanged; `workload` is an additive internal field.

---

## 0.3.1 — 2026-05-02 PM

### Added (no breaking changes)

- **Grok opt-in provider.** `LLMProvider` now includes `'grok'`. Call with `{ model: 'grok-4-fast' }` or `{ model: 'grok-3-mini-latest' }` to route to xAI. Not in default tier routing — explicit model override only.
- `LLMEnv.GROK_API_KEY` is **optional**; required only when a caller opts in via a `grok-*` model override.
- `MODELS.grok.{fast, mini}` added to the catalogue.

### Rationale

Reversal of the 0.3.0 partial decision (D1 in `docs/supervisor/DECISIONS.md`): Grok stays available for workloads that benefit from its quirks — cheap experimental prompting in the xico-city user economy, artist-platform surface, etc. It does not compete with Anthropic / Gemini / Groq for the tier slots; it sits alongside as a per-call opt-in.

### Consumers

- Downstream packages do not need to declare `GROK_API_KEY` unless a route explicitly sends Grok model overrides. Existing code that dropped the key on 0.3.0 migration continues to work.


## 0.3.0 — 2026-05-02

### Breaking

- **Grok removed.** `LLMProvider` no longer includes `grok`; `LLMEnv.GROK_API_KEY` removed.
- **AI Gateway mandatory.** `LLMEnv.AI_GATEWAY_BASE_URL` is required. All provider traffic flows through
  Cloudflare AI Gateway for unified logging, rate limiting, and cost telemetry.
- **Tier-based routing.** `LLMOptions.tier` (`fast | balanced | smart | verifier`) replaces the
  flat Anthropic → Grok → Groq failover chain. Routing is workload-split:
  - `fast` → Anthropic Haiku (latency-sensitive, short completions)
  - `balanced` → Anthropic Sonnet (default)
  - `smart` → Anthropic Opus; Gemini 2.5 Pro for long-context (>150k tokens est.)
  - `verifier` → Groq Llama 3.3 70B (cheap second opinion, no fallback)
- **Dependency declarations fixed.** `@latimer-woods-tech/errors` and `@latimer-woods-tech/logger`
  now declared as `^0.2.0` instead of `file:../*` so external consumers can install the package.

### Added

- Gemini 2.5 Pro via Vertex AI as long-context fallback (`VERTEX_ACCESS_TOKEN`, `VERTEX_PROJECT`, `VERTEX_LOCATION`).
- Anthropic prompt caching (auto-enabled for system prompts ≥ 4096 chars; override via `LLMOptions.promptCache`).
- Per-call cancellation via `LLMOptions.signal: AbortSignal`.
- 3-attempt exponential backoff (250ms · 2^n + jitter) on retryable status (408, 425, 429, 5xx).
- Ledger stamping: `LLMOptions.{runId, project, actor}` propagated to logger for downstream
  consumption by `@latimer-woods-tech/llm-meter`.
- `LLMResult.{model, tier, attempts, gatewayRequestId, tokens.cacheRead, tokens.cacheWrite}` for
  observability and budget accounting.

### Changed

- Default model constants renamed and grouped under exported `MODELS` catalogue. Kept in sync with
  `docs/architecture/FACTORY_V1.md § LLM substrate`.
- Empty provider responses now surface as leg failures and trigger fallback rather than returning
  an empty `LLMResult`.

### Migration

Replace:

```ts
const res = await complete(msgs, { ANTHROPIC_API_KEY, GROK_API_KEY, GROQ_API_KEY }, { model: 'claude-sonnet-4-...' });
```

With:

```ts
const res = await complete(
  msgs,
  {
    AI_GATEWAY_BASE_URL: env.AI_GATEWAY_BASE_URL,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    GROQ_API_KEY: env.GROQ_API_KEY,
    VERTEX_ACCESS_TOKEN: env.VERTEX_ACCESS_TOKEN, // minted via JWT-bearer flow
    VERTEX_PROJECT: env.VERTEX_PROJECT,
    VERTEX_LOCATION: env.VERTEX_LOCATION,
  },
  { tier: 'balanced', runId, project: 'prime-self', actor: 'worker' },
);
```

## 0.2.0

Initial public release of the failover orchestrator.
