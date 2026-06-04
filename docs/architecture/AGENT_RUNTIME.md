# Factory Agent Runtime — Architecture & Implementation Plan

**Date:** 2026-06-03 · **Author:** Synthesis for Adrian · **Status:** draft, canonical once merged
**Scope:** A Cloudflare-native LLM **agent runtime** (`@latimer-woods-tech/agent`, package #26) that powers Factory's vertical SaaS products (Voice, Video, Astrology) on one hardened orchestration engine.
**Builds on:** [`FACTORY_V1.md`](./FACTORY_V1.md) (platform layers), the existing `apps/supervisor` (DO + executor + scoped-JWT pattern), and the `capabilities/` system.
**Defers to:** [`../supervisor/FRIDGE.md`](../supervisor/FRIDGE.md) and `CLAUDE.md` Hard Constraints wherever they conflict.

> **Positioning (read first).** This is **not** a horizontal agent-framework product (LangGraph/CrewAI competitor). That market is commoditized and vendor-absorbed; a solo operator cannot win it. This runtime is **internal infrastructure that powers our own verticals**, with optionality to productize later only if a vertical pulls external demand. We compete on vertical outcomes + built-in security/metering/audit, not on being a framework.

---

# Table of contents

1. Vision & value proposition
2. What already exists (and what does not)
3. Guiding principles & invariants
4. Architecture
5. The foundational gap: tool-calling in `@lwt/llm`
6. Tool registry — the keystone
7. Security model
8. Durable Object resumption & idempotency
9. Human-in-the-loop approval
10. Memory & compliance
11. Observability
12. Agent recipe schema
13. Gateway hardening
14. Cost analysis
15. Testing strategy
16. Phased build & success contracts
17. Live-supervisor migration
18. Risks & mitigations
19. Competitive landscape
20. Roadmap & first actions

---

# 1. Vision & value proposition

*Factory Agent Runtime* lets us define a production agent — its tools, memory, model-routing, security scope, and budget — as a **declarative recipe**, and deploy it as a branded, metered, auditable Worker in hours instead of weeks. Three of our verticals are each secretly an agent problem (voice intake = telephony + LLM + CRM routing; video = signal-scored generation; astrology = the "Oracle" synthesis). Today each reimplements orchestration. The runtime collapses that into one engine, so the **marginal cost of launching vertical #4 drops sharply**. The strategic value is compounding velocity on the products we already have, plus optionality — not a new product line we have to sell cold.

---

# 2. What already exists (and what does not)

Verified against the repo (2026-06-03). The boring, hard plumbing exists; the reasoning loop does not.

| Need | What exists | Reuse | Gap |
|---|---|---|---|
| Orchestration shell | `SupervisorDO` (alarm, lock, deadline, D1 memory) | ~70% | Built for scheduled CI runs, not interactive sessions |
| Tool execution + security | `executor.ts` + scoped-JWT minting + `StepReceipt` | ~80% | **Best asset** — minimal change |
| Tool registry | `tools/registry.ts` (`Tool`, `side_effects`, `byTier`) | ~60% | No JSON-schema for LLM calling; ops-only tools |
| **Reasoning / planning** | `planner/match.ts` (keyword + regex) | ~15% | **No LLM loop** — the core net-new work |
| **LLM tool-calling** | — | **0%** | `LLMResult` is `{ content: string }`; no `tools` in, no `tool_use` out |
| Memory | `memory/d1.ts` (key/value) | ~40% | No semantic recall, no summarization, no PII redaction |
| Model routing/failover | `@lwt/llm` tiers + `@lwt/llm-meter` budgets | ~85% | Failover not tool-aware; budgets ready |
| Agent definition | `capabilities/recipes/*.json` | ~70% | Describe *apps*, not *agent runtime config* |
| Inter-agent messaging | `@lwt/protocol` (token-minified envelopes) | ~75% | Ready |
| Realtime/streaming | `@lwt/realtime` (DO WS hibernation) | ~80% | Ready |

**Verified showstoppers** that an earlier draft missed:

- **Tool-calling does not exist in `@lwt/llm`.** [`LLMResult`](../../packages/llm/src/index.ts) is text-only. An agent loop is impossible without adding it — and the failover chain (Anthropic → Grok → Groq → DeepSeek → Gemini) spans **incompatible tool-call wire formats**.
- **`AI_GATEWAY_BASE_URL` is mandatory**; `complete()` throws without it. Per the ghost-gateway incident, an app pointed at an un-provisioned gateway gets a **silent 401 → degraded fallback** (this broke daily-brief). A new app must point at the provisioned `prime-self` gateway.

---

# 3. Guiding principles & invariants

**Cohesion invariants — reuse, never reinvent:**
1. Tools are `Tool` from `ToolRegistry` (same `{ name, side_effects, required_scope, invoke }`).
2. Inference is `@lwt/llm.complete()` — the loop never touches a provider directly.
3. Budgets are `@lwt/llm-meter` (`TenantTier` + `TIER_BUDGET_CENTS`).
4. Agents are declarative JSON compiled to TS, like `capabilities.generated.ts` — never a hand-maintained runtime registry.
5. The orchestrator is a Durable Object following the `SupervisorDO` pattern.
6. Inter-agent messages are `@lwt/protocol`; streaming is `@lwt/realtime`.

**Growth-safety invariants — why it won't break as designs grow:**
- **Additive-only interfaces.** Every extension is an *optional* field on an existing type; existing callers compile unchanged.
- **Versioned schemas.** Recipes and episodic tables carry a `version`/`schemaVersion`; loaders branch on it; old rows stay readable; sessions pin the recipe version at start.
- **Codegen, not hand-registries.** New agents/tools = new JSON + recompile. No central file everyone edits.
- **Strict downward dependencies.** `@lwt/agent` depends only on lower packages; the `supervisor` app and verticals consume it. The package never depends on an app.
- **Everything bounded.** Steps, tokens, dollars, context size, DO wall-clock — all capped (like today's `PER_RUN_ISSUE_CAP` / `ALARM_SOFT_DEADLINE_MS`).
- **Fail closed on capability loss.** If tool-calling can't be honored (provider, scope, budget), abort with a receipt — never silently degrade.
- **Nothing mutating runs without an idempotency key and a scope check, even on replay.**

---

# 4. Architecture

```
                         ┌─────────────────────────────┐
   Client (WS/HTTP) ───► │  agent-gateway (Hono Worker) │
                         │  authn, rate-limit, session  │
                         │  caps, route                 │
                         └──────────────┬──────────────┘
                                        │ idFromName(agentId + sessionId)
                         ┌──────────────▼──────────────┐
                         │   AgentSessionDO (per session)│
                         │  ┌────────────────────────┐  │
                         │  │  Reasoning loop          │  │  ← NET-NEW
                         │  │  while(!done && budget): │  │
                         │  │   1. assemble context    │  │
                         │  │   2. llm.complete(tools) │──┼─► @lwt/llm (failover + cache + meter)
                         │  │   3. parse toolCalls     │  │
                         │  │   4. scope re-check       │  │  ← security.ts
                         │  │   5. executor.invoke()   │──┼─► reuse executor.ts (scoped JWT)
                         │  │   6. append receipt       │  │  ← observe.ts (Sentry/PostHog/events)
                         │  │   7. checkpoint           │──┼─► resume.ts (DO SQLite)
                         │  └────────────────────────┘  │
                         └───┬──────────┬──────────┬────┘
                             │          │          │
                   D1 (audit,│   KV     │  Vectorize (semantic, Phase 4)
                   receipts, │ (config) │  Queues (async/slow tools)
                   episodic) │          │
```

The DO **is** the agent: single-threaded, strongly consistent, alarm-capable for long-running tasks. The reasoning loop replaces `matchTemplate()`. The deterministic template path is **retained as a cheap fast-lane** — a high-confidence recipe match short-circuits the LLM planner entirely.

**Folder additions:**

```
packages/agent/src/
  session.do.ts    loop.ts    context.ts    registry.ts    recipe.ts    guardrails.ts
  resume.ts        # checkpoint + idempotent replay
  security.ts      # injection defenses, invoke-time scope re-check
  observe.ts       # Sentry span + factory_events + PostHog per turn
  memory/ working.ts  episodic.ts  semantic.ts(interface now, impl Phase 4)
  index.ts
apps/agent-gateway/   # Hono: authn, rate-limit, session caps, WS, DO dispatch
capabilities/agents/*.json
```

`@lwt/agent` = **#26** in the dependency order (CLAUDE.md), deps: `errors, logger, llm, llm-meter, monitoring, protocol, realtime, validation, compliance` — all lower, no cycles.

---

# 5. The foundational gap: tool-calling in `@lwt/llm`

Nothing downstream exists without this, so it is built **first**. **Additive-only** so every current caller compiles unchanged:

```ts
// LLMOptions — ADD
tools?: LLMToolSchema[];          // JSON-schema tool defs; absent ⇒ today's behavior
toolChoice?: 'auto' | 'none' | { name: string };

// LLMResult — ADD
stopReason?: 'end' | 'tool_use' | 'max_tokens';
toolCalls?: { id: string; name: string; arguments: unknown }[];  // normalized
```

**Failover parity (load-bearing rule):** when `tools` is present, **narrow eligible providers to the tool-capable subset and fail closed.** Never silently fall over to a provider that can't honor the tool schema (the Groq `verifier` Llama tier and `workbench` DeepSeek are excluded from tool-loops by policy). Normalize Anthropic `tool_use` ↔ OpenAI-style `tool_calls` ↔ Gemini `functionCall` into the one `toolCalls` shape. Extend the streaming generator path to accumulate tool-call deltas.

Effort: **~2 wks** (provider normalization + cross-chain tests are the bulk).

---

# 6. Tool registry — the keystone

The single most important decision: **one tool type, two consumers (template path + LLM path), forever.** Add optional fields to [`Tool`](../../apps/supervisor/src/tools/registry.ts):

```ts
export interface Tool {
  name: string; description: string;
  side_effects: SideEffects; required_scope: string;
  invoke: (slots: Record<string, unknown>) => Promise<ToolResult>;
  parameters?: JSONSchema7;   // NEW — LLM tool-calling schema; absent ⇒ template-only
  exposeToLLM?: boolean;      // NEW — defaults derived from side_effects
}
```

Both optional ⇒ every existing supervisor tool keeps working untouched. **Extract `Tool`/`ToolRegistry` down into `@lwt/agent`** as the source of truth; the supervisor imports them back. Diverging into a separate "agent tool" type is the thing that would rot — explicitly forbidden.

---

# 7. Security model

Defense-in-depth, because scoped JWTs alone don't stop prompt injection:

- **Invoke-time scope re-check.** The executor re-verifies the minted JWT scope against `tool.required_scope` at call time — the LLM *proposing* a tool is not authorization.
- **`write-external` is never LLM-autonomous.** It routes through the human-approval gate (§9) or a recipe-declared pre-authorized allowlist.
- **Recipe tool allowlist is the ceiling.** The agent can only see tools its recipe lists, regardless of model hallucination.
- **Tool-result quarantine.** Tool outputs are framed as untrusted data (delimited, role-tagged), never concatenated into the system prompt — mitigates indirect injection.

Worst case under injection: reaching a `read-external`/`write-app` tool the recipe already granted — never an un-allowlisted mutation.

---

# 8. Durable Object resumption & idempotency

- **Checkpoint after every step** to DO SQLite: `{ step_index, messages, pending_tool_call?, budget_spent }`. On `alarm()` or cold-start, reload and resume from `step_index`.
- **Idempotency key per mutating step** = `hash(session_id + step_index + tool_name + args)`. The executor records `key → result` in D1 **before** returning; on replay, a matching key returns the stored result instead of re-invoking — so a crashed-then-resumed `send_email`/`charge` never double-executes.
- **Concurrency.** The DO is single-threaded; a second user message mid-loop is **queued** (pending-input buffer, consumed at the next loop boundary) or rejected `409` for single-turn recipes. No interleaving.
- **Wall-clock.** Long loops run under alarms (~15 min on Paid), never in a 30 s request handler. Slow/external tools go through Queues so the DO doesn't burn duration on I/O wait.

---

# 9. Human-in-the-loop approval

Generalizes the supervisor's `awaiting_approval`. On a gated step the loop **persists pending state, sets `status='awaiting_approval'`, emits an event, and returns** (DO idles — cheap). Approval arrives via authenticated `POST /sessions/:id/approve` → gateway addresses the DO → DO validates, marks the idempotency key authorized, resumes from checkpoint. Denial aborts with a receipt. A recipe-configured timeout auto-denies.

---

# 10. Memory & compliance

Three tiers: **working** (DO storage), **episodic** (D1, extends `memory/d1.ts`), **semantic** (Vectorize — interface defined now, impl Phase 4 to keep stubbing non-breaking).

**Episodic schema (append-only, archivable):**

```sql
CREATE TABLE agent_sessions (
  session_id TEXT PRIMARY KEY, agent_id TEXT, tenant_id TEXT,
  recipe_version TEXT, status TEXT,
  started_at INTEGER, ended_at INTEGER,
  total_usd_cents INTEGER, total_steps INTEGER
);
CREATE TABLE agent_turns (        -- StepReceipt, persisted
  session_id TEXT, step_index INTEGER, role TEXT,
  tool_name TEXT, side_effects TEXT, jwt_scope TEXT,
  idempotency_key TEXT, llm_input_ref TEXT, llm_output_ref TEXT,
  usd_cents INTEGER, ms INTEGER, created_at INTEGER,
  PRIMARY KEY (session_id, step_index)
);
```

**PII gate.** `episodic.ts` runs `@lwt/compliance` redaction **before** persisting `llm_input_ref`/`llm_output_ref`. The `healing-voice-agent` recipe *mandates* transcript redaction; storing raw I/O would violate it. Retention per recipe (`memory.retentionDays`); cold rows archived via the `factory-events-archiver` pattern. Because `agent_turns` mirrors `StepReceipt`, the existing `factory-events-replay` pattern replays a session for free.

---

# 11. Observability

Every turn emits: a **Sentry span** via `@lwt/monitoring` (traceable reasoning chains in prod), a **`factory_events`** row (first-party analytics), and a **PostHog** event (funnels). Record/replay captures redacted LLM I/O refs so a failed session replays exactly. Without this, debugging non-deterministic agents in prod is impossible.

---

# 12. Agent recipe schema

Mirrors `capabilities/recipes/*.json` so it loads through the same codegen:

```jsonc
{
  "schemaVersion": 1,
  "id": "oracle-synthesis", "version": "1.0.0", "maturity": "beta",
  "modelPolicy": { "default": "fast", "escalate": "smart", "longContextThreshold": 150000 },
  "tools": ["humandesign.read.blueprint", "humandesign.read.transits"],
  "memory": { "working": true, "episodic": true, "semantic": false, "retentionDays": 90 },
  "budget": { "tier": "individual", "maxUsdPerSession": 0.50, "maxSteps": 12 },
  "guardrails": { "humanApproval": ["write-external"], "approvalTimeoutSec": 3600 }
}
```

`budget.tier` is a `TenantTier`; `modelPolicy` values are existing `LLMTier`s — but only **tool-capable** tiers may be `default`/`escalate` when `tools` are present (validated at compile time). A session **pins `version` at start**; a mid-flight redeploy never mutates a running session.

---

# 13. Gateway hardening

`apps/agent-gateway` wrangler bindings: `DB` (D1), `AGENT_SESSIONS` (DO namespace), `KV` (config), `AGENT_QUEUE` (slow tools), `VECTORIZE` (Phase 4), `RATE_LIMITER` (**allocate ID 1009** per the add-new-app registry). **Per-tenant session caps** (prevents session-spawn cost-bombs) enforced via `llm-meter` tier. Authn reuses `@lwt/auth`.

**Secrets** sourced from GCP Secret Manager, synced via `sync-worker-secrets.yml` (add keys to its hardcoded list). **Critically: `AI_GATEWAY_BASE_URL` must point at the provisioned `prime-self` gateway**, not an `agent-gateway`-named ghost, or it silently degrades. This is a curl-verified Phase 3 gate, not an assumption.

---

# 14. Cost analysis

**LLM inference is 95%+ of cost and scales linearly with usage; Cloudflare infra is rounding error.** No flat-rate plan survives agent token economics — pricing must be usage-based with a markup.

Assumptions: a "task" = one agent invocation, ~6–10 LLM calls. *Optimized* (prompt caching + `fast`-tier default) ≈ **$0.30–0.50/task**; *naive* (no cache, `balanced`) ≈ **$1.20–2.00/task**. ~50 tasks/active-user/month.

| Tier | Tasks/mo | LLM (optimized) | LLM (naive) | CF infra | Total (optimized) |
|---|---|---|---|---|---|
| 100 users | 5k | ~$2,000 | ~$7,500 | ~$30–80 | **~$2,100/mo** |
| 1,000 users | 50k | ~$18,000 | ~$70,000 | ~$150–400 | **~$18,500/mo** |
| 10,000 users | 500k | ~$140,000 | ~$650,000 | ~$1,500–4,000 | **~$145,000/mo** |
| Enterprise (heavy) | 200k | ~$70,000+ | — | ~$1,000 | **~$70k+/mo** |

**Cost controls (ROI order):** prompt caching (70–90% input cut, via AI Gateway) → model-tier routing (`fast` default, escalate explicitly) → deterministic recipe fast-lane (skip LLM) → context pruning/summarization → hard per-session `maxUsdPerSession` caps → semantic response cache.

**Revenue:** usage-based (cost + 40–70% markup) is the only viable model. Real ARR accrues through **vertical SaaS** (sell the outcome — a reading, a qualified lead, a published video; agent cost is COGS we control). Platform license and skill marketplace are mirages at this stage — model **$0** until inbound demand proves otherwise.

---

# 15. Testing strategy

Non-deterministic loops need deterministic tests:
- **`@lwt/testing` mock LLM** returns scripted `toolCalls` → deterministic unit tests of branch/termination/budget/resume logic without real inference.
- **Recorded provider fixtures** replayed in CI cover the tool-call normalization across the failover chain.
- **`@lwt/validation` output quality gates** (its stated purpose) assert on agent output before return — a degraded model can't ship garbage.
- Coverage gates (90% line/fn, 85% branch) apply to loop/guardrails/resume/security logic, not to LLM responses. TS strict, ESLint `--max-warnings 0`, JSDoc ≥90%, tsup ESM `dist/`.

---

# 16. Phased build & success contracts

Done-when is **curl-verified, not CI-green** (per the Verification Requirement).

| Phase | Scope | Wks | Done-when |
|---|---|---|---|
| **0 — Cost spike** | throwaway DO, 1 read tool, prompt cache | 0.5 | real $/task number; **gate: economics clear a vertical's price** |
| **1 — `@lwt/llm` tool-calling** | additive `tools`/`toolCalls`, failover narrowing, streaming | 2 | mock + recorded-fixture tests green across providers; published |
| **2 — `@lwt/agent` core** | loop, context+cache, guardrails, resume+idempotency, security, observe, episodic+compliance | 4 | unit suite green; replay reproduces a session; PII redacted in D1 |
| **3 — Gateway + supervisor migration** | gateway (rate-limit, session caps, gateway-URL gate), WS streaming, Queues; supervisor consumes extracted registry | 3 | `/health` 200; supervisor scheduled run still green post-migration |
| **4 — First vertical** | oracle/voice recipe E2E; semantic memory impl | 2.5 | one real task end-to-end; cost dashboard live; approval flow exercised |

Total after the Phase 0 gate: **~11.5 person-weeks** (solo). Faster only because security/metering/failover/DO plumbing already exists.

---

# 17. Live-supervisor migration

The supervisor runs scheduled jobs in production; the registry extraction must not break it. **Strangler, not big-bang:**
1. Publish `@lwt/agent` with the extracted `Tool`/`ToolRegistry`.
2. Bump the supervisor's dependency.
3. Run its test suite **and one real scheduled cycle on a branch**; verify green.
4. Merge; then delete the supervisor's local `registry.ts` / `memory/d1.ts`.

---

# 18. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Inference cost > revenue/user | 🔴 | Usage-based pricing; hard `maxUsdPerSession`; tier routing + caching; no "unlimited" plans |
| Failover degrades tool-calling mid-loop | 🔴 | Fail-closed to tool-capable provider subset; never silent-downgrade |
| Ghost AI Gateway → silent fallback | 🔴 | Curl-verify `AI_GATEWAY_BASE_URL`→prime-self in Phase 3 |
| Prompt injection → unauthorized mutation | 🔴 | Recipe allowlist ceiling + invoke-time scope re-check + `write-external` always gated + tool-result quarantine |
| Replay double-executes side effects | 🔴 | Idempotency key recorded before return; matched on resume |
| Runaway/looping agents burn budget | 🟠 | Step/token/$ caps in the loop; kill switch |
| DO wall-clock on long tasks | 🟠 | Alarms + Queues; checkpoint state |
| Non-determinism → unshippable debugging | 🟠 | Record/replay + Sentry spans |
| PII leak into episodic store | 🟠 | `@lwt/compliance` redaction before persist; per-recipe retention |
| Live supervisor breaks during extraction | 🟠 | Strangler migration with real-cycle verification |
| Building a platform nobody asked for | 🔴 | Internal infra first; productize only on inbound demand |
| Commoditization by model vendors | 🟠 | Compete on vertical outcomes + scoped-security/audit, not the framework |

---

# 19. Competitive landscape

| Platform | Where we'd lose | Where we'd win |
|---|---|---|
| **LangGraph** | Ecosystem, mindshare, free | Edge latency, no Python infra, built-in scoped-JWT security + metering |
| **CrewAI** | Adoption, DX polish | Production hardening, audit/replay, edge deploy |
| **AutoGen** | Research velocity, MS backing | Operational maturity, cost controls, vertical focus |
| **OpenAI Agents SDK / Swarm** | It's free and vendor-native | Multi-provider failover, not OpenAI-locked, edge-native |
| **Vercel AI SDK** | TS DX, Next.js ecosystem | Workers-native (no Node), scoped security, declarative recipes |

**Honest unique advantages (only three, but real):** edge-native single-runtime (no Python/Node split); security + metering + audit baked in (scoped-JWT-per-tool-call with receipts — ahead of the OSS pack, which hands models raw credentials); declarative vertical recipes. None are enough to win a *horizontal* land grab against free vendor tooling — exactly enough to make *us* faster and safer shipping verticals.

---

# 20. Roadmap & first actions

**0–3 mo** — ship `@lwt/agent` MVP (Phases 0–3); migrate the voice-intake *or* Oracle agent; cost instrumented (prompt caching, `llm-meter` caps, $/task dashboard).
**3–6 mo** — second vertical; semantic memory if context cost demands; human-approval UI; **go/no-go on productization based on measured margin**.
**6–12 mo** — *only if a vertical shows margin + inbound asks*: thin external SDK, multi-agent handoff via `@lwt/protocol`, replay tooling, per-tenant key vaulting. Skill marketplace stays parked.

**Immediate first three:**
1. **Phase 0 cost spike** — throwaway DO (`assemble → complete({tier:'fast', promptCache:true, maxCostUsd}) → parse toolCalls → registry.invoke → loop`) wired to one read-only tool. Get a real $/task. **Gate everything on it.**
2. **Write the `capabilities/agents/*.json` schema** (zod) extending the recipe schema — de-risks the registry in a day.
3. **Extract `Tool`/`ToolRegistry` + `memory/d1.ts` into `packages/agent/`**, refactor the supervisor to consume them — proves the abstraction against a real existing consumer before building new ones on top.

> **Two open decisions for the operator:** (1) tool-calling lands *in* `@lwt/llm` (recommended — keeps failover) vs. a thin adapter in `@lwt/agent` that bypasses failover; (2) the registry extraction direction (recommended: type moves *down* into `@lwt/agent` as source of truth).
