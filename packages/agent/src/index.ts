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
