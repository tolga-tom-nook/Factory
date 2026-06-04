/**
 * Verifier step flow — post-execution verification before logging receipts.
 *
 * After a template's all steps succeed, supervisor invokes an optional verifier tool
 * with readonly scope to confirm that the mutations meet acceptance criteria.
 *
 * If verification fails, the run is marked as "failed_verification" and receipts
 * are NOT logged to the database. This prevents audit trails from containing
 * un-verified or unacceptable mutations.
 */

import type { Env } from './index';
import type { ToolRegistry } from '@latimer-woods-tech/agent';
import type { StepReceipt } from './executor';
import { mintReadonlyJwt } from './auth';
import { writeMemory } from './memory/d1';

/**
 * Acceptance gate configuration (from template).
 */
export interface AcceptanceGate {
  /** Tool name to invoke for verification (readonly scope) */
  verifier_query: string;
  /** If true, skip verifier call and mark as verified */
  auto_approve?: boolean;
}

/**
 * Verifier result.
 */
export interface VerifierResult {
  ok: boolean;
  reason?: string;
}

/**
 * Run a post-execution verifier to confirm acceptance criteria.
 *
 * If auto_approve is true, verification passes immediately.
 * Otherwise, invokes the verifier tool with readonly JWT scope
 * and returns the result. The verifier tool receives the list of
 * receipts from the execution step as context.
 *
 * Verifier result is logged to supervisor_verifications table regardless
 * of pass/fail (for audit trail).
 *
 * @param acceptanceGate Configuration from template.acceptance_gate
 * @param receipts Receipts from executePlan (read for context)
 * @param tools Tool registry for verifier lookup
 * @param env Environment (JWT_SECRET, MEMORY for D1)
 * @param runId Run ID for logging
 * @returns Verification result with ok and optional reason
 */
export async function runVerifier(
  acceptanceGate: AcceptanceGate,
  receipts: StepReceipt[],
  tools: ToolRegistry,
  env: Env,
  runId: string,
): Promise<VerifierResult> {
  // If auto_approve is set, skip verifier and mark verified.
  if (acceptanceGate.auto_approve === true) {
    const verificationId = `${runId}-auto-approve`;
    await writeMemory(env.MEMORY, `verification:${verificationId}`, {
      run_id: runId,
      verifier_query: acceptanceGate.verifier_query,
      auto_approve: true,
      verified_at: Date.now(),
    }).catch(() => {
      /* memory writes are non-blocking */
    });
    return { ok: true };
  }

  const verifierToolName = acceptanceGate.verifier_query;
  const verifierTool = tools.get(verifierToolName);

  if (!verifierTool) {
    const reason = `Verifier tool not found: ${verifierToolName}`;
    const verificationId = `${runId}-not-found`;
    await writeMemory(env.MEMORY, `verification:${verificationId}`, {
      run_id: runId,
      verifier_query: verifierToolName,
      error: reason,
      verified_at: Date.now(),
    }).catch(() => {
      /* memory writes are non-blocking */
    });
    return { ok: false, reason };
  }

  // Mint readonly JWT for verifier scope
  const jwt = await mintReadonlyJwt(env.JWT_SECRET);

  // Invoke verifier tool with receipts as context
  let verifierResult: { ok: boolean; result?: unknown; error?: string };
  try {
    verifierResult = await verifierTool.invoke({
      receipts,
      jwt, // Pass JWT for tool authentication
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const verificationId = `${runId}-exception`;
    await writeMemory(env.MEMORY, `verification:${verificationId}`, {
      run_id: runId,
      verifier_query: verifierToolName,
      error,
      verified_at: Date.now(),
    }).catch(() => {
      /* memory writes are non-blocking */
    });
    return { ok: false, reason: error };
  }

  // Log verification result to D1 (via memory/D1 write)
  const verificationId = `${runId}-verification`;
  await writeMemory(env.MEMORY, `verification:${verificationId}`, {
    run_id: runId,
    verifier_query: verifierToolName,
    tool_response: verifierResult,
    verified_at: Date.now(),
  }).catch(() => {
    /* memory writes are non-blocking */
  });

  return {
    ok: verifierResult.ok === true,
    reason: verifierResult.error,
  };
}
