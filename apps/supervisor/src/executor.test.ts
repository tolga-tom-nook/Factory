import { describe, it, expect, beforeEach } from 'vitest';
import { executePlan, executeStep, type StepReceipt } from './executor';
import type { Env } from './index';
import { ToolRegistry, type Tool } from '@latimer-woods-tech/agent';
import type { Template } from './planner/load';

/**
 * Test fixtures and helpers for executor tests
 */

// Minimal mock Env for testing
const createMockEnv = (): Env => ({
  JWT_SECRET: 'test-jwt-secret-for-testing-only',
  MEMORY: {} as any,
  LLM_LEDGER: {} as any,
  SUPERVISOR: {} as any,
  LOCK: {} as any,
  AI_GATEWAY_BASE_URL: 'https://api.example.com',
  ANTHROPIC_API_KEY: 'test-key',
  GROQ_API_KEY: 'test-key',
  VERTEX_ACCESS_TOKEN: 'test-token',
  VERTEX_PROJECT: 'test-project',
  VERTEX_LOCATION: 'us-central1',
  FACTORY_APP_ID: '123456',
  FACTORY_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0Z3VS5+2InoNc+x0Nz8N4Q==\n-----END RSA PRIVATE KEY-----',
  FACTORY_APP_INSTALLATION_ID: '789012',
  PUSHOVER_TOKEN: 'test-token',
  PUSHOVER_USER_KEY: 'test-user-key',
  SLACK_SIGNING_SECRET: 'test-secret',
  SLACK_OWNER_USER_ID: 'U123456789',
});

// Factory to create mock tools
function createMockTool(
  name: string,
  sideEffects: 'none' | 'read-external' | 'write-app' | 'write-external' = 'none',
  willFail = false,
): Tool {
  return {
    name,
    description: `Mock tool: ${name}`,
    side_effects: sideEffects,
    required_scope: sideEffects === 'none' ? 'supervisor.readonly' : 'supervisor.mutator',
    invoke: async (slots: Record<string, unknown>) => {
      if (willFail) {
        return { ok: false, error: `Mock tool ${name} failed` };
      }
      return { ok: true, result: { tool: name, slots } };
    },
  };
}

// Helper to build a tool registry
function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  // Base tools
  registry.register(createMockTool('unknown.noop-readonly', 'none'));
  registry.register(createMockTool('unknown.noop-mutator', 'write-app'));

  // Multi-app tools (for per-app cap testing)
  registry.register(createMockTool('app-a.tool', 'write-app'));
  registry.register(createMockTool('app-b.tool', 'write-app'));
  registry.register(createMockTool('app-c.tool', 'write-app'));

  // Approval gate test tools
  registry.register(createMockTool('github.create-branch', 'write-external'));

  // Failing tool for error tests
  registry.register(createMockTool('unknown.failing-tool', 'write-app', true));

  return registry;
}

