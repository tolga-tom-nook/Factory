/**
 * Template loader.
 *
 * Templates are the single source of truth in `docs/supervisor/plans/*.yml`.
 * The build step (`npm run generate:templates`) parses those files with js-yaml
 * and emits `templates.generated.ts` — a committed TypeScript file that the
 * Worker imports at bundle time (no KV, no runtime file I/O).
 *
 * To add or modify a template:
 *   1. Edit or create a YAML file in docs/supervisor/plans/
 *   2. Run: node scripts/generate-supervisor-templates.mjs
 *   3. Commit both the YAML and the updated templates.generated.ts
 *
 * Phase 2 (SUP-3.5): if hot-reload without redeploy is needed, swap the
 * import for a KV fetch.
 */

export interface TemplateTriggers {
  labels_any_of?: string[];
  title_pattern?: string;
  body_patterns?: string[];
}

/**
 * Acceptance gate configuration — post-execution verifier step.
 *
 * When set on a template, after all steps execute successfully the supervisor
 * invokes the named verifier tool (readonly scope) to confirm acceptance
 * criteria. If verification fails the run is marked `failed_verification`
 * and receipts are NOT logged. See `src/verifier.ts` for the runtime.
 */
export interface TemplateAcceptanceGate {
  /** Tool name to invoke for verification (readonly scope). */
  verifier_query: string;
  /** If true, skip verifier call and mark as verified. */
  auto_approve?: boolean;
}

export interface Template {
  id: string;
  tier: 'green' | 'yellow' | 'red';
  description: string;
  trigger_keywords?: string[];
  slot_names?: string[];
  slot_validators?: Record<string, string>;
  slot_defaults?: Record<string, unknown>;
  triggers?: TemplateTriggers;
  steps?: Array<{
    tool: string;
    slots?: Record<string, unknown>;
    side_effects?: 'none' | 'read-external' | 'write-app' | 'write-external';
    /**
     * When true, the executor halts the chain after this step succeeds and
     * sets `awaiting_approval='codeowner_confirmation'` on the receipt.
     * A CODEOWNER must approve via the `/approve` endpoint to resume.
     */
    requires_codeowner_approval?: boolean;
  }>;
  /**
   * Optional list of `docs/architecture/PATTERNS.md` section numbers that
   * THIS template must satisfy when executed. Surfaced in the plan comment
   * so the human approving the plan AND the supervisor's own LLM (which has
   * PATTERNS.md in context via T3.B) explicitly cross-reference them.
   */
  pattern_check?: number[];
  /**
   * Optional post-execution verifier configuration. See {@link TemplateAcceptanceGate}.
   */
  acceptance_gate?: TemplateAcceptanceGate;
}

import { GENERATED_TEMPLATES } from './templates.generated';

export async function loadTemplates(): Promise<Template[]> {
  return Promise.resolve(GENERATED_TEMPLATES);
}
