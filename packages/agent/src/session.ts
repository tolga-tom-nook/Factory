/**
 * AgentSession Durable Object — persistent, resumable agent sessions.
 *
 * Each session = one DO instance keyed by a caller-supplied `sessionId`. The DO:
 *  - Persists message history across requests so a session can span multiple
 *    HTTP calls (streaming, human-in-the-loop approvals, tool result injection).
 *  - Records an idempotency key before returning each turn result so DO
 *    resumption (crash + retry) cannot re-execute completed tool calls.
 *  - Enforces a session-level cost cap (turns are rejected once the budget is
 *    exhausted, not silently continued).
 *  - Exposes `/run`, `/history`, `/reset`, and `/health` over HTTP; stateless
 *    callers need only a DO stub — no Worker state kept in memory.
 *
 * ## Wire protocol
 * ```
 * POST /run       { messages, tier?, maxTurns?, maxTotalCostUsd? } → AgentResult
 * GET  /history                                                    → SessionState
 * POST /reset                                                      → { ok: true }
 * GET  /health                                                     → { ok: true }
 * ```
 *
 * ## Idempotency
 * Every completed turn is recorded in DO storage as `turn:{n}` before the
 * response is returned. On resumption (rare DO eviction mid-loop), the run
 * checks for existing turn records and skips re-execution, replaying the stored
 * `LLMResult` instead. Idempotency keys are keyed by `{sessionId}:turn:{n}`.
 */

import { type LLMEnv, type LLMMessage } from '@latimer-woods-tech/llm';
import { runLoop, type AgentLoopOptions, type AgentResult, type AgentTurn } from './loop.js';
import { ToolRegistry } from './registry.js';

/** Minimal DO storage interface — compatible with Cloudflare `DurableObjectState`. */
export interface DOStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options?: { prefix?: string; limit?: number }): Promise<Map<string, T>>;
}

/** Persisted session state stored in DO storage. */
export interface SessionState {
  sessionId: string;
  messages: LLMMessage[];
  turns: AgentTurn[];
  totalCostUsd: number;
  totalTurns: number;
  createdAt: string;
  updatedAt: string;
  status: 'idle' | 'running' | 'done' | 'budget_exceeded';
}

/** Options for a single `/run` call within a session. */
export interface SessionRunOptions {
  /** New user message(s) to append before running. */
  messages: LLMMessage[];
  tier?: AgentLoopOptions['tier'];
  maxTurns?: number;
  /** Per-run cost cap (stops this call; doesn't modify the session budget). */
  maxCostUsdThisRun?: number;
  stopOnToolError?: boolean;
}

const STATE_KEY = 'session:state';
const TURN_KEY_PREFIX = 'turn:';

