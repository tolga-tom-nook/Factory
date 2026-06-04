/**
 * Template step executor — invokes a single tool with parameterized slots
 * and captures the receipt.
 *
 * Each step execution:
 *   1. Resolves slot values (substituting $slots.X and $s<N>.path references)
 *   2. Mints the appropriate scoped JWT based on side_effects
 *   3. Calls the tool via ToolRegistry.invoke()
 *   4. Captures success/failure + result/error in a receipt
 *
 * Receipts are audit-logged to supervisor_steps table and used for
 * rollback, cost metering, and quality tracking.
 */

import type { Env } from './index';
import type { ToolRegistry } from '@latimer-woods-tech/agent';
import { mintReadonlyJwt, mintMutatorJwt } from './auth';
import type { Template } from './planner/load';

/** Single step execution result — logged to supervisor_steps table. */
export interface StepReceipt {
  step_index: number;
  tool_name: string;
  side_effects: 'none' | 'read-external' | 'write-app' | 'write-external';
  /** Raw slot object as passed to tool.invoke() */
  slots_provided: Record<string, unknown>;
  /** Tool response: { ok: true, result } or { ok: false, error } */
  result: { ok: boolean; result?: unknown; error?: string };
  /** JWT scope used (for audit trail) */
  jwt_scope: string;
  /** Execution time in ms */
  execution_ms: number;
  /** Timestamp of execution */
  executed_at: number;
  /**
   * If the step is mutating and requires out-of-band approval,
   * this gate is set and execution does not proceed to next step.
   */
  awaiting_approval?: 'codeowner_confirmation';
}

/**
 * Resolves a single slot value, handling:
 *   - string literals (e.g. "some-value")
 *   - $slots.X references (from parameterize step)
 *   - $s<N>.path references (from previous step results)
 *
 * Phase 1: support literals and $slots.X only. Cross-step references
 * ($s1.field, $s2.nested.field) are SUP-3.6.
 */
function resolveSlot(
  key: string,
  value: unknown,
  userSlots: Record<string, unknown>,
  previousResults: Record<number, unknown>,
): unknown {
  if (typeof value === 'string' && value.startsWith('$slots.')) {
    const slotName = value.slice(7);
    return userSlots[slotName];
  }
  if (typeof value === 'string' && value.startsWith('$s')) {
    // $s1.field, $s2.nested.field, etc. — SUP-3.6
    // Phase 1: not yet supported
    throw new Error(`Cross-step references ($s<N>) not yet supported. Key: ${key}, value: ${value}`);
  }
  return value;
}

type TemplateStep = NonNullable<Template['steps']>[number];

/**
 * Resolves all slots in a step, recursively handling nested objects and arrays.
 */
function resolveAllSlots(
  step: TemplateStep | undefined,
  userSlots: Record<string, unknown>,
  previousResults: Record<number, unknown>,
): Record<string, unknown> {
  if (!step?.slots) return {};

  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(step.slots)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const nested = value as Record<string, unknown>;
      resolved[key] = Object.fromEntries(
        Object.entries(nested).map(([k, v]) => [
          k,
          resolveSlot(k, v, userSlots, previousResults),
        ]),
      );
    } else if (Array.isArray(value)) {
      resolved[key] = (value as unknown[]).map((v) => resolveSlot(key, v, userSlots, previousResults));
    } else {
      resolved[key] = resolveSlot(key, value, userSlots, previousResults);
    }
  }
  return resolved;
}

/**
 * Execute a single template step.
 *
 * @param stepIndex — Position in the template.steps array (0-based)
 * @param step — The step definition
 * @param userSlots — Parameterized values from the planning phase
 * @param previousResults — Results from earlier steps (keyed by step index)
 * @param tools — ToolRegistry
 * @param env — Env with JWT_SECRET
 * @returns StepReceipt with execution result
 *
 * Approval gate: if step.requires_codeowner_approval is true and the step
 * succeeds, sets awaiting_approval='codeowner_confirmation' to halt the chain.
 */
