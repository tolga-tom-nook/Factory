/**
 * Test fixtures: 5 templates covering all 4 gaps
 * Used by Teams A, B, C, D for testing mutation caps, approval gates, verifier, and PR opening
 */

import type { Template } from '../planner/load';
import type { Tool } from '@latimer-woods-tech/agent';
import { ToolRegistry } from '@latimer-woods-tech/agent';

/** Baseline: no gates, all steps succeed */
export const templateSimpleReadonly: Template = {
  id: 'simple-readonly',
  tier: 'green',
  description: 'Read-only query — no gates, no mutations',
  steps: [
    {
      tool: 'github.search',
      slots: { query: 'is:open label:bug' },
      side_effects: 'read-external',
    },
    {
      tool: 'sentry.list-issues',
      slots: { project: 'selfprime', status: 'unresolved' },
      side_effects: 'read-external',
    },
  ],
};

/** Amplification cap test: 26 mutating steps (should fail at step 26) */
export const templateWithAmplificationCap: Template = {
  id: 'with-amplification-cap',
  tier: 'red',
  description: 'Tests mutation cap enforcement (26 steps > 25 limit)',
  steps: Array.from({ length: 26 }, (_, i) => ({
    tool: 'noop-mutator',
    slots: { index: i, action: `mutate-${i}` },
    side_effects: 'write-app' as const,
  })),
};

/** Approval gate test: step 2 blocks execution */
export const templateWithApprovalGate: Template = {
  id: 'with-approval-gate',
  tier: 'red',
  description: 'Step 2 requires codeowner approval; execution should stop',
  steps: [
    {
      tool: 'github.create-branch',
      slots: { repo: 'selfprime', branch: 'test-1' },
      side_effects: 'write-external',
    },
    {
      tool: 'github.create-branch',
      slots: { repo: 'selfprime', branch: 'test-2' },
      side_effects: 'write-external',
      requires_codeowner_approval: true,
    },
    {
      tool: 'github.create-branch',
      slots: { repo: 'selfprime', branch: 'test-3' },
      side_effects: 'write-external',
    },
  ],
};

/** Verifier test: execution succeeds, but verifier fails */
export const templateWithVerifier: Template = {
  id: 'with-verifier',
  tier: 'yellow',
  description: 'Execution succeeds, but verifier fails; run should be marked failed_verification',
  steps: [
    {
      tool: 'noop-readonly',
      slots: { message: 'step1' },
      side_effects: 'none',
    },
  ],
  acceptance_gate: {
    verifier_query: 'intent-verifier-fail-test',
    auto_approve: false,
  },
};

/** End-to-end happy path: 2 mutations, approval gate, verifier passes */
export const templateEndToEnd: Template = {
  id: 'end-to-end',
  tier: 'yellow',
  description: 'Complete flow: 2 mutations, approval on step 0 (first step), verifier passes → PR opens',
  steps: [
    {
      tool: 'github.create-branch',
      slots: { repo: 'selfprime', branch: 'end-to-end-1' },
      side_effects: 'write-external',
      requires_codeowner_approval: true,
    },
    {
      tool: 'github.create-branch',
      slots: { repo: 'selfprime', branch: 'end-to-end-2' },
      side_effects: 'write-external',
    },
  ],
  acceptance_gate: {
    verifier_query: 'intent-verifier-pass-test',
    auto_approve: false,
  },
};

/** All fixtures as array for registration */
export const ALL_FIXTURES: Template[] = [
  templateSimpleReadonly,
  templateWithAmplificationCap,
  templateWithApprovalGate,
  templateWithVerifier,
  templateEndToEnd,
];

/**
 * Mock tool registry for testing
 * Implements full ToolRegistry interface for testing
 *
 * Note: Tools are registered both by their full name and by their test ID.
 * This allows the executor to look up tools using either lookup.
 */
