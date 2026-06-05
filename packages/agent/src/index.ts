/**
 * @latimer-woods-tech/agent
 *
 * Cloudflare-native LLM agent runtime. Powers Factory's vertical SaaS products
 * (Voice, Video, Astrology) on one hardened orchestration engine.
 *
 * See `docs/architecture/AGENT_RUNTIME.md` for the full design.
 */

export {
  ToolRegistry,
  isLLMExposed,
  type Tool,
  type ToolResult,
  type SideEffects,
} from './registry.js';

export {
  runLoop,
  type AgentLoopOptions,
  type AgentResult,
  type AgentTurn,
  type ToolCallReceipt,
  type StopReason,
} from './loop.js';

export {
  AgentSessionDO,
  runSession,
  type DOStorage,
  type SessionState,
  type SessionRunOptions,
} from './session.js';

export {
  GuardrailError,
  detectInjection,
  assertCleanUserMessage,
  assertCleanToolResult,
  truncateToolResult,
  MAX_USER_MESSAGE_CHARS,
  MAX_TOOL_RESULT_CHARS,
} from './guardrails.js';

export {
  recordEpisode,
  getRecentEpisodes,
  getProjectEpisodes,
  getEpisodeSummary,
  type Episode,
  type RecordEpisodeParams,
  type D1Like,
} from './memory/episodic.js';

export {
  pruneMessages,
  type PruneOptions,
} from './pruning.js';
