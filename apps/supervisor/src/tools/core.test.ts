import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@latimer-woods-tech/agent';
import { registerCoreSupervisorTools } from './core';
import type { Env } from '../index';

function makeEnv(): Env {
  return {
    SUPERVISOR: {} as DurableObjectNamespace,
    LOCK: {} as DurableObjectNamespace,
    MEMORY: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(null),
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

describe('registerCoreSupervisorTools', () => {
  it('registers the safe core runtime tool surface', () => {
    const registry = new ToolRegistry();
    registerCoreSupervisorTools(registry, makeEnv());

    const names = registry.list().map((tool) => tool.name).sort();
    expect(names).toEqual([
      'github.addLabel',
      'github.comment',
      'github.issue.searchApproved',
      'github.openPR',
      'github.readFile',
      'registry.capabilities.list',
      'state.lastRun.read',
      'supervisor.health.snapshot',
      'template.list',
    ]);
  });

  it('keeps all core tools off the LLM surface until tool schemas are explicitly approved', () => {
    const registry = new ToolRegistry();
    registerCoreSupervisorTools(registry, makeEnv());

    expect(registry.llmTools()).toEqual([]);
  });

  it('classifies read and guarded write tools explicitly', () => {
    const registry = new ToolRegistry();
    registerCoreSupervisorTools(registry, makeEnv());

    const byName = new Map(registry.list().map((tool) => [tool.name, tool]));
    expect(byName.get('github.issue.searchApproved')?.side_effects).toBe('read-external');
    expect(byName.get('github.readFile')?.side_effects).toBe('read-external');
    expect(byName.get('github.openPR')?.side_effects).toBe('write-external');
    expect(byName.get('github.comment')?.side_effects).toBe('write-external');
    expect(byName.get('github.addLabel')?.side_effects).toBe('write-external');
    expect(byName.get('supervisor.health.snapshot')?.side_effects).toBe('none');
    expect(byName.get('registry.capabilities.list')?.side_effects).toBe('none');
    expect(byName.get('template.list')?.side_effects).toBe('none');
    expect(byName.get('state.lastRun.read')?.side_effects).toBe('none');
  });
});