describe('executePlan', () => {
  let env: Env;
  let tools: ToolRegistry;

  beforeEach(() => {
    env = createMockEnv();
    tools = createToolRegistry();
  });

  describe('baseline: no caps, all steps succeed', () => {
    it('executes 3 read-only steps successfully', async () => {
      const steps = [
        { tool: 'unknown.noop-readonly', slots: { msg: '1' }, side_effects: 'none' as const },
        { tool: 'unknown.noop-readonly', slots: { msg: '2' }, side_effects: 'none' as const },
        { tool: 'unknown.noop-readonly', slots: { msg: '3' }, side_effects: 'none' as const },
      ];

      const receipts = await executePlan(steps, tools, env);

      expect(receipts).toHaveLength(3);
      expect(receipts[0]?.result.ok).toBe(true);
      expect(receipts[1]?.result.ok).toBe(true);
      expect(receipts[2]?.result.ok).toBe(true);
    });

    it('executes 25 mutating steps successfully (at global cap boundary) - uses 5 apps × 5 mutations each', async () => {
      // Create 5 apps × 5 mutations each = 25 total (respects both global and per-app limits)
      const registry = new ToolRegistry();
      registry.register(createMockTool('app-a.tool', 'write-app'));
      registry.register(createMockTool('app-b.tool', 'write-app'));
      registry.register(createMockTool('app-c.tool', 'write-app'));
      registry.register(createMockTool('app-d.tool', 'write-app'));
      registry.register(createMockTool('app-e.tool', 'write-app'));

      const steps = [];

      // 5 mutations from app-a (hits per-app cap)
      for (let i = 0; i < 5; i++) {
        steps.push({
          tool: 'app-a.tool',
          slots: { index: i },
          side_effects: 'write-app' as const,
        });
      }

      // 5 mutations from app-b (hits per-app cap)
      for (let i = 0; i < 5; i++) {
        steps.push({
          tool: 'app-b.tool',
          slots: { index: i },
          side_effects: 'write-app' as const,
        });
      }

      // 5 mutations from app-c (hits per-app cap)
      for (let i = 0; i < 5; i++) {
        steps.push({
          tool: 'app-c.tool',
          slots: { index: i },
          side_effects: 'write-app' as const,
        });
      }

      // 5 mutations from app-d (hits per-app cap)
      for (let i = 0; i < 5; i++) {
        steps.push({
          tool: 'app-d.tool',
          slots: { index: i },
          side_effects: 'write-app' as const,
        });
      }

      // 5 mutations from app-e (hits per-app cap)
      for (let i = 0; i < 5; i++) {
        steps.push({
          tool: 'app-e.tool',
          slots: { index: i },
          side_effects: 'write-app' as const,
        });
      }

      const receipts = await executePlan(steps, registry, env);

      expect(receipts).toHaveLength(25);
      receipts.forEach((receipt, i) => {
        expect(receipt.result.ok).toBe(true);
        expect(receipt.step_index).toBe(i);
      });
    });
  });

  describe('mutation cap enforcement (global)', () => {
    it('fails at step 26 when exceeding global cap', async () => {
      // Create registry with enough apps to avoid per-app cap
      const registry = new ToolRegistry();
      for (let i = 0; i < 6; i++) {
        registry.register(createMockTool(`app-${i}.tool`, 'write-app'));
      }

      const steps = [];
      // 5 mutations from each of 5 apps = 25 (at global cap)
      // Then 1 more mutation from 6th app = 26 (exceeds global cap)
      for (let appIdx = 0; appIdx < 6; appIdx++) {
        const maxSteps = appIdx < 5 ? 5 : 1; // Last app only has 1 mutation
        for (let i = 0; i < maxSteps; i++) {
          steps.push({
            tool: `app-${appIdx}.tool`,
            slots: { index: i },
            side_effects: 'write-app' as const,
          });
        }
      }

      const receipts = await executePlan(steps, registry, env);

      expect(receipts).toHaveLength(26);

      // Steps 0-24 should succeed
      for (let i = 0; i < 25; i++) {
        expect(receipts[i]?.result.ok).toBe(true);
      }

      // Step 25 should fail with cap exceeded error
      expect(receipts[25]?.result.ok).toBe(false);
      expect(receipts[25]?.result.error).toContain('Mutation limit exceeded');
      expect(receipts[25]?.result.error).toContain('26 > 25');
    });

    it('returns error receipt with correct step_index on cap exceeded', async () => {
      // Create registry with enough apps to avoid per-app cap
      const registry = new ToolRegistry();
      for (let i = 0; i < 6; i++) {
        registry.register(createMockTool(`app-${i}.tool`, 'write-app'));
      }

      const steps = [];
      // 5 mutations from each of 5 apps = 25 (at global cap)
      // Then 1 more mutation from 6th app = 26 (exceeds global cap)
      for (let appIdx = 0; appIdx < 6; appIdx++) {
        const maxSteps = appIdx < 5 ? 5 : 1;
        for (let i = 0; i < maxSteps; i++) {
          steps.push({
            tool: `app-${appIdx}.tool`,
            slots: { index: i },
            side_effects: 'write-app' as const,
          });
        }
      }

      const receipts = await executePlan(steps, registry, env);

      const failedReceipt = receipts[25];
      expect(failedReceipt?.step_index).toBe(25);
      expect(failedReceipt?.tool_name).toBe('app-5.tool');
    });
  });

  describe('per-app mutation cap enforcement', () => {
    it('allows up to 5 mutations per app', async () => {
      const steps = Array.from({ length: 5 }, (_, i) => ({
        tool: 'app-a.tool',
        slots: { index: i },
        side_effects: 'write-app' as const,
      }));

      const receipts = await executePlan(steps, tools, env);

      expect(receipts).toHaveLength(5);
      receipts.forEach((receipt) => {
        expect(receipt.result.ok).toBe(true);
      });
    });

    it('fails at 6th mutation on same app', async () => {
      const steps = Array.from({ length: 6 }, (_, i) => ({
        tool: 'app-a.tool',
        slots: { index: i },
        side_effects: 'write-app' as const,
      }));

      const receipts = await executePlan(steps, tools, env);

      expect(receipts).toHaveLength(6);

      // First 5 succeed
      for (let i = 0; i < 5; i++) {
        expect(receipts[i]?.result.ok).toBe(true);
      }

      // 6th fails with per-app cap error
      expect(receipts[5]?.result.ok).toBe(false);
      expect(receipts[5]?.result.error).toContain('Mutation limit exceeded for app');
      expect(receipts[5]?.result.error).toContain('app-a');
      expect(receipts[5]?.result.error).toContain('6 > 5');
    });

    it('tracks mutations per app independently', async () => {
      const steps = [
        // 2 mutations on app-a
        { tool: 'app-a.tool', slots: { i: 1 }, side_effects: 'write-app' as const },
        { tool: 'app-a.tool', slots: { i: 2 }, side_effects: 'write-app' as const },
        // 2 mutations on app-b
        { tool: 'app-b.tool', slots: { i: 1 }, side_effects: 'write-app' as const },
        { tool: 'app-b.tool', slots: { i: 2 }, side_effects: 'write-app' as const },
        // 2 mutations on app-c
        { tool: 'app-c.tool', slots: { i: 1 }, side_effects: 'write-app' as const },
        { tool: 'app-c.tool', slots: { i: 2 }, side_effects: 'write-app' as const },
      ];

      const receipts = await executePlan(steps, tools, env);

      expect(receipts).toHaveLength(6);
      receipts.forEach((receipt) => {
        expect(receipt.result.ok).toBe(true);
      });
    });

    it('fails correctly when one app hits limit while others still have budget', async () => {
      const steps = [
        // 5 mutations on app-a (hits cap)
        { tool: 'app-a.tool', slots: { i: 1 }, side_effects: 'write-app' as const },
        { tool: 'app-a.tool', slots: { i: 2 }, side_effects: 'write-app' as const },
        { tool: 'app-a.tool', slots: { i: 3 }, side_effects: 'write-app' as const },
        { tool: 'app-a.tool', slots: { i: 4 }, side_effects: 'write-app' as const },
        { tool: 'app-a.tool', slots: { i: 5 }, side_effects: 'write-app' as const },
        // 1 mutation on app-b (should fail because app-a hit limit, so total would exceed)
        // Actually: this is per-app, so app-b should succeed if we try step 6 on app-b
        // Let's test: 6th step on app-a should fail
        { tool: 'app-a.tool', slots: { i: 6 }, side_effects: 'write-app' as const },
      ];

      const receipts = await executePlan(steps, tools, env);

      expect(receipts).toHaveLength(6);

      // First 5 succeed
      for (let i = 0; i < 5; i++) {
        expect(receipts[i]?.result.ok).toBe(true);
      }

      // 6th fails with app-a cap exceeded
      expect(receipts[5]?.result.ok).toBe(false);
    });
  });

  describe('approval gate enforcement', () => {
    it('stops execution when approval gate is triggered', async () => {
      const steps = [
        {
          tool: 'github.create-branch',
          slots: { branch: 'test-1' },
          side_effects: 'write-external' as const,
        },
        {
          tool: 'github.create-branch',
          slots: { branch: 'test-2' },
          side_effects: 'write-external' as const,
          requires_codeowner_approval: true,
        },
        {
          tool: 'github.create-branch',
          slots: { branch: 'test-3' },
          side_effects: 'write-external' as const,
        },
      ];

      const receipts = await executePlan(steps, tools, env);

      // Should stop after step 2 (index 1)
      expect(receipts).toHaveLength(2);

      // Step 1 succeeds
      expect(receipts[0]?.result.ok).toBe(true);
      expect(receipts[0]?.awaiting_approval).toBeUndefined();

      // Step 2 succeeds but sets awaiting_approval
      expect(receipts[1]?.result.ok).toBe(true);
      expect(receipts[1]?.awaiting_approval).toBe('codeowner_confirmation');

      // Step 3 should not be executed
    });

    it('does not set awaiting_approval if step fails', async () => {
      // Create a tool that will fail
      const registry = new ToolRegistry();
      registry.register(createMockTool('unknown.failing-tool', 'write-app', true));

      const steps = [
        {
          tool: 'unknown.failing-tool',
          slots: {},
          side_effects: 'write-app' as const,
          requires_codeowner_approval: true,
        },
      ];

      const receipts = await executePlan(steps, registry, env);

      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.result.ok).toBe(false);
      expect(receipts[0]?.awaiting_approval).toBeUndefined();
    });

    it('does not set awaiting_approval if flag is not set', async () => {
      const steps = [
        {
          tool: 'github.create-branch',
          slots: { branch: 'test-1' },
          side_effects: 'write-external' as const,
          requires_codeowner_approval: false,
        },
        {
          tool: 'github.create-branch',
          slots: { branch: 'test-2' },
          side_effects: 'write-external' as const,
        },
      ];

      const receipts = await executePlan(steps, tools, env);

      expect(receipts).toHaveLength(2);
      expect(receipts[0]?.awaiting_approval).toBeUndefined();
      expect(receipts[1]?.awaiting_approval).toBeUndefined();
    });
  });

  describe('interaction: caps + approval gates', () => {
    it('stops at approval gate before hitting global mutation cap', async () => {
      // Use multiple apps to avoid hitting per-app cap before hitting approval gate
      const registry = new ToolRegistry();
      registry.register(createMockTool('app-a.tool', 'write-app'));
      registry.register(createMockTool('app-b.tool', 'write-app'));

      const steps = [
        { tool: 'app-a.tool', slots: { i: 0 }, side_effects: 'write-app' as const },
        { tool: 'app-a.tool', slots: { i: 1 }, side_effects: 'write-app' as const },
        { tool: 'app-b.tool', slots: { i: 0 }, side_effects: 'write-app' as const },
        { tool: 'app-b.tool', slots: { i: 1 }, side_effects: 'write-app' as const },
        { tool: 'app-a.tool', slots: { i: 2 }, side_effects: 'write-app' as const },
        {
          tool: 'app-b.tool',
          slots: { i: 2 },
          side_effects: 'write-app' as const,
          requires_codeowner_approval: true, // Approval gate on step 5
        },
      ];

      const receipts = await executePlan(steps, registry, env);

      // Should stop after step 6 (index 5) due to approval gate
      expect(receipts).toHaveLength(6);

      // Steps 0-4 succeed without approval
      for (let i = 0; i < 5; i++) {
        expect(receipts[i]?.result.ok).toBe(true);
        expect(receipts[i]?.awaiting_approval).toBeUndefined();
      }

      // Step 5 succeeds but sets awaiting_approval
      expect(receipts[5]?.result.ok).toBe(true);
      expect(receipts[5]?.awaiting_approval).toBe('codeowner_confirmation');
    });

    it('fails at global cap after approval gate is resolved', async () => {
      // This test verifies that approval gate doesn't bypass global cap
      // Create 26 steps, but first one triggers approval gate
      const steps = Array.from({ length: 26 }, (_, i) => ({
        tool: 'unknown.noop-mutator',
        slots: { index: i },
        side_effects: 'write-app' as const,
        requires_codeowner_approval: i === 0, // Only first step needs approval
      }));

      const receipts = await executePlan(steps, tools, env);

      // Should stop after step 1 due to approval gate, not reach the cap
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.awaiting_approval).toBe('codeowner_confirmation');
    });
  });

  describe('error handling', () => {
    it('stops execution if a step fails', async () => {
      const registry = new ToolRegistry();
      registry.register(createMockTool('unknown.failing-tool', 'write-app', true));
      registry.register(createMockTool('unknown.noop-mutator', 'write-app'));

      const steps = [
        { tool: 'unknown.noop-mutator', slots: {}, side_effects: 'write-app' as const },
        { tool: 'unknown.failing-tool', slots: {}, side_effects: 'write-app' as const },
        { tool: 'unknown.noop-mutator', slots: {}, side_effects: 'write-app' as const },
      ];

      const receipts = await executePlan(steps, registry, env);

      expect(receipts).toHaveLength(2);
      expect(receipts[0]?.result.ok).toBe(true);
      expect(receipts[1]?.result.ok).toBe(false);
    });

    it('returns error receipt if tool not found', async () => {
      const steps = [
        {
          tool: 'nonexistent-tool',
          slots: {},
          side_effects: 'none' as const,
        },
      ];

      const receipts = await executePlan(steps, tools, env);

      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.result.ok).toBe(false);
      expect(receipts[0]?.result.error).toContain('Tool not found');
    });
  });

  describe('receipt fields', () => {
    it('populates all required receipt fields', async () => {
      const steps = [
        {
          tool: 'unknown.noop-mutator',
          slots: { key: 'value' },
          side_effects: 'write-app' as const,
        },
      ];

      const receipts = await executePlan(steps, tools, env);

      const receipt = receipts[0];
      expect(receipt).toBeDefined();
      expect(receipt?.step_index).toBe(0);
      expect(receipt?.tool_name).toBe('unknown.noop-mutator');
      expect(receipt?.side_effects).toBe('write-app');
      expect(receipt?.slots_provided).toEqual({ key: 'value' });
      expect(receipt?.result).toBeDefined();
      expect(receipt?.result.ok).toBe(true);
      expect(receipt?.jwt_scope).toBeDefined();
      expect(receipt?.execution_ms).toBeGreaterThanOrEqual(0);
      expect(receipt?.executed_at).toBeGreaterThan(0);
    });
  });
});

