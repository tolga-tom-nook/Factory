/**
 * Tests for PR opening integration with factory-cross-repo.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openSupervisorPR, type PROpeningResult } from './pr-opening';
import type { StepReceipt } from './executor';
import { ToolRegistry } from '@latimer-woods-tech/agent';

describe('PR Opening Integration', () => {
  let mockEnv: Record<string, unknown>;
  let tools: ToolRegistry;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockEnv = {
      FACTORY_CROSS_REPO_URL: 'https://factory-cross-repo.example.com',
      FACTORY_CROSS_REPO_TOKEN: 'test-token-123',
    };

    // Mock fetch
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    // Create a minimal tool registry
    tools = new ToolRegistry();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });;

  describe('openSupervisorPR', () => {
    it('should skip PR opening if no mutating steps', async () => {
      const receipts: StepReceipt[] = [
        {
          step_index: 0,
          tool_name: 'selfprime.admin.users.list',
          side_effects: 'none',
          slots_provided: {},
          result: { ok: true, result: [] },
          jwt_scope: 'supervisor.readonly',
          execution_ms: 100,
          executed_at: Date.now(),
        },
      ];

      const result = await openSupervisorPR(
        receipts,
        'test-template',
        'run-123',
        'Test description',
        tools,
        mockEnv as any,
      );

      expect(result.ok).toBe(true);
      expect(result.pr_url).toBeUndefined();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should call factory-cross-repo with correct payload on mutating steps', async () => {
      const receipts: StepReceipt[] = [
        {
          step_index: 0,
          tool_name: 'selfprime.admin.users.suspend',
          side_effects: 'write-app',
          slots_provided: { user_id: 'user-123' },
          result: { ok: true },
          jwt_scope: 'supervisor.mutator-selfprime.admin.users.suspend',
          execution_ms: 150,
          executed_at: Date.now(),
        },
      ];

      const mockResponse = {
        ok: true,
        status: 201,
        json: async () => ({
          ok: true,
          pr_url: 'https://github.com/Latimer-Woods-Tech/HumanDesign/pull/123',
          pr_number: 123,
        }),
      };

      mockFetch.mockResolvedValueOnce(mockResponse as any);

      const result = await openSupervisorPR(
        receipts,
        'test-template',
        'run-123',
        'Test description',
        tools,
        mockEnv as any,
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://factory-cross-repo.example.com/api/supervisor/create-pr',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Authorization': 'Bearer test-token-123',
            'Content-Type': 'application/json',
          },
        }),
      );

      expect(result.ok).toBe(true);
      expect(result.pr_url).toBe('https://github.com/Latimer-Woods-Tech/HumanDesign/pull/123');
      expect(result.pr_number).toBe(123);
    });

    it('should handle factory-cross-repo 4xx/5xx gracefully', async () => {
      const receipts: StepReceipt[] = [
        {
          step_index: 0,
          tool_name: 'capricast.admin.videos.publish',
          side_effects: 'write-external',
          slots_provided: { video_id: 'vid-456' },
          result: { ok: true },
          jwt_scope: 'supervisor.mutator-capricast.admin.videos.publish',
          execution_ms: 200,
          executed_at: Date.now(),
        },
      ];

      const mockErrorResponse = {
        ok: false,
        status: 500,
        json: async () => ({
          ok: false,
          error: 'Internal server error',
        }),
      };

      mockFetch.mockResolvedValueOnce(mockErrorResponse as any);

      const result = await openSupervisorPR(
        receipts,
        'test-template',
        'run-123',
        'Test description',
        tools,
        mockEnv as any,
      );

      // Should not fail the run, just log gracefully
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Internal server error');
      expect(result.pr_url).toBeUndefined();
    });

    it('should handle network errors gracefully', async () => {
      const receipts: StepReceipt[] = [
        {
          step_index: 0,
          tool_name: 'selfprime.admin.roles.update',
          side_effects: 'write-app',
          slots_provided: { role_id: 'role-789' },
          result: { ok: true },
          jwt_scope: 'supervisor.mutator-selfprime.admin.roles.update',
          execution_ms: 120,
          executed_at: Date.now(),
        },
      ];

      mockFetch.mockRejectedValueOnce(new Error('Network timeout'));

      const result = await openSupervisorPR(
        receipts,
        'test-template',
        'run-123',
        'Test description',
        tools,
        mockEnv as any,
      );

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Network timeout');
    });

    it('should handle malformed response gracefully', async () => {
      const receipts: StepReceipt[] = [
        {
          step_index: 0,
          tool_name: 'selfprime.admin.users.suspend',
          side_effects: 'write-app',
          slots_provided: { user_id: 'user-123' },
          result: { ok: true },
          jwt_scope: 'supervisor.mutator-selfprime.admin.users.suspend',
          execution_ms: 100,
          executed_at: Date.now(),
        },
      ];

      const mockBadResponse = {
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('Invalid JSON');
        },
      };

      mockFetch.mockResolvedValueOnce(mockBadResponse as any);

      const result = await openSupervisorPR(
        receipts,
        'test-template',
        'run-123',
        'Test description',
        tools,
        mockEnv as any,
      );

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Invalid JSON');
    });

    it('should handle missing environment variables gracefully', async () => {
      const receipts: StepReceipt[] = [
        {
          step_index: 0,
          tool_name: 'selfprime.admin.users.suspend',
          side_effects: 'write-app',
          slots_provided: {},
          result: { ok: true },
          jwt_scope: 'supervisor.mutator-selfprime.admin.users.suspend',
          execution_ms: 100,
          executed_at: Date.now(),
        },
      ];

      const noConfigEnv = {};

      const result = await openSupervisorPR(
        receipts,
        'test-template',
        'run-123',
        'Test description',
        tools,
        noConfigEnv as any,
      );

      expect(result.ok).toBe(true); // Graceful degradation
      expect(result.pr_url).toBeUndefined();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should deduplicate repos in multi-step runs', async () => {
      const receipts: StepReceipt[] = [
        {
          step_index: 0,
          tool_name: 'selfprime.admin.users.suspend',
          side_effects: 'write-app',
          slots_provided: { user_id: 'user-123' },
          result: { ok: true },
          jwt_scope: 'supervisor.mutator-selfprime.admin.users.suspend',
          execution_ms: 100,
          executed_at: Date.now(),
        },
        {
          step_index: 1,
          tool_name: 'selfprime.admin.roles.update',
          side_effects: 'write-app',
          slots_provided: { role_id: 'role-456' },
          result: { ok: true },
          jwt_scope: 'supervisor.mutator-selfprime.admin.roles.update',
          execution_ms: 120,
          executed_at: Date.now(),
        },
      ];

      const mockResponse = {
        ok: true,
        status: 201,
        json: async () => ({
          ok: true,
          pr_url: 'https://github.com/Latimer-Woods-Tech/HumanDesign/pull/124',
          pr_number: 124,
        }),
      };

      mockFetch.mockResolvedValueOnce(mockResponse as any);

      const result = await openSupervisorPR(
        receipts,
        'test-template',
        'run-123',
        'Test description',
        tools,
        mockEnv as any,
      );

      // Verify that the request body contains only one affected_repos entry for selfprime
      const callArgs = mockFetch.mock.calls[0];
      if (!callArgs) {
        throw new Error('Expected mockFetch to be called');
      }
      const bodyStr = callArgs[1]?.body as string;
      const bodyObj = JSON.parse(bodyStr);

      expect(bodyObj.affected_repos).toHaveLength(1);
      expect(bodyObj.affected_repos[0].app_id).toBe('selfprime');
    });

    it('should handle multi-repo runs', async () => {
      const receipts: StepReceipt[] = [
        {
          step_index: 0,
          tool_name: 'selfprime.admin.users.suspend',
          side_effects: 'write-app',
          slots_provided: { user_id: 'user-123' },
          result: { ok: true },
          jwt_scope: 'supervisor.mutator-selfprime.admin.users.suspend',
          execution_ms: 100,
          executed_at: Date.now(),
        },
        {
          step_index: 1,
          tool_name: 'capricast.admin.videos.publish',
          side_effects: 'write-external',
          slots_provided: { video_id: 'vid-456' },
          result: { ok: true },
          jwt_scope: 'supervisor.mutator-capricast.admin.videos.publish',
          execution_ms: 150,
          executed_at: Date.now(),
        },
      ];

      const mockResponse = {
        ok: true,
        status: 201,
        json: async () => ({
          ok: true,
          pr_url: 'https://github.com/Latimer-Woods-Tech/HumanDesign/pull/125',
          pr_number: 125,
        }),
      };

      mockFetch.mockResolvedValueOnce(mockResponse as any);

      const result = await openSupervisorPR(
        receipts,
        'test-template',
        'run-123',
        'Test description',
        tools,
        mockEnv as any,
      );

      // Verify that the request includes both repos
      const callArgs = mockFetch.mock.calls[0];
      if (!callArgs) {
        throw new Error('Expected mockFetch to be called');
      }
      const bodyStr = callArgs[1]?.body as string;
      const bodyObj = JSON.parse(bodyStr);

      expect(bodyObj.affected_repos).toHaveLength(2);
      expect(bodyObj.affected_repos.map((r: any) => r.app_id).sort()).toEqual(['capricast', 'selfprime']);

      expect(result.ok).toBe(true);
    });

    it('should handle unknown app_id gracefully', async () => {
      const receipts: StepReceipt[] = [
        {
          step_index: 0,
          tool_name: 'unknown_app.admin.something',
          side_effects: 'write-app',
          slots_provided: {},
          result: { ok: true },
          jwt_scope: 'supervisor.mutator-unknown_app.admin.something',
          execution_ms: 100,
          executed_at: Date.now(),
        },
      ];

      const result = await openSupervisorPR(
        receipts,
        'test-template',
        'run-123',
        'Test description',
        tools,
        mockEnv as any,
      );

      // Should return ok: true but no PR URL (graceful degradation)
      expect(result.ok).toBe(true);
      expect(result.pr_url).toBeUndefined();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should handle success response without pr_url', async () => {
      const receipts: StepReceipt[] = [
        {
          step_index: 0,
          tool_name: 'selfprime.admin.users.suspend',
          side_effects: 'write-app',
          slots_provided: {},
          result: { ok: true },
          jwt_scope: 'supervisor.mutator-selfprime.admin.users.suspend',
          execution_ms: 100,
          executed_at: Date.now(),
        },
      ];

      const mockResponse = {
        ok: true,
        status: 201,
        json: async () => ({
          ok: true,
          // No pr_url returned
        }),
      };

      mockFetch.mockResolvedValueOnce(mockResponse as any);

      const result = await openSupervisorPR(
        receipts,
        'test-template',
        'run-123',
        'Test description',
        tools,
        mockEnv as any,
      );

      // Should still return ok: true even if pr_url is missing
      expect(result.ok).toBe(true);
      expect(result.pr_url).toBeUndefined();
    });

    it('should truncate description to 200 chars', async () => {
      const receipts: StepReceipt[] = [
        {
          step_index: 0,
          tool_name: 'selfprime.admin.users.suspend',
          side_effects: 'write-app',
          slots_provided: {},
          result: { ok: true },
          jwt_scope: 'supervisor.mutator-selfprime.admin.users.suspend',
          execution_ms: 100,
          executed_at: Date.now(),
        },
      ];

      const longDescription = 'A'.repeat(300);

      const mockResponse = {
        ok: true,
        status: 201,
        json: async () => ({
          ok: true,
          pr_url: 'https://github.com/Latimer-Woods-Tech/HumanDesign/pull/126',
          pr_number: 126,
        }),
      };

      mockFetch.mockResolvedValueOnce(mockResponse as any);

      await openSupervisorPR(
        receipts,
        'test-template',
        'run-123',
        longDescription,
        tools,
        mockEnv as any,
      );

      const callArgs = mockFetch.mock.calls[0];
      if (!callArgs) {
        throw new Error('Expected mockFetch to be called');
      }
      const bodyStr = callArgs[1]?.body as string;
      const bodyObj = JSON.parse(bodyStr);

      expect(bodyObj.description.length).toBeLessThanOrEqual(200);
    });
  });
});
