import { describe, expect, it, vi } from 'vitest';
import { SupervisorDO } from './supervisor.do';
import type { Env } from './index';

function makeEnv(): Env {
  return {
    SUPERVISOR: {} as DurableObjectNamespace,
    LOCK: {} as DurableObjectNamespace,
    MEMORY: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(null),
        }),
      }),
    } as unknown as D1Database,
    LLM_LEDGER: {} as D1Database,
    AI_GATEWAY_BASE_URL: 'https://gateway.example.test',
    ANTHROPIC_API_KEY: 'test-anthropic',
    GROQ_API_KEY: 'test-groq',
    VERTEX_ACCESS_TOKEN: 'test-vertex',
    VERTEX_PROJECT: 'factory-495015',
    VERTEX_LOCATION: 'us-central1',
    PER_RUN_CAP_CENTS: '500',
    JWT_SECRET: 'test-jwt-secret',
    FACTORY_APP_ID: '123456',
    FACTORY_APP_PRIVATE_KEY: ['-----BEGIN PRIVATE KEY-----', 'test', '-----END PRIVATE KEY-----'].join('\n'),
    FACTORY_APP_INSTALLATION_ID: '789012',
    PUSHOVER_TOKEN: 'test-pushover',
    PUSHOVER_USER_KEY: 'test-user',
    SLACK_SIGNING_SECRET: 'test-slack-secret',
    SLACK_OWNER_USER_ID: 'U123',
  };
}

describe('SupervisorDO readonly smoke', () => {
  it('invokes only local no-side-effect tools', async () => {
    const supervisor = new SupervisorDO({} as DurableObjectState, makeEnv());

    const response = await supervisor.fetch(new Request('https://supervisor/tools/read-only-smoke'));
    const body = await response.json() as {
      ok: boolean;
      tools_invoked: number;
      invoked: Array<{ name: string; side_effects: string; ok: boolean }>;
      write_capable_tools: string[];
      registered: { tool_names: string[] };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.tools_invoked).toBe(4);
    expect(body.invoked.map((tool) => tool.name)).toEqual([
      'supervisor.health.snapshot',
      'registry.capabilities.list',
      'template.list',
      'state.lastRun.read',
    ]);
    expect(body.invoked.every((tool) => tool.side_effects === 'none' && tool.ok)).toBe(true);
    expect(body.registered.tool_names).toContain('github.issue.searchApproved');
    expect(body.write_capable_tools).toEqual([]);
  });
});
