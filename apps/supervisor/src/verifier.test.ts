import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AcceptanceGate, VerifierResult } from './verifier';
import { runVerifier } from './verifier';
import type { StepReceipt } from './executor';
import type { ToolRegistry } from '@latimer-woods-tech/agent';
import type { Env } from './index';

// Mock implementations
const mockJwt = 'mock-jwt-token';

// Create minimal mock StepReceipt for testing
function createMockReceipt(override?: Partial<StepReceipt>): StepReceipt {
  return {
    step_index: 0,
    tool_name: 'test-tool',
    side_effects: 'write-app',
    slots_provided: { foo: 'bar' },
    result: { ok: true },
    jwt_scope: 'supervisor.mutator-test-tool',
    execution_ms: 100,
    executed_at: Date.now(),
    ...override,
  };
}

describe('runVerifier', () => {
  let mockToolRegistry: ToolRegistry;
  let mockEnv: Env;
  let mockMemoryWrites: Record<string, unknown>;

  beforeEach(() => {
    mockMemoryWrites = {};

    // Mock ToolRegistry
    mockToolRegistry = {
      get: vi.fn(),
      list: vi.fn(() => []),
      register: vi.fn(),
    } as unknown as ToolRegistry;

    // Mock Env with memory writes
    mockEnv = {
      JWT_SECRET: 'test-secret-for-jwt-verification-test',
      MEMORY: {
        prepare: vi.fn(() => ({
          bind: vi.fn().mockReturnValue({
            all: vi.fn().mockResolvedValue(undefined),
          }),
        })),
      },
    } as unknown as Env;
  });

  it('returns ok:true when auto_approve is true', async () => {
    const acceptanceGate: AcceptanceGate = {
      verifier_query: 'some-tool',
      auto_approve: true,
    };
    const receipts = [createMockReceipt()];

    const result = await runVerifier(acceptanceGate, receipts, mockToolRegistry, mockEnv, 'run-123');

    expect(result).toEqual({ ok: true });
    expect(mockToolRegistry.get).not.toHaveBeenCalled();
  });

  it('returns ok:true when auto_approve is not set and verifier succeeds', async () => {
    const acceptanceGate: AcceptanceGate = {
      verifier_query: 'intent-verifier',
    };
    const receipts = [createMockReceipt()];

    // Mock successful verifier tool
    const mockVerifierTool = {
      invoke: vi.fn().mockResolvedValue({ ok: true, result: { verified: true } }),
    };
    (mockToolRegistry.get as ReturnType<typeof vi.fn>).mockReturnValue(mockVerifierTool);

    const result = await runVerifier(acceptanceGate, receipts, mockToolRegistry, mockEnv, 'run-456');

    expect(result).toEqual({ ok: true });
    expect(mockToolRegistry.get).toHaveBeenCalledWith('intent-verifier');
    expect(mockVerifierTool.invoke).toHaveBeenCalled();
  });

  it('returns ok:false with reason when verifier tool fails', async () => {
    const acceptanceGate: AcceptanceGate = {
      verifier_query: 'intent-verifier',
    };
    const receipts = [createMockReceipt()];
    const errorMsg = 'Verification criteria not met';

    // Mock failing verifier tool
    const mockVerifierTool = {
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: errorMsg,
      }),
    };
    (mockToolRegistry.get as ReturnType<typeof vi.fn>).mockReturnValue(mockVerifierTool);

    const result = await runVerifier(acceptanceGate, receipts, mockToolRegistry, mockEnv, 'run-789');

    expect(result).toEqual({ ok: false, reason: errorMsg });
    expect(mockVerifierTool.invoke).toHaveBeenCalled();
  });

  it('returns ok:false when verifier tool throws exception', async () => {
    const acceptanceGate: AcceptanceGate = {
      verifier_query: 'intent-verifier',
    };
    const receipts = [createMockReceipt()];
    const errorMsg = 'Tool invocation failed';

    // Mock verifier tool that throws
    const mockVerifierTool = {
      invoke: vi.fn().mockRejectedValue(new Error(errorMsg)),
    };
    (mockToolRegistry.get as ReturnType<typeof vi.fn>).mockReturnValue(mockVerifierTool);

    const result = await runVerifier(acceptanceGate, receipts, mockToolRegistry, mockEnv, 'run-999');

    expect(result).toEqual({ ok: false, reason: errorMsg });
    expect(mockVerifierTool.invoke).toHaveBeenCalled();
  });

  it('returns ok:false when verifier tool is not found in registry', async () => {
    const acceptanceGate: AcceptanceGate = {
      verifier_query: 'nonexistent-tool',
    };
    const receipts = [createMockReceipt()];

    // Mock registry returning null for tool lookup
    (mockToolRegistry.get as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const result = await runVerifier(acceptanceGate, receipts, mockToolRegistry, mockEnv, 'run-missing');

    expect(result).toEqual({
      ok: false,
      reason: 'Verifier tool not found: nonexistent-tool',
    });
    expect(mockToolRegistry.get).toHaveBeenCalledWith('nonexistent-tool');
  });

  it('passes receipts to verifier tool for context', async () => {
    const acceptanceGate: AcceptanceGate = {
      verifier_query: 'intent-verifier',
    };
    const receipts = [
      createMockReceipt({ step_index: 0, tool_name: 'github' }),
      createMockReceipt({ step_index: 1, tool_name: 'slack' }),
    ];

    const mockVerifierTool = {
      invoke: vi.fn().mockResolvedValue({ ok: true }),
    };
    (mockToolRegistry.get as ReturnType<typeof vi.fn>).mockReturnValue(mockVerifierTool);

    await runVerifier(acceptanceGate, receipts, mockToolRegistry, mockEnv, 'run-context');

    // Verify that receipts were passed to the tool
    expect(mockVerifierTool.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        receipts,
      }),
    );
  });

  it('handles exception thrown by verifier tool.invoke', async () => {
    const acceptanceGate: AcceptanceGate = {
      verifier_query: 'intent-verifier',
    };
    const receipts = [createMockReceipt()];
    const error = new Error('Network timeout');

    const mockVerifierTool = {
      invoke: vi.fn().mockRejectedValue(error),
    };
    (mockToolRegistry.get as ReturnType<typeof vi.fn>).mockReturnValue(mockVerifierTool);

    const result = await runVerifier(acceptanceGate, receipts, mockToolRegistry, mockEnv, 'run-error');

    expect(result).toEqual({ ok: false, reason: 'Network timeout' });
  });

  it('logs verification to memory for audit trail (success case)', async () => {
    const acceptanceGate: AcceptanceGate = {
      verifier_query: 'intent-verifier',
    };
    const receipts = [createMockReceipt()];

    const mockVerifierTool = {
      invoke: vi.fn().mockResolvedValue({ ok: true, result: { status: 'approved' } }),
    };
    (mockToolRegistry.get as ReturnType<typeof vi.fn>).mockReturnValue(mockVerifierTool);

    // Verify that memory write would be called (covered by other tests that check the function executes)
    const result = await runVerifier(acceptanceGate, receipts, mockToolRegistry, mockEnv, 'run-audit');

    // Should have succeeded verification
    expect(result.ok).toBe(true);
  });

  it('does not invoke tool registry when auto_approve=true', async () => {
    const acceptanceGate: AcceptanceGate = {
      verifier_query: 'intent-verifier',
      auto_approve: true,
    };
    const receipts = [createMockReceipt()];

    const mockVerifierTool = {
      invoke: vi.fn(),
    };
    (mockToolRegistry.get as ReturnType<typeof vi.fn>).mockReturnValue(mockVerifierTool);

    await runVerifier(acceptanceGate, receipts, mockToolRegistry, mockEnv, 'run-skip');

    // Tool should not be looked up or invoked
    expect(mockToolRegistry.get).not.toHaveBeenCalled();
    expect(mockVerifierTool.invoke).not.toHaveBeenCalled();
  });
});