export function createMockToolRegistry(): ToolRegistry {
  const toolDefinitions: Array<{ id: string; tool: Tool }> = [
    {
      id: 'noop-readonly',
      tool: {
        name: 'noop.readonly.test',
        description: 'Readonly test tool',
        side_effects: 'none',
        required_scope: 'supervisor.readonly',
        invoke: async (slots: Record<string, unknown>) => {
          return { ok: true, result: { message: slots.message } };
        },
      },
    },
    {
      id: 'noop-mutator',
      tool: {
        name: 'noop.mutator.test',
        description: 'Mutator test tool',
        side_effects: 'write-app',
        required_scope: 'supervisor.mutator',
        invoke: async (slots: Record<string, unknown>) => {
          return { ok: true, result: { index: slots.index } };
        },
      },
    },
    {
      id: 'github.search',
      tool: {
        name: 'github.search.issue',
        description: 'GitHub search issues',
        side_effects: 'read-external',
        required_scope: 'supervisor.readonly',
        invoke: async (slots: Record<string, unknown>) => {
          return { ok: true, result: { issues: [] } };
        },
      },
    },
    {
      id: 'github.create-branch',
      tool: {
        name: 'github.create-branch.write',
        description: 'Create GitHub branch',
        side_effects: 'write-external',
        required_scope: 'supervisor.mutator',
        invoke: async (slots: Record<string, unknown>) => {
          return { ok: true, result: { branch: slots.branch, created: true } };
        },
      },
    },
    {
      id: 'sentry.list-issues',
      tool: {
        name: 'sentry.list-issues.query',
        description: 'List Sentry issues',
        side_effects: 'read-external',
        required_scope: 'supervisor.readonly',
        invoke: async (slots: Record<string, unknown>) => {
          return { ok: true, result: { issues: [] } };
        },
      },
    },
    {
      id: 'intent-verifier-pass-test',
      tool: {
        name: 'verifier.intent.pass',
        description: 'Verifier that passes',
        side_effects: 'none',
        required_scope: 'supervisor.readonly',
        invoke: async () => {
          return { ok: true, result: { verified: true } };
        },
      },
    },
    {
      id: 'intent-verifier-fail-test',
      tool: {
        name: 'verifier.intent.fail',
        description: 'Verifier that fails',
        side_effects: 'none',
        required_scope: 'supervisor.readonly',
        invoke: async () => {
          return { ok: false, error: 'Verification failed: intent mismatch' };
        },
      },
    },
  ];

  const registry = new ToolRegistry();

  // Register each tool by both its ID and its full name
  for (const { id, tool } of toolDefinitions) {
    registry.register(tool, id);
  }

  return registry;
}

/**
 * Test scenario descriptions for Phase 1–3 validation
 *
 * Phase 1 (now): Fixtures defined
 * Phase 2: Teams A–D implement handlers
 * Phase 3: Run these scenarios via vitest + curl smoke tests
 */
export const SCENARIO_DESCRIPTIONS = {
  scenario1: {
    name: 'Baseline (no gates)',
    template: 'simple-readonly',
    expectedResult: 'Both steps succeed; receipts logged; no PR opened (readonly)',
  },
  scenario2: {
    name: 'Amplification cap exceeded',
    template: 'with-amplification-cap',
    expectedResult: 'Execution stops at step 26; error receipt with "Mutation limit exceeded"',
  },
  scenario3: {
    name: 'Approval gate blocks execution',
    template: 'with-approval-gate',
    expectedResult: 'Step 1 succeeds; step 2 triggers awaiting_approval; chain stops; /approve endpoint resumes',
  },
  scenario4: {
    name: 'Verifier fails',
    template: 'with-verifier',
    expectedResult: 'Execution succeeds; verifier fails; run marked failed_verification; no receipts logged',
  },
  scenario5: {
    name: 'End-to-end happy path',
    template: 'end-to-end',
    expectedResult:
      'Step 1 triggers approval → approve via /approve endpoint → step 1 succeeds → step 2 succeeds → verifier passes → PR opened → all receipts logged',
  },
};