export async function executeStep(
  stepIndex: number,
  step: TemplateStep | undefined,
  userSlots: Record<string, unknown>,
  previousResults: Record<number, unknown>,
  tools: ToolRegistry,
  env: Env,
): Promise<StepReceipt> {
  const startMs = Date.now();

  if (!step) {
    throw new Error(`Step at index ${stepIndex} is undefined`);
  }

  const toolName = step.tool;
  const sideEffects = step.side_effects ?? 'none';

  // Resolve all slot references
  const slots = resolveAllSlots(step, userSlots, previousResults);

  // Determine JWT scope and mint token
  let jwtScope = 'supervisor.readonly';
  if (sideEffects !== 'none') {
    jwtScope = `supervisor.mutator-${toolName}`;
  }
  const jwt = await (sideEffects === 'none'
    ? mintReadonlyJwt(env.JWT_SECRET)
    : mintMutatorJwt(env.JWT_SECRET, toolName));

  // Look up the tool
  const tool = tools.get(toolName);
  if (!tool) {
    const elapsed = Date.now() - startMs;
    return {
      step_index: stepIndex,
      tool_name: toolName,
      side_effects: sideEffects,
      slots_provided: slots,
      result: { ok: false, error: `Tool not found: ${toolName}` },
      jwt_scope: jwtScope,
      execution_ms: elapsed,
      executed_at: Date.now(),
    };
  }

  // Execute the tool
  let toolResult: { ok: boolean; result?: unknown; error?: string };
  try {
    toolResult = await tool.invoke(slots);
  } catch (err) {
    toolResult = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const elapsed = Date.now() - startMs;

  const receipt: StepReceipt = {
    step_index: stepIndex,
    tool_name: toolName,
    side_effects: sideEffects,
    slots_provided: slots,
    result: toolResult,
    jwt_scope: jwtScope,
    execution_ms: elapsed,
    executed_at: Date.now(),
  };

  // Approval gate: if tool succeeded and step requires codeowner approval,
  // set awaiting_approval flag to halt the execution chain
  if (toolResult.ok && step.requires_codeowner_approval) {
    receipt.awaiting_approval = 'codeowner_confirmation';
  }

  return receipt;
}

/**
 * Execute a parameterized plan directly (all slots already filled).
 *
 * Used when the plan has already been parameterized and slots are resolved.
 * Each step's slots object is passed directly to the tool.
 *
 * Enforces mutation limits:
 * - ≤25 mutating steps per run
 * - ≤5 mutating steps per app
 */
export async function executePlan(
  steps: Array<{
    tool: string;
    slots: Record<string, unknown>;
    side_effects: 'none' | 'read-external' | 'write-app' | 'write-external';
    requires_codeowner_approval?: boolean;
  }>,
  tools: ToolRegistry,
  env: Env,
): Promise<StepReceipt[]> {
  const receipts: StepReceipt[] = [];
  const previousResults: Record<number, unknown> = {};

  // Track mutation counts for amplification cap
  let mutatingCount = 0;
  const perAppCount: Record<string, number> = {};

  const MUTATION_CAP_GLOBAL = 25;
  const MUTATION_CAP_PER_APP = 5;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const sideEffects = step.side_effects ?? 'none';

    // Pre-flight check: enforce mutation caps before invoking tool
    if (sideEffects !== 'none') {
      // Check global mutation cap
      if (mutatingCount >= MUTATION_CAP_GLOBAL) {
        const receipt: StepReceipt = {
          step_index: i,
          tool_name: step.tool,
          side_effects: sideEffects,
          slots_provided: step.slots,
          result: {
            ok: false,
            error: `Mutation limit exceeded: ${mutatingCount + 1} > ${MUTATION_CAP_GLOBAL} per run`,
          },
          jwt_scope: 'supervisor.readonly',
          execution_ms: 0,
          executed_at: Date.now(),
        };
        receipts.push(receipt);
        break;
      }

      // Check per-app mutation cap
      // Map tool name to app_id using registry metadata
      const tool = tools.get(step.tool);
      let appId = 'unknown';
      if (tool) {
        // Extract app_id from tool name (format: "app-id.capability.method")
        const parts = tool.name.split('.');
        if (parts.length >= 1) {
          appId = parts[0] || 'unknown';
        }
      }

      const currentAppCount = perAppCount[appId] ?? 0;
      if (currentAppCount >= MUTATION_CAP_PER_APP) {
        const receipt: StepReceipt = {
          step_index: i,
          tool_name: step.tool,
          side_effects: sideEffects,
          slots_provided: step.slots,
          result: {
            ok: false,
            error: `Mutation limit exceeded for app '${appId}': ${currentAppCount + 1} > ${MUTATION_CAP_PER_APP} per run`,
          },
          jwt_scope: 'supervisor.readonly',
          execution_ms: 0,
          executed_at: Date.now(),
        };
        receipts.push(receipt);
        break;
      }
    }

    // Execute the step
    const receipt = await executeStep(i, step, {}, previousResults, tools, env);
    receipts.push(receipt);

    // Track mutation counts after successful execution
    if (receipt.result.ok && sideEffects !== 'none') {
      mutatingCount++;
      const tool = tools.get(step.tool);
      let appId = 'unknown';
      if (tool) {
        const parts = tool.name.split('.');
        if (parts.length >= 1) {
          appId = parts[0] || 'unknown';
        }
      }
      perAppCount[appId] = (perAppCount[appId] ?? 0) + 1;
    }

    if (!receipt.result.ok) {
      // Step failed; stop execution
      break;
    }

    // Check approval gate: if step requires codeowner approval, stop chain
    if (receipt.awaiting_approval) {
      // Approval gate set; stop chain
      break;
    }

    // Store result for next step's cross-references
    if (receipt.result.result !== undefined) {
      previousResults[i] = receipt.result.result;
    }
  }

  return receipts;
}

/**
 * Execute all steps in a template in sequence.
 *
 * @deprecated Use executePlan() with a ParameterizedPlan instead.
 * Returns when the first step fails, or after the last step succeeds.
 * Accumulates previousResults keyed by step index for cross-step references.
 */
export async function executeTemplate(
  template: Template,
  userSlots: Record<string, unknown>,
  tools: ToolRegistry,
  env: Env,
): Promise<StepReceipt[]> {
  const receipts: StepReceipt[] = [];
  const previousResults: Record<number, unknown> = {};

  for (let i = 0; i < (template.steps?.length ?? 0); i++) {
    const receipt = await executeStep(i, template.steps![i], userSlots, previousResults, tools, env);
    receipts.push(receipt);

    if (!receipt.result.ok) {
      // Step failed; stop execution
      break;
    }

    // Store result for next step's cross-references
    if (receipt.result.result !== undefined) {
      previousResults[i] = receipt.result.result;
    }
  }

  return receipts;
}