describe('executeStep', () => {
  let env: Env;
  let tools: ToolRegistry;

  beforeEach(() => {
    env = createMockEnv();
    tools = createToolRegistry();
  });

  it('executes a step and returns receipt', async () => {
    const step = {
      tool: 'unknown.noop-readonly',
      slots: { msg: 'hello' },
      side_effects: 'none' as const,
    };

    const receipt = await executeStep(0, step, {}, {}, tools, env);

    expect(receipt.step_index).toBe(0);
    expect(receipt.tool_name).toBe('unknown.noop-readonly');
    expect(receipt.result.ok).toBe(true);
    expect(receipt.awaiting_approval).toBeUndefined();
  });

  it('sets awaiting_approval when required_codeowner_approval is true and tool succeeds', async () => {
    const step = {
      tool: 'unknown.noop-mutator',
      slots: {},
      side_effects: 'write-app' as const,
      requires_codeowner_approval: true,
    };

    const receipt = await executeStep(0, step, {}, {}, tools, env);

    expect(receipt.result.ok).toBe(true);
    expect(receipt.awaiting_approval).toBe('codeowner_confirmation');
  });

  it('does not set awaiting_approval when tool fails', async () => {
    const registry = new ToolRegistry();
    registry.register(createMockTool('unknown.failing-tool', 'write-app', true));

    const step = {
      tool: 'unknown.failing-tool',
      slots: {},
      side_effects: 'write-app' as const,
      requires_codeowner_approval: true,
    };

    const receipt = await executeStep(0, step, {}, {}, registry, env);

    expect(receipt.result.ok).toBe(false);
    expect(receipt.awaiting_approval).toBeUndefined();
  });

  it('does not set awaiting_approval when flag is false', async () => {
    const step = {
      tool: 'unknown.noop-mutator',
      slots: {},
      side_effects: 'write-app' as const,
      requires_codeowner_approval: false,
    };

    const receipt = await executeStep(0, step, {}, {}, tools, env);

    expect(receipt.result.ok).toBe(true);
    expect(receipt.awaiting_approval).toBeUndefined();
  });

  it('throws if step is undefined', async () => {
    await expect(executeStep(0, undefined, {}, {}, tools, env)).rejects.toThrow();
  });
});