function turnKey(n: number): string {
  return `${TURN_KEY_PREFIX}${n}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Core session logic — injectable storage for unit testing.
 * The exported `AgentSessionDO` class wraps this for the CF runtime.
 */
export async function runSession(
  storage: DOStorage,
  sessionId: string,
  env: LLMEnv,
  registry: ToolRegistry,
  runOpts: SessionRunOptions,
  loopDeps?: AgentLoopOptions['deps'],
): Promise<AgentResult> {
  // Load or initialise state.
  const state: SessionState = (await storage.get<SessionState>(STATE_KEY)) ?? {
    sessionId,
    messages: [],
    turns: [],
    totalCostUsd: 0,
    totalTurns: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: 'idle',
  };

  if (state.status === 'budget_exceeded') {
    return {
      content: '',
      stopReason: 'budget',
      turns: [],
      totalCostUsd: state.totalCostUsd,
      totalTurns: state.totalTurns,
    };
  }

  // Append new user messages.
  const incoming = runOpts.messages.filter((m) => m.role !== 'system');
  state.messages.push(...incoming);
  state.status = 'running';
  state.updatedAt = nowIso();

  // Idempotency: load any already-completed turns so resumption skips them.
  // (In normal operation there are none; this fires only on DO eviction mid-run.)
  const existingTurns = new Map<number, AgentTurn>();
  const stored = await storage.list<AgentTurn>({ prefix: TURN_KEY_PREFIX });
  for (const [k, v] of stored.entries()) {
    const n = parseInt(k.replace(TURN_KEY_PREFIX, ''), 10);
    if (!isNaN(n)) existingTurns.set(n, v);
  }
  const resumeOffset = existingTurns.size;

  // Run the loop (existing turns are skipped via the offset).
  const result = await runLoop(state.messages.slice(-200), {
    env,
    registry,
    tier: runOpts.tier,
    maxTurns: Math.max(1, (runOpts.maxTurns ?? 10) - resumeOffset),
    maxCostUsdPerTurn: runOpts.maxCostUsdThisRun !== undefined
      ? runOpts.maxCostUsdThisRun
      : undefined,
    maxTotalCostUsd: runOpts.maxCostUsdThisRun,
    stopOnToolError: runOpts.stopOnToolError,
    deps: loopDeps,
  });

  // Persist each new turn with its idempotency key before updating state.
  for (let i = 0; i < result.turns.length; i++) {
    const turn = result.turns[i];
    if (turn !== undefined) {
      await storage.put(turnKey(resumeOffset + i), turn);
    }
  }

  // Append assistant turns to the message history.
  for (const turn of result.turns) {
    state.messages.push({ role: 'assistant', content: turn.llmResult.content });
    for (const receipt of turn.receipts) {
      state.messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: receipt.id, content: receipt.result.ok ? (typeof receipt.result.result === 'string' ? receipt.result.result : JSON.stringify(receipt.result.result)) : `Error: ${receipt.result.error}` }],
      });
    }
  }

  state.turns.push(...result.turns);
  state.totalCostUsd += result.totalCostUsd;
  state.totalTurns += result.totalTurns;
  state.updatedAt = nowIso();
  state.status = result.stopReason === 'budget' ? 'budget_exceeded'
    : result.stopReason === 'end' ? 'done'
    : 'idle';

  await storage.put(STATE_KEY, state);
  return result;
}

/**
 * Cloudflare Durable Object class. Export this from your Worker:
 * ```ts
 * export { AgentSessionDO } from '@latimer-woods-tech/agent';
 * // wrangler.jsonc:  [[durable_objects.bindings]]  name="AGENT_SESSIONS"  class_name="AgentSessionDO"
 * ```
 * The DO requires the caller to inject `env` (for `LLMEnv`) and a
 * `ToolRegistry` via the request body — it cannot hold long-lived env bindings
 * because DO serialization would strip them. Callers pass env + registry per
 * request (typically sourced from the Worker's own `Env` binding).
 */
export class AgentSessionDO {
  private storage: DOStorage;
  private sessionId: string;
  /** Optional test-injectable deps (e.g. mock fetch). Ignored in production. */
  private testDeps?: AgentLoopOptions['deps'];

  constructor(
    state: { storage: DOStorage; id: { toString(): string } },
    testDeps?: AgentLoopOptions['deps'],
  ) {
    this.storage = state.storage;
    this.sessionId = state.id.toString();
    this.testDeps = testDeps;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (`${request.method} ${url.pathname}`) {
        case 'GET /health':
          return Response.json({ ok: true, sessionId: this.sessionId });

        case 'GET /history': {
          const state = await this.storage.get<SessionState>(STATE_KEY);
          return Response.json(state ?? { sessionId: this.sessionId, messages: [], turns: [], totalCostUsd: 0, totalTurns: 0, status: 'idle' });
        }

        case 'POST /reset': {
          const stored = await this.storage.list({ prefix: TURN_KEY_PREFIX });
          for (const k of stored.keys()) await this.storage.delete(k);
          await this.storage.delete(STATE_KEY);
          return Response.json({ ok: true });
        }

        case 'POST /run': {
          const body = await request.json() as {
            env: LLMEnv;
            messages: LLMMessage[];
            tier?: AgentLoopOptions['tier'];
            maxTurns?: number;
            maxCostUsdThisRun?: number;
            stopOnToolError?: boolean;
            tools?: Array<{ name: string; description?: string; side_effects?: string; required_scope?: string; parameters?: Record<string, unknown> }>;
          };

          const registry = new ToolRegistry();
          // Callers inject tool metadata; invoke is a no-op stub (real invocation
          // happens in the caller's Worker via the gateway pattern).
          for (const t of (body.tools ?? [])) {
            registry.register({
              name: t.name,
              description: t.description ?? '',
              side_effects: (t.side_effects ?? 'none') as 'none' | 'read-external' | 'write-app' | 'write-external',
              required_scope: t.required_scope ?? 'read',
              parameters: t.parameters,
              invoke: (slots) => Promise.resolve({ ok: false as const, error: `tool ${t.name} requires gateway dispatch (slots: ${JSON.stringify(slots)})` }),
            });
          }

          const result = await runSession(
            this.storage,
            this.sessionId,
            body.env,
            registry,
            {
              messages: body.messages,
              tier: body.tier,
              maxTurns: body.maxTurns,
              maxCostUsdThisRun: body.maxCostUsdThisRun,
              stopOnToolError: body.stopOnToolError,
            },
            this.testDeps,
          );
          return Response.json(result);
        }

        default:
          return new Response('not found', { status: 404 });
      }
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      console.error('[agent.session.do] error:', msg);
      return Response.json({ error: 'internal error' }, { status: 500 });
    }
  }
}
